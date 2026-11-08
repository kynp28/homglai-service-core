import { RepairStatus } from '@homglai/db';
import { SseService } from './sse.service';
import { notifyCustomersOfStatus } from './customer-notifier';
import { pushTechnicianStatusUpdate } from './technician-line-updates';

/**
 * Single place for customer-visible side effects of an order change. Call ONLY after the
 * transaction has committed.
 *  - statusChanged: public SSE { status, updatedAt } + LINE message to every linked account
 *                   + a fresh job card to the assigned technician's LINE (cards in chat cannot be edited)
 *  - touched:       public SSE only (status unchanged, e.g. an item was marked done)
 */
export class OrderEvents {
  static statusChanged(
    order: { id: number; trackingToken: string; status: RepairStatus; updatedAt?: Date },
    options: { notifyCustomer?: boolean } = {}
  ): void {
    SseService.broadcastStatus(order.trackingToken, {
      status: order.status,
      updatedAt: (order.updatedAt ?? new Date()).toISOString(),
    });
    if (options.notifyCustomer ?? true) {
      notifyCustomersOfStatus(order.id).catch((err) => console.error('[OrderEvents] customer notify failed:', err?.message || err));
    }
    pushTechnicianStatusUpdate(order.id, order.status);
  }

  static touched(order: { trackingToken: string; status: RepairStatus; updatedAt?: Date }): void {
    SseService.broadcastStatus(order.trackingToken, {
      status: order.status,
      updatedAt: (order.updatedAt ?? new Date()).toISOString(),
    });
  }
}
