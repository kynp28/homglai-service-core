import prisma from '@homglai/db';
import axios from 'axios';
import { z } from 'zod';
import { AppError } from '../utils/app-error';
import { RepairService } from './repair.service';
import { getAppConfig } from '../config/env';
import {
  bindLineToOrder,
  findOrderByTrackingQuery,
  isSubscribed,
  parseTrackingQuery,
  subscribersOf,
} from './line-subscription.service';
import { statusLabelTh } from '../utils/customer-view';

/** Same reply for every failed link attempt (unknown order, wrong phone) so nothing can be probed. */
export const LINE_BIND_FAILED_REPLY =
  'ไม่สามารถผูกบัญชีได้ กรุณาตรวจสอบเลขใบงาน (หรือเลขที่ใบรับเครื่อง) และเบอร์โทรศัพท์ที่ให้ไว้กับร้านอีกครั้ง';
export const LINE_BIND_TOO_MANY_REPLY = 'ท่านลองผูกบัญชีผิดหลายครั้ง กรุณาลองใหม่ภายหลัง หรือติดต่อทางร้าน';
export type BindReplyOutcome = 'bound' | 'already' | 'failed' | 'too_many';

/**
 * Chat instructions for customers (owner decision 2026-11-08): sent when they add the OA as a friend or press
 * the rich-menu button that sends "รับแจ้งเตือนงานซ่อม" / "ติดตามสถานะ" / "เช็คสถานะ".
 */
export const CUSTOMER_HELP_REPLY = [
  'รับแจ้งเตือนสถานะงานซ่อมทาง LINE 🔔',
  'พิมพ์ เลขใบงาน (หรือเลขที่ใบรับเครื่อง) เว้นวรรค ตามด้วยเบอร์โทรที่ให้ไว้กับร้าน แล้วส่งมาในแชตนี้',
  '',
  'ตัวอย่าง',
  'REP-2611-0001 0812345678',
  'หรือ',
  '5595 0812345678',
  '',
  'อยากดูสถานะอย่างเดียว พิมพ์แค่เลขใบงาน เช่น REP-2611-0001',
].join('\n');

/** Text that asks for the instructions (rich-menu buttons send one of these). */
const CUSTOMER_HELP_RE = /^(รับแจ้งเตือน|แจ้งเตือน|ติดตาม|เช็คสถานะ|เช็กสถานะ|ตรวจสอบสถานะ|สถานะงาน|วิธีใช้|help)/i;

export const STATUS_NOT_FOUND_REPLY = 'ไม่พบใบงานนี้ กรุณาตรวจสอบเลขใบงานหรือเลขที่ใบรับเครื่องอีกครั้ง';

/** Status-only lookups in chat: same data as the public /track page, limited per LINE account. */
const STATUS_LOOKUP_MAX = 30;
const statusLookups = new Map<string, number[]>();
function statusLookupAllowed(lineUserId: string, now = Date.now()): boolean {
  const recent = (statusLookups.get(lineUserId) ?? []).filter((t) => now - t < BIND_WINDOW_MS);
  if (recent.length >= STATUS_LOOKUP_MAX) {
    statusLookups.set(lineUserId, recent);
    return false;
  }
  statusLookups.set(lineUserId, [...recent, now]);
  return true;
}

const BIND_MAX_FAILURES = 5;
const BIND_WINDOW_MS = 15 * 60 * 1000;

