import prisma from '@homglai/db';
import axios from 'axios';
import { z } from 'zod';
import { normalizePhone } from '../utils/phone';
import { AppError } from '../utils/app-error';
import { RepairService } from './repair.service';
import { getAppConfig } from '../config/env';

/** Thai reply when customers press approve/reject while LINE approval is switched off (SRS 1.3, 3.5). */
export const LINE_APPROVAL_DISABLED_REPLY =
  'ขณะนี้ร้านยังไม่เปิดให้อนุมัติราคาผ่าน LINE กรุณารอร้านติดต่อกลับเพื่อยืนยันราคาทางโทรศัพท์ ขอบคุณครับ';

export type ResolvePostbackOutcome = 'disabled' | 'not_found' | 'forbidden' | 'resolved' | 'conflict' | 'error';

const postbackDataSchema = z.object({
  action: z.literal('resolve_item'),
  orderId: z.coerce.number().int().positive(),
  itemId: z.coerce.number().int().positive(),
  status: z.enum(['APPROVED', 'REJECTED']),
});

export class LineWebhookService {
  static async sendReply(replyToken: string, text: string): Promise<void> {
    const channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    if (!channelAccessToken) {
      console.warn('[LINE] LINE_CHANNEL_ACCESS_TOKEN not configured. Skipping reply message.');
      return;
    }

    if (!replyToken) return;

    try {
      await axios.post(
        'https://api.line.me/v2/bot/message/reply',
        {
          replyToken,
          messages: [{ type: 'text', text }],
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${channelAccessToken}`,
          },
          timeout: 5000,
        }
      );
    } catch (error: any) {
      console.error('[LINE Reply API Error]:', error.response?.data || error.message);
    }
  }

  static async sendPush(lineUserId: string, messages: any[]): Promise<void> {
    const channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    if (!channelAccessToken) {
      console.warn('[LINE] LINE_CHANNEL_ACCESS_TOKEN not configured. Skipping push message.');
      return;
    }

    if (!lineUserId) return;

    try {
      await axios.post(
        'https://api.line.me/v2/bot/message/push',
        {
          to: lineUserId,
          messages,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${channelAccessToken}`,
          },
          timeout: 5000,
        }
      );
    } catch (error: any) {
      console.error('[LINE Push API Error]:', error.response?.data || error.message);
    }
  }

  /**
   * Quotation push with approve/reject buttons. Only sent when CUSTOMER_LINE_APPROVAL_ENABLED=true
   * (phase 1 of the shop confirms prices by phone). Returns what happened, for logging/tests.
   */
  static async notifyCustomerNewItem(
    repairOrderId: number,
    item: { id: number; name: string; price: any },
    options: { approvalEnabled?: boolean } = {}
  ): Promise<'disabled' | 'no_line_user' | 'sent' | 'error'> {
    const approvalEnabled = options.approvalEnabled ?? getAppConfig().customerLineApprovalEnabled;
    if (!approvalEnabled) {
      return 'disabled';
    }
    try {
      const order = await prisma.repairOrder.findUnique({
        where: { id: repairOrderId },
        include: { customer: true },
      });

      if (!order?.customer?.lineUserId) return 'no_line_user';

      const templateMessage = {
        type: 'template',
        altText: `ใบเสนอราคาใหม่: ${item.name} (${item.price} บาท) สำหรับใบงาน ${order.jobNumber}`,
        template: {
          type: 'confirm',
          text: `ใบงาน: ${order.jobNumber}\nช่างเสนอรายการซ่อม: ${item.name}\nราคา: ${item.price} บาท\n\nท่านต้องการอนุมัติรายการนี้หรือไม่?`,
          actions: [
            {
              type: 'postback',
              label: 'อนุมัติ (Approve)',
              data: `action=resolve_item&orderId=${order.id}&itemId=${item.id}&status=APPROVED`,
              displayText: `อนุมัติรายการ ${item.name}`,
            },
            {
              type: 'postback',
              label: 'ปฏิเสธ (Reject)',
              data: `action=resolve_item&orderId=${order.id}&itemId=${item.id}&status=REJECTED`,
              displayText: `ปฏิเสธรายการ ${item.name}`,
            },
          ],
        },
      };

      await this.sendPush(order.customer.lineUserId, [templateMessage]);
      return 'sent';
    } catch (err: any) {
      console.error('[LINE Notify New Item Error]:', err.message || err);
      return 'error';
    }
  }

  /**
   * Customer pressed approve/reject in LINE (postback `resolve_item`).
   * Flag off (default): reply that the shop will call to confirm the price — nothing is changed.
   * Flag on: original behaviour (owner check), recorded with resolutionChannel = LINE, resolvedById = null.
   */
  static async handleResolveItemPostback(
    params: { orderId: number; itemId: number; status: 'APPROVED' | 'REJECTED'; lineUserId: string; replyToken: string },
    options: { approvalEnabled?: boolean } = {}
  ): Promise<ResolvePostbackOutcome> {
    const approvalEnabled = options.approvalEnabled ?? getAppConfig().customerLineApprovalEnabled;
    const { orderId, itemId, status, lineUserId, replyToken } = params;

    if (!approvalEnabled) {
      await this.sendReply(replyToken, LINE_APPROVAL_DISABLED_REPLY);
      return 'disabled';
    }

    const order = await prisma.repairOrder.findUnique({
      where: { id: orderId },
      include: { customer: true },
    });

    if (!order) {
      await this.sendReply(replyToken, 'ไม่พบข้อมูลใบสั่งซ่อม');
      return 'not_found';
    }

    // Check ownership
    if (!order.customer.lineUserId || order.customer.lineUserId !== lineUserId) {
      await this.sendReply(
        replyToken,
        'ท่านไม่มีสิทธิ์ดำเนินการ เนื่องจากบัญชี LINE ไม่ตรงกับเจ้าของงานซ่อม'
      );
      return 'forbidden';
    }

    try {
      await RepairService.resolveRepairItem(orderId, itemId, status, { channel: 'LINE', actor: null });
      const actionText = status === 'APPROVED' ? 'อนุมัติ' : 'ปฏิเสธ';
      await this.sendReply(
        replyToken,
        `บันทึกผลการ${actionText}รายการสำหรับใบงาน ${order.jobNumber} เรียบร้อยแล้ว`
      );
      return 'resolved';
    } catch (err: any) {
      if (err instanceof AppError && err.statusCode === 409) {
        await this.sendReply(
          replyToken,
          'รายการนี้ได้รับการพิจารณาไปแล้ว หรือไม่สามารถดำเนินการได้ในขณะนี้'
        );
        return 'conflict';
      }
      await this.sendReply(
        replyToken,
        'เกิดข้อผิดพลาดในการบันทึกข้อมูล กรุณาลองใหม่อีกครั้งหรือติดต่อทางร้าน'
      );
      return 'error';
    }
  }

  static async notifyCustomerStatusChange(
    repairOrderId: number,
    status: 'COMPLETED' | 'DELIVERED',
    options: { outcome?: 'REPAIRED' | 'NOT_REPAIRED' } = {}
  ): Promise<void> {
    try {
      const order = await prisma.repairOrder.findUnique({
        where: { id: repairOrderId },
        include: { customer: true, machine: true },
      });

      if (!order?.customer?.lineUserId) return;

      let notificationText = '';
      if (status === 'COMPLETED' && options.outcome === 'NOT_REPAIRED') {
        notificationText = `แจ้งเตือนสถานะงานซ่อม: ใบงาน ${order.jobNumber} (${order.machine.brand} ${order.machine.model}) ตรวจเช็คเรียบร้อยแล้ว ไม่ได้ดำเนินการซ่อมตามที่ท่านแจ้งไว้ ท่านสามารถมารับเครื่องคืนได้ที่ร้าน`;
      } else if (status === 'COMPLETED') {
        notificationText = `แจ้งเตือนสถานะงานซ่อม: ใบงาน ${order.jobNumber} (${order.machine.brand} ${order.machine.model}) ซ่อมเสร็จสมบูรณ์แล้วครับ ท่านสามารถมารับเครื่องได้ที่ร้าน`;
      } else if (status === 'DELIVERED') {
        notificationText = `แจ้งเตือนสถานะงานซ่อม: ใบงาน ${order.jobNumber} ส่งมอบเครื่องเรียบร้อยแล้ว ขอบพระคุณที่ไว้วางใจใช้บริการ หอมไกล เซอร์วิส ครับ`;
      }

      if (notificationText) {
        await this.sendPush(order.customer.lineUserId, [{ type: 'text', text: notificationText }]);
      }
    } catch (err: any) {
      console.error('[LINE Notify Status Change Error]:', err.message || err);
    }
  }

  static async processEvents(events: any[]): Promise<void> {
    for (const event of events) {
      try {
        const lineUserId = event.source?.userId;
        const replyToken = event.replyToken;
        if (!lineUserId) continue;

        // 1. Text Message Handling: Binding Customer LINE ID (<jobNumber> <phone>)
        if (event.type === 'message' && event.message?.type === 'text') {
          const rawText = (event.message.text || '').trim();
          const tokens = rawText.split(/\s+/);

          if (tokens.length >= 2 && tokens[0].startsWith('REP-')) {
            const jobNumber = tokens[0].trim();
            const inputPhone = normalizePhone(tokens.slice(1).join(''));

            const order = await prisma.repairOrder.findUnique({
              where: { jobNumber },
              include: { customer: true },
            });

            if (!order) {
              await this.sendReply(replyToken, `ไม่พบข้อมูลใบสั่งซ่อม ${jobNumber} ในระบบ`);
              continue;
            }

            const customerPhone = normalizePhone(order.customer.phone);
            if (customerPhone !== inputPhone) {
              await this.sendReply(
                replyToken,
                'เบอร์โทรศัพท์ไม่ตรงกับข้อมูลในระบบ กรุณาตรวจสอบและลองใหม่อีกครั้ง'
              );
              continue;
            }

            if (order.customer.lineUserId && order.customer.lineUserId !== lineUserId) {
              await this.sendReply(
                replyToken,
                'ใบสั่งซ่อมนี้ผูกกับบัญชี LINE อื่นแล้ว หากต้องการเปลี่ยนบัญชี กรุณาติดต่อทางร้านโดยตรง'
              );
              continue;
            }

            const trackingBaseUrl = process.env.PUBLIC_TRACKING_BASE_URL?.trim();
            const trackingSuffix =
              trackingBaseUrl && order.trackingToken
                ? `\n\nท่านสามารถติดตามสถานะงานซ่อมแบบเรียลไทม์ได้ที่ลิงก์นี้:\n${trackingBaseUrl.replace(/\/+$/, '')}/${order.trackingToken}`
                : '';

            if (order.customer.lineUserId === lineUserId) {
              const alreadySuffix =
                trackingBaseUrl && order.trackingToken
                  ? `\n\nท่านสามารถติดตามสถานะงานซ่อมได้ที่:\n${trackingBaseUrl.replace(/\/+$/, '')}/${order.trackingToken}`
                  : '';
              await this.sendReply(
                replyToken,
                `บัญชี LINE ของท่านผูกกับงานซ่อม ${jobNumber} อยู่แล้ว${alreadySuffix}`
              );
              continue;
            }

            try {
              await prisma.customer.update({
                where: { id: order.customerId },
                data: { lineUserId },
              });
              await this.sendReply(
                replyToken,
                `ผูกบัญชี LINE กับใบสั่งซ่อม ${jobNumber} สำเร็จเรียบร้อยแล้ว${trackingSuffix}`
              );
            } catch (err: any) {
              if (err.code === 'P2002') {
                await this.sendReply(
                  replyToken,
                  'บัญชี LINE ของท่านผูกกับข้อมูลลูกค้าท่านอื่นอยู่แล้ว กรุณาติดต่อทางร้าน'
                );
              } else {
                console.error('[LINE Binding DB Error]:', err.message);
              }
            }
          }
        }

        // 2. Postback Action Handling: Customer Approve/Reject on Quotation
        if (event.type === 'postback' && event.postback?.data) {
          const params = new URLSearchParams(event.postback.data);
          const rawData = Object.fromEntries(params.entries());

          const parseResult = postbackDataSchema.safeParse(rawData);
          if (!parseResult.success) {
            console.warn('[LINE Postback Schema Invalid]:', parseResult.error.issues);
            continue;
          }

          const { orderId, itemId, status } = parseResult.data;
          await this.handleResolveItemPostback({ orderId, itemId, status, lineUserId, replyToken: replyToken ?? '' });
        }
      } catch (error: any) {
        console.error('[LINE Webhook Event Error]:', error.message || error);
      }
    }
  }
}
