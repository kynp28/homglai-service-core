import prisma from '@homglai/db';
import axios from 'axios';
import { z } from 'zod';
import { normalizePhone } from '../utils/phone';
import { AppError } from '../utils/app-error';
import { RepairService } from './repair.service';

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

  static async notifyCustomerNewItem(
    repairOrderId: number,
    item: { id: number; name: string; price: any }
  ): Promise<void> {
    try {
      const order = await prisma.repairOrder.findUnique({
        where: { id: repairOrderId },
        include: { customer: true },
      });

      if (!order?.customer?.lineUserId) return;

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
    } catch (err: any) {
      console.error('[LINE Notify New Item Error]:', err.message || err);
    }
  }

  static async notifyCustomerStatusChange(
    repairOrderId: number,
    status: 'COMPLETED' | 'DELIVERED'
  ): Promise<void> {
    try {
      const order = await prisma.repairOrder.findUnique({
        where: { id: repairOrderId },
        include: { customer: true, machine: true },
      });

      if (!order?.customer?.lineUserId) return;

      let notificationText = '';
      if (status === 'COMPLETED') {
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

          const order = await prisma.repairOrder.findUnique({
            where: { id: orderId },
            include: { customer: true },
          });

          if (!order) {
            await this.sendReply(replyToken, 'ไม่พบข้อมูลใบสั่งซ่อม');
            continue;
          }

          // Check ownership
          if (!order.customer.lineUserId || order.customer.lineUserId !== lineUserId) {
            await this.sendReply(
              replyToken,
              'ท่านไม่มีสิทธิ์ดำเนินการ เนื่องจากบัญชี LINE ไม่ตรงกับเจ้าของงานซ่อม'
            );
            continue;
          }

          try {
            await RepairService.resolveRepairItem(orderId, itemId, status);
            const actionText = status === 'APPROVED' ? 'อนุมัติ' : 'ปฏิเสธ';
            await this.sendReply(
              replyToken,
              `บันทึกผลการ${actionText}รายการสำหรับใบงาน ${order.jobNumber} เรียบร้อยแล้ว`
            );
          } catch (err: any) {
            if (err instanceof AppError && err.statusCode === 409) {
              await this.sendReply(
                replyToken,
                'รายการนี้ได้รับการพิจารณาไปแล้ว หรือไม่สามารถดำเนินการได้ในขณะนี้'
              );
            } else {
              await this.sendReply(
                replyToken,
                'เกิดข้อผิดพลาดในการบันทึกข้อมูล กรุณาลองใหม่อีกครั้งหรือติดต่อทางร้าน'
              );
            }
          }
        }
      } catch (error: any) {
        console.error('[LINE Webhook Event Error]:', error.message || error);
      }
    }
  }
}
