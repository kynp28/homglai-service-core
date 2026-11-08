import prisma from '@homglai/db';
import { getAppConfig } from '../config/env';
import { ACCEPT_JOB_ACTION, LineStaffApi } from '../services/line-staff-api';
import { renderNotification } from './templates';
import { NotificationEvent, Notifier, NotifyResult } from './types';

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * Pushes technician notifications to the technicians' LINE channel (employees with a linked LINE account).
 * JOB_RESERVED gets a "รับงานนี้" button (postback handled by /api/webhook/line/tech); PROGRESS_CHECK is text.
 * ADMIN digests stay in the web inbox (DbNotifier).
 */
export class LineStaffNotifier implements Notifier {
  async notify(event: NotificationEvent): Promise<NotifyResult> {
    if (event.type !== 'JOB_RESERVED' && event.type !== 'PROGRESS_CHECK') return { delivered: 0 };
    if (event.type === 'PROGRESS_CHECK' && event.orders.length === 0) return { delivered: 0 };

    const employee = await prisma.employee.findFirst({
      where: { id: event.technicianId, isActive: true, lineUserId: { not: null } },
      select: { lineUserId: true },
    });
    if (!employee?.lineUserId) return { delivered: 0 };

    const { title, body } = renderNotification(event);
    const webUrl = getAppConfig().staffWebUrl;
    let message: Record<string, unknown>;

    if (event.type === 'JOB_RESERVED') {
      const actions: Record<string, unknown>[] = [
        {
          type: 'postback',
          label: 'รับงานนี้',
          data: `action=${ACCEPT_JOB_ACTION}&orderId=${event.repairOrderId}`,
          displayText: `รับงาน ${event.jobNumber}`,
        },
      ];
      if (webUrl.startsWith('https://')) {
        actions.push({ type: 'uri', label: 'ดูใบงาน', uri: `${webUrl}/staff/repairs/${event.repairOrderId}` });
      }
      message = {
        type: 'template',
        altText: clip(`${title}: ${event.jobNumber}`, 400),
        template: {
          type: 'buttons',
          title: clip(title, 40),
          // Buttons template text: at most 60 characters when a title is present
          text: clip(`${event.jobNumber} · ${event.machine.brand} ${event.machine.model}`, 60),
          actions,
        },
      };
    } else {
      message = { type: 'text', text: clip(`${title}\n${body}`, 5000) };
    }

    const sent = await LineStaffApi.push(employee.lineUserId, [message]);
    return { delivered: sent ? 1 : 0 };
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
