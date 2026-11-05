import prisma from '@homglai/db';
import { statusLabelTh } from '../utils/customer-view';
import { subscribersOf } from './line-subscription.service';

/** Customer-facing LINE channel (SRS 3.2 item 4). Separate from the staff Notifier. */
export interface LineCustomerNotifier {
  push(lineUserId: string, text: string): Promise<void>;
}

/** Real implementation: LINE Messaging API push (never throws; errors are logged by sendPush). */
export const linePushCustomerNotifier: LineCustomerNotifier = {
  async push(lineUserId: string, text: string) {
    // Imported lazily: line-webhook.service imports the repair service, which imports this module
    const { LineWebhookService } = await import('./line-webhook.service');
    await LineWebhookService.sendPush(lineUserId, [{ type: 'text', text }]);
  },
};

/** Thai status message: job number + status + machine. NEVER prices, items, notes or names. */
export function customerStatusMessage(order: {
  jobNumber: string;
  status: Parameters<typeof statusLabelTh>[0];
  repairOutcome: string | null;
  machine: { brand: string; model: string };
}): string {
  const label = statusLabelTh(order.status, order.repairOutcome);
  const closing =
    order.status === 'DELIVERED' ? '\nขอบพระคุณที่ไว้วางใจใช้บริการ หอมไกล เซอร์วิส ครับ' : '';
  return `แจ้งสถานะงานซ่อม\nใบงาน ${order.jobNumber} (${order.machine.brand} ${order.machine.model})\nสถานะ: ${label}${closing}`;
}

/**
 * Sends the current status of an order to every LINE account linked to it. Returns the recipients.
 * A failure for one account never stops the others and never reaches the caller's flow.
 */
export async function notifyCustomersOfStatus(
  repairOrderId: number,
  notifier: LineCustomerNotifier = linePushCustomerNotifier
): Promise<string[]> {
  const order = await prisma.repairOrder.findUnique({
    where: { id: repairOrderId },
    select: { jobNumber: true, status: true, repairOutcome: true, machine: { select: { brand: true, model: true } } },
  });
  if (!order) return [];
  const recipients = await subscribersOf(repairOrderId);
  const text = customerStatusMessage(order);
  for (const lineUserId of recipients) {
    try {
      await notifier.push(lineUserId, text);
    } catch (err: any) {
      console.error('[LINE Customer Notify Error]:', err?.message || err);
    }
  }
  return recipients;
}
