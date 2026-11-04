import prisma from '@homglai/db';
import { RepairService } from './repair.service';

export class LineWebhookService {
  static async processEvents(events: any[]) {
    for (const event of events) {
      try {
        const lineUserId = event.source?.userId;
        if (!lineUserId) continue;

        // 1. Handle Text Message (Binding Customer LINE ID)
        if (event.type === 'message' && event.message?.type === 'text') {
          const text = event.message.text.trim();
          
          // If customer types Job Number (e.g., REP-2611-0001)
          if (text.startsWith('REP-')) {
            const order = await prisma.repairOrder.findUnique({
              where: { jobNumber: text },
              select: { customerId: true }
            });

            if (order) {
              await prisma.customer.update({
                where: { id: order.customerId },
                data: { lineUserId } // Auto-overwrite if changed
              });
              console.log(`[LINE] Successfully bound LINE ID ${lineUserId} to Customer ${order.customerId}`);
              // In production, you would call LINE Messaging API here to reply "Binding successful"
            }
          }
        }

        // 2. Handle Postback Action (Customer clicks Approve/Reject on Flex Message)
        if (event.type === 'postback' && event.postback?.data) {
          // Example data format: "action=resolve_item&orderId=1&itemId=5&status=APPROVED"
          const params = new URLSearchParams(event.postback.data);
          const action = params.get('action');
          const orderId = parseInt(params.get('orderId') || '0');
          const itemId = parseInt(params.get('itemId') || '0');
          const status = params.get('status') as 'APPROVED' | 'REJECTED';

          if (action === 'resolve_item' && orderId && itemId && status) {
            await RepairService.resolveRepairItem(orderId, itemId, status);
            console.log(`[LINE] Resolved Item ${itemId} as ${status} for Order ${orderId}`);
          }
        }
      } catch (error) {
        console.error('[LINE Webhook Error]:', error);
      }
    }
  }
}
