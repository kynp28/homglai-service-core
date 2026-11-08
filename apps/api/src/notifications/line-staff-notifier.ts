import prisma from '@homglai/db';
import { getAppConfig } from '../config/env';
import { ACCEPT_JOB_ACTION, LineStaffApi, STILL_WORKING_ACTION } from '../services/line-staff-api';
import { renderNotification } from './templates';
import { NotificationEvent, Notifier, NotifyResult } from './types';

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
/** "REP-2611-0001" -> "2611-0001" (button labels are limited to 20 characters) */
const shortJob = (jobNumber: string) => jobNumber.replace(/^REP-/, '');

const ADMIN_EVENTS = new Set(['ACK_OVERDUE_DIGEST', 'PROGRESS_UNANSWERED_DIGEST', 'ORDERS_REQUEUED_DIGEST', 'LINE_UNLINKED']);

/**
 * Pushes staff notifications to the staff LINE channel (employees with a linked LINE account):
 *  - JOB_RESERVED / JOB_ACK_REMINDER -> the technician, with "รับงานนี้" (+ "ดูใบงาน")
 *  - PROGRESS_CHECK -> the technician, with "ยังซ่อมอยู่" button(s)
 *  - ADMIN digests and LINE_UNLINKED -> every active ADMIN who linked LINE (text)
 */
export class LineStaffNotifier implements Notifier {
  async notify(event: NotificationEvent): Promise<NotifyResult> {
    if (ADMIN_EVENTS.has(event.type)) return this.notifyAdmins(event);
    if (event.type !== 'JOB_RESERVED' && event.type !== 'JOB_ACK_REMINDER' && event.type !== 'PROGRESS_CHECK') {
      return { delivered: 0 };
    }
    if (event.type === 'PROGRESS_CHECK' && event.orders.length === 0) return { delivered: 0 };

    const employee = await prisma.employee.findFirst({
      where: { id: event.technicianId, isActive: true, lineUserId: { not: null } },
      select: { lineUserId: true },
    });
    if (!employee?.lineUserId) return { delivered: 0 };

    const { title, body } = renderNotification(event);
    const webUrl = getAppConfig().staffWebUrl;
    const openJob = (orderId: number) =>
      webUrl.startsWith('https://') ? [{ type: 'uri', label: 'ดูใบงาน', uri: `${webUrl}/staff/repairs/${orderId}` }] : [];
    let message: Record<string, unknown>;

    if (event.type === 'JOB_RESERVED' || event.type === 'JOB_ACK_REMINDER') {
      message = {
        type: 'template',
        altText: clip(`${title}: ${event.jobNumber}`, 400),
        template: {
          type: 'buttons',
          title: clip(title, 40),
          // Buttons template text: at most 60 characters when a title is present
          text: clip(`${event.jobNumber} · ${event.machine.brand} ${event.machine.model}`, 60),
          actions: [
            {
              type: 'postback',
              label: 'รับงานนี้',
              data: `action=${ACCEPT_JOB_ACTION}&orderId=${event.repairOrderId}`,
              displayText: `รับงาน ${event.jobNumber}`,
            },
            ...openJob(event.repairOrderId),
          ],
        },
      };
    } else if (event.orders.length === 1) {
      const o = event.orders[0];
      message = {
        type: 'template',
        altText: clip(`${title}: ${o.jobNumber}`, 400),
        template: {
          type: 'buttons',
          title: clip(title, 40),
          text: clip(`${o.jobNumber} · ${o.machine.brand} ${o.machine.model} ยังซ่อมอยู่ไหม?`, 60),
          actions: [
            {
              type: 'postback',
              label: 'ยังซ่อมอยู่',
              data: `action=${STILL_WORKING_ACTION}&orderId=${o.repairOrderId}`,
              displayText: `ยังซ่อมอยู่ ${o.jobNumber}`,
            },
            ...openJob(o.repairOrderId),
          ],
        },
      };
    } else {
      // Several idle jobs: text + one quick-reply button per job (quick reply holds at most 13)
      message = {
        type: 'text',
        text: clip(`${title}\n${body}`, 5000),
        quickReply: {
          items: event.orders.slice(0, 13).map((o) => ({
            type: 'action',
            action: {
              type: 'postback',
              label: clip(`ยังซ่อม ${shortJob(o.jobNumber)}`, 20),
              data: `action=${STILL_WORKING_ACTION}&orderId=${o.repairOrderId}`,
              displayText: `ยังซ่อมอยู่ ${o.jobNumber}`,
            },
          })),
        },
      };
    }

    const sent = await LineStaffApi.push(employee.lineUserId, [message]);
    return { delivered: sent ? 1 : 0 };
  }

  /** Text to every active ADMIN who linked LINE. */
  private async notifyAdmins(event: NotificationEvent): Promise<NotifyResult> {
    const admins = await prisma.employee.findMany({
      where: { role: 'ADMIN', isActive: true, lineUserId: { not: null } },
      select: { lineUserId: true },
    });
    if (admins.length === 0) return { delivered: 0 };
    const { title, body } = renderNotification(event);
    const text = clip(`${title}\n${body}`, 5000);
    let delivered = 0;
    for (const a of admins) {
      if (a.lineUserId && (await LineStaffApi.push(a.lineUserId, [{ type: 'text', text }]))) delivered++;
    }
    return { delivered };
  }
}

/** Sends every event to all channels; the result counts the first (web inbox) channel. */
export class CompositeNotifier implements Notifier {
  constructor(private readonly channels: Notifier[]) {}

  async notify(event: NotificationEvent): Promise<NotifyResult> {
    const results = await Promise.all(
      this.channels.map((c) =>
        c.notify(event).catch((err: any) => {
          console.error(`[Notifier] ${c.constructor.name} failed for ${event.type}:`, err?.message ?? err);
          return { delivered: 0 };
        })
      )
    );
    return results[0] ?? { delivered: 0 };
  }
}
