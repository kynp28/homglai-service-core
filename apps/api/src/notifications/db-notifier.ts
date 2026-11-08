import prisma, { Prisma } from '@homglai/db';
import { renderNotification } from './templates';
import { NotificationEvent, Notifier, NotifyResult } from './types';

/** Events addressed to one technician; every other event goes to all active ADMINs. */
function directRecipient(event: NotificationEvent): number | null {
  switch (event.type) {
    case 'JOB_RESERVED':
    case 'JOB_ACK_REMINDER':
    case 'PROGRESS_CHECK':
      return event.technicianId;
    default:
      return null;
  }
}

/** Order ids referenced by the event (used to fill Notification.repairOrderId when there is exactly one). */
function orderIds(event: NotificationEvent): number[] {
  switch (event.type) {
    case 'JOB_RESERVED':
    case 'JOB_ACK_REMINDER':
      return [event.repairOrderId];
    case 'LINE_UNLINKED':
      return [];
    default:
      return event.orders.map((o) => o.repairOrderId);
  }
}

function isEmpty(event: NotificationEvent): boolean {
  if (event.type === 'JOB_RESERVED' || event.type === 'JOB_ACK_REMINDER' || event.type === 'LINE_UNLINKED') return false;
  return event.orders.length === 0;
}

/**
 * Stores notifications in the `Notification` table (shown in the staff web app until LINE for staff exists).
 * Only active employees receive notifications. An ADMIN digest creates one row per active ADMIN.
 */
export class DbNotifier implements Notifier {
  async notify(event: NotificationEvent): Promise<NotifyResult> {
    if (isEmpty(event)) {
      return { delivered: 0 };
    }

    const direct = directRecipient(event);
    const recipients = await prisma.employee.findMany({
      where: direct !== null ? { id: direct, isActive: true } : { role: 'ADMIN', isActive: true },
      select: { id: true },
      orderBy: { id: 'asc' },
    });

    if (recipients.length === 0) {
      console.log(`[Notifier:db] ${event.type}: no active recipient, nothing stored`);
      return { delivered: 0 };
    }

    const { title, body } = renderNotification(event);
    const ids = orderIds(event);
    const repairOrderId = ids.length === 1 ? ids[0] : null;

    const result = await prisma.notification.createMany({
      data: recipients.map((r) => ({
        recipientId: r.id,
        type: event.type,
        repairOrderId,
        title,
        body,
        payload: event as unknown as Prisma.InputJsonValue,
      })),
    });

    console.log(
      `[Notifier:db] ${event.type} -> ${result.count} recipient(s) [${recipients.map((r) => r.id).join(', ')}]`
    );
    return { delivered: result.count };
  }
}
