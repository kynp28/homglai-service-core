import { getAppConfig } from '../config/env';
import { DbNotifier } from './db-notifier';
import { CompositeNotifier, LineStaffNotifier } from './line-staff-notifier';
import { techLineEnabled } from '../services/line-staff-api';
import { NotificationEvent, Notifier, NotifyResult } from './types';

export * from './types';
export { renderNotification, progressCheckLine } from './templates';
export { DbNotifier } from './db-notifier';

let notifier: Notifier | null = null;

/**
 * Returns the configured notifier (NOTIFIER_DRIVER). Today only `db`; a LineStaffNotifier can be
 * added here later without changing any caller.
 */
export function getNotifier(): Notifier {
  if (!notifier) {
    switch (getAppConfig().notifierDriver) {
      case 'db':
      default:
        // Web inbox always; technicians' LINE as well once LINE_TECH_CHANNEL_ACCESS_TOKEN is set
        notifier = techLineEnabled() ? new CompositeNotifier([new DbNotifier(), new LineStaffNotifier()]) : new DbNotifier();
    }
  }
  return notifier;
}

/**
 * Sends a notification without ever throwing. Call it only AFTER the business transaction has
 * committed; a notification failure is logged and must never roll back or fail the main operation.
 */
export async function notifySafely(event: NotificationEvent, target?: Notifier): Promise<NotifyResult> {
  try {
    return await (target ?? getNotifier()).notify(event);
  } catch (err: any) {
    console.error(`[Notifier] Failed to deliver ${event?.type ?? 'unknown event'}:`, err?.message ?? err);
    return { delivered: 0 };
  }
}
