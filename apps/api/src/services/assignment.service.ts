import prisma from '@homglai/db';
import { SseService } from './sse.service';

export class AssignmentService {
  /**
   * Processes the assignment queue. Pairs the oldest unassigned NEW orders
   * with the longest-idle AVAILABLE technicians using atomic conditional updates.
   * Broadcasts SSE updates strictly post-commit.
   */
  static async processQueue(): Promise<number> {
    let assignedCount = 0;

    while (true) {
      try {
        const result = await prisma.$transaction(async (tx) => {
          // 1. Find the oldest NEW order without a technician
          const order = await tx.repairOrder.findFirst({
            where: { status: 'NEW', technicianId: null },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          });
          if (!order) return null;

          // 2. Find the active technician available for the longest time
          const tech = await tx.employee.findFirst({
            where: { role: 'TECHNICIAN', status: 'AVAILABLE', isActive: true },
            orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
          });
          if (!tech) return null;

          // 3. Atomically claim order
          const orderUpdate = await tx.repairOrder.updateMany({
            where: { id: order.id, status: 'NEW', technicianId: null },
            data: { status: 'INSPECTING', technicianId: tech.id },
          });
          if (orderUpdate.count === 0) {
            // Contention: claimed by another worker
            return 'RETRY';
          }

          // 4. Atomically mark technician BUSY
          const techUpdate = await tx.employee.updateMany({
            where: { id: tech.id, role: 'TECHNICIAN', status: 'AVAILABLE', isActive: true },
            data: { status: 'BUSY' },
          });
          if (techUpdate.count === 0) {
            // Contention: technician state changed, abort transaction to release order
            throw new Error('TECH_BUSY_RETRY');
          }

          // 5. Create StatusLog
          await tx.statusLog.create({
            data: {
              repairOrderId: order.id,
              status: 'INSPECTING',
              changedById: tech.id,
              note: 'Auto-assigned from queue',
            },
          });

          return {
            orderId: order.id,
            jobNumber: order.jobNumber,
            trackingToken: order.trackingToken,
            technicianId: tech.id,
          };
        });

        if (!result) {
          // Queue is empty or no technicians available
          break;
        }

        if (result === 'RETRY') {
          continue;
        }

        assignedCount++;

        // Broadcast SSE strictly post-commit (sensitive info like technicianId/customerId excluded)
        SseService.broadcastUpdate(result.trackingToken, {
          trackingToken: result.trackingToken,
          jobNumber: result.jobNumber,
          status: 'INSPECTING',
          updatedAt: new Date().toISOString(),
        });
      } catch (err: any) {
        if (err.message === 'TECH_BUSY_RETRY') {
          continue;
        }
        console.error('[AssignmentService Error]:', err.message || err);
        break;
      }
    }

    return assignedCount;
  }
}