/** In-memory failed-attempt counter per LINE account (sliding 15-minute window). */
export const bindFailures = {
  attempts: new Map<string, number[]>(),
  recent(lineUserId: string, now = Date.now()): number[] {
    const list = (this.attempts.get(lineUserId) ?? []).filter((t) => now - t < BIND_WINDOW_MS);
    if (list.length > 0) this.attempts.set(lineUserId, list);
    else this.attempts.delete(lineUserId);
    return list;
  },
  isBlocked(lineUserId: string): boolean {
    return this.recent(lineUserId).length >= BIND_MAX_FAILURES;
  },
  recordFailure(lineUserId: string): void {
    this.attempts.set(lineUserId, [...this.recent(lineUserId), Date.now()]);
  },
  reset(lineUserId: string): void {
    this.attempts.delete(lineUserId);
  },
};

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
      const order = await prisma.repairOrder.findUnique({ where: { id: repairOrderId } });
      const recipients = order ? await subscribersOf(repairOrderId) : [];
      if (!order || recipients.length === 0) return 'no_line_user';

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

      for (const lineUserId of recipients) {
        await this.sendPush(lineUserId, [templateMessage]);
      }
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

    const order = await prisma.repairOrder.findUnique({ where: { id: orderId } });

    if (!order) {
      await this.sendReply(replyToken, 'ไม่พบข้อมูลใบสั่งซ่อม');
      return 'not_found';
    }

    // Only LINE accounts linked to this order (after phone verification) may answer
    if (!(await isSubscribed(orderId, lineUserId))) {
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

  /**
   * "<query> <phone>" from LINE chat: same service and same rules as POST /api/tracking/subscribe-line.
   * More than BIND_MAX_FAILURES wrong attempts per LINE account in 15 minutes -> "try again later".
   */
  static async handleBindingMessage(lineUserId: string, replyToken: string, query: string, phone: string): Promise<BindReplyOutcome> {
    if (bindFailures.isBlocked(lineUserId)) {
      await this.sendReply(replyToken, LINE_BIND_TOO_MANY_REPLY);
      return 'too_many';
    }
    const result = await bindLineToOrder(query, phone, lineUserId);
    if (!result.ok) {
      bindFailures.recordFailure(lineUserId);
      await this.sendReply(replyToken, LINE_BIND_FAILED_REPLY);
      return 'failed';
    }
    bindFailures.reset(lineUserId);
    const current = await prisma.repairOrder.findUnique({
      where: { id: result.order.id },
      select: { status: true, repairOutcome: true },
    });
    const statusLine = current ? `\nสถานะตอนนี้: ${statusLabelTh(current.status, current.repairOutcome)}` : '';
    const base = process.env.PUBLIC_TRACKING_BASE_URL?.trim();
    // Private channel after phone verification: the tracking link may be sent here
    const link = base ? `\n\nติดตามสถานะได้ที่:\n${base.replace(/\/+$/, '')}/${result.order.trackingToken}` : '';
    await this.sendReply(
      replyToken,
      result.alreadySubscribed
        ? `บัญชี LINE ของท่านผูกกับใบงาน ${result.order.jobNumber} อยู่แล้ว${statusLine}${link}`
        : `ผูกบัญชี LINE กับใบงาน ${result.order.jobNumber} เรียบร้อยแล้ว ✅${statusLine}\nท่านจะได้รับแจ้งทุกครั้งที่สถานะเปลี่ยน${link}`
    );
    return result.alreadySubscribed ? 'already' : 'bound';
  }

  /** Status only (no personal data — same as the public /track page). */
  static async handleStatusMessage(lineUserId: string, replyToken: string, query: string): Promise<void> {
    if (!statusLookupAllowed(lineUserId)) {
      await this.sendReply(replyToken, 'ค้นหาบ่อยเกินไป กรุณาลองใหม่ภายหลัง');
      return;
    }
    const found = await findOrderByTrackingQuery(query);
    if (!found) {
      await this.sendReply(replyToken, STATUS_NOT_FOUND_REPLY);
      return;
    }
    const order = await prisma.repairOrder.findUniqueOrThrow({
      where: { id: found.id },
      select: { jobNumber: true, status: true, repairOutcome: true, updatedAt: true, machine: { select: { brand: true, model: true } } },
    });
    const updated = new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' }).format(order.updatedAt);
    const subscribed = await isSubscribed(found.id, lineUserId);
    await this.sendReply(
      replyToken,
      [
        `ใบงาน ${order.jobNumber} (${order.machine.brand} ${order.machine.model})`,
        `สถานะ: ${statusLabelTh(order.status, order.repairOutcome)}`,
        `อัปเดตล่าสุด: ${updated}`,
        ...(subscribed ? [] : ['', `รับแจ้งเตือนอัตโนมัติ: พิมพ์ ${order.jobNumber} ตามด้วยเบอร์โทรที่ให้ไว้กับร้าน`]),
      ].join('\n')
    );
  }

  static async processEvents(events: any[]): Promise<void> {
    for (const event of events) {
      try {
        const lineUserId = event.source?.userId;
        const replyToken = event.replyToken;
        if (!lineUserId) continue;

        // 0. New friend: how to subscribe
        if (event.type === 'follow') {
          await this.sendReply(replyToken ?? '', CUSTOMER_HELP_REPLY);
          continue;
        }

        if (event.type === 'message' && event.message?.type === 'text') {
          const text = String(event.message.text || '').trim();
          const tokens = text.split(/\s+/);
          if (tokens.length >= 2 && parseTrackingQuery(tokens[0]) !== null) {
            // 1. "<REP-... or paper receipt no.> <phone>": link this LINE account to that order
            await this.handleBindingMessage(lineUserId, replyToken ?? '', tokens[0], tokens.slice(1).join(''));
          } else if (tokens.length === 1 && parseTrackingQuery(tokens[0]) !== null) {
            // 1b. Number only: status reply
            await this.handleStatusMessage(lineUserId, replyToken ?? '', tokens[0]);
          } else if (CUSTOMER_HELP_RE.test(text)) {
            // 1c. Rich-menu keyword: instructions with an example. Other chat is left to the shop's staff.
            await this.sendReply(replyToken ?? '', CUSTOMER_HELP_REPLY);
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
