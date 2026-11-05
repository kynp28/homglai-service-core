import prisma, { Prisma, RepairStatus } from '@homglai/db';
import { SseService } from './sse.service';
import { notifySafely, OrdersRequeuedDigestEvent } from '../notifications';

type Tx = Prisma.TransactionClient;

/** Order statuses in which a technician is actively working on an accepted job. */
export const ACCEPTED_WORK_STATUSES: RepairStatus[] = ['INSPECTING', 'WAITING_APPROVAL', 'REPAIRING'];

/**
 * Where-clause for "orders a technician currently holds": accepted work, or a NEW order reserved
 * for them (assigned but not yet accepted). COMPLETED orders waiting for pickup are not held.
 */
export function heldOrdersWhere(technicianId: number): Prisma.RepairOrderWhereInput {
  return {
    technicianId,
    status: { in: ['NEW', ...ACCEPTED_WORK_STATUSES] },
  };
}

export interface RequeuedOrder {
  id: number;
  jobNumber: string;
  trackingToken: string;
  previousStatus: 'NEW' | 'INSPECTING' | 'WAITING_APPROVAL' | 'REPAIRING';
}

export class AssignmentService {
  /**
   * Processes the job pool (SRS 3.3). Repeatedly pairs the next unassigned NEW order
   * (queuePriority DESC, then oldest first) with the active technician who has been AVAILABLE the
   * longest (availableSince ASC). The order stays NEW with technicianId/assignedAt set and the
   * technician becomes RESERVED until they accept. Both claims are conditional updates inside one
   * transaction so concurrent workers never double-assign. JOB_RESERVED is sent after commit.
   * No customer SSE is sent: the customer-visible status is still NEW.
   */
  static async processQueue(): Promise<number> {
    let assignedCount = 0;

    while (true) {
      try {
        const result = await prisma.$transaction(async (tx) => {
          // 1. Next order in the pool: orders returned from a deactivated technician first, then FIFO
          const order = await tx.repairOrder.findFirst({
            where: { status: 'NEW', technicianId: null },
            orderBy: [{ queuePriority: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
            include: { machine: { select: { brand: true, model: true } } },
          });
          if (!order) return null;

          // 2. Technician available for the longest time
          const tech = await tx.employee.findFirst({
            where: { role: 'TECHNICIAN', status: 'AVAILABLE', isActive: true },
            orderBy: [{ availableSince: 'asc' }, { id: 'asc' }],
          });
          if (!tech) return null;

          const now = new Date();

          // 3. Atomically claim the order (status stays NEW until the technician accepts)
          const orderUpdate = await tx.repairOrder.updateMany({
            where: { id: order.id, status: 'NEW', technicianId: null },
            data: {
              technicianId: tech.id,
              assignedAt: now,
              acknowledgedAt: null,
              ackReminderCount: 0,
              lastAckReminderAt: null,
            },
          });
          if (orderUpdate.count === 0) {
            return 'RETRY' as const; // claimed by another worker
          }

          // 4. Atomically reserve the technician
          const techUpdate = await tx.employee.updateMany({
            where: { id: tech.id, role: 'TECHNICIAN', status: 'AVAILABLE', isActive: true },
            data: { status: 'RESERVED' },
          });
          if (techUpdate.count === 0) {
            throw new Error('TECH_BUSY_RETRY'); // roll back the order claim
          }

          await tx.statusLog.create({
            data: {
              repairOrderId: order.id,
              status: 'NEW',
              changedById: null,
              note: `Reserved for technician ${tech.name} (#${tech.id}); waiting for acceptance`,
            },
          });

          return {
            orderId: order.id,
            jobNumber: order.jobNumber,
            technicianId: tech.id,
            machine: order.machine,
          };
        });

        if (!result) break;
        if (result === 'RETRY') continue;

        assignedCount++;

        // Post-commit only; never fails the queue
        await notifySafely({
          type: 'JOB_RESERVED',
          technicianId: result.technicianId,
          repairOrderId: result.orderId,
          jobNumber: result.jobNumber,
          machine: result.machine,
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

  /**
   * Returns every order a technician holds (reserved NEW, INSPECTING, WAITING_APPROVAL, REPAIRING)
   * to the job pool. Must run inside the same transaction that deactivates the technician or moves
   * them out of the TECHNICIAN role. Phase 8's background check calls it again as a safety net.
   *
   * - status NEW, technician/assignment/acknowledgement and reminder fields cleared, lastActivityAt = now
   * - queuePriority = 1 only for orders that had been accepted (work in progress), so they go to the
   *   head of the queue; reserved-but-not-accepted orders keep their priority (original FIFO order)
   * - items, images, completionSummary and history are kept; a StatusLog explains the move
   * - COMPLETED orders waiting for pickup are not moved
   * Every update is conditional on the order still being held by this technician in the same status,
   * so a concurrent update by the old technician cannot be overwritten.
   */
  static async requeueOrdersOfTechnician(
    tx: Tx,
    technicianId: number,
    actorId: number,
    reason: OrdersRequeuedDigestEvent['reason']
  ): Promise<RequeuedOrder[]> {
    const technician = await tx.employee.findUnique({ where: { id: technicianId }, select: { name: true } });
    const orders = await tx.repairOrder.findMany({
      where: heldOrdersWhere(technicianId),
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, jobNumber: true, trackingToken: true, status: true, queuePriority: true },
    });

    const now = new Date();
    const requeued: RequeuedOrder[] = [];
    const reasonTh = reason === 'DEACTIVATED' ? 'ช่างถูกปิดการใช้งาน' : 'ช่างถูกเปลี่ยนบทบาท';
    const reasonEn = reason === 'DEACTIVATED' ? 'technician deactivated' : 'technician removed from TECHNICIAN role';

    for (const order of orders) {
      const wasAccepted = order.status !== 'NEW';
      const moved = await tx.repairOrder.updateMany({
        where: { id: order.id, technicianId, status: order.status },
        data: {
          status: 'NEW',
          technicianId: null,
          assignedAt: null,
          acknowledgedAt: null,
          ackReminderCount: 0,
          lastAckReminderAt: null,
          progressReminderCount: 0,
          lastProgressReminderAt: null,
          lastActivityAt: now,
          queuePriority: wasAccepted ? 1 : order.queuePriority,
        },
      });
      if (moved.count === 0) continue; // changed concurrently; nothing to move

      const stage = order.status as RequeuedOrder['previousStatus'];
      await tx.statusLog.create({
        data: {
          repairOrderId: order.id,
          status: 'NEW',
          changedById: actorId,
          note:
            `ส่งกลับกองกลางเพราะ${reasonTh} (${technician?.name ?? `#${technicianId}`}) ขั้นเดิม: ${stage} / ` +
            `Returned to job pool: ${reasonEn} (previous stage: ${stage})`,
        },
      });

      requeued.push({ id: order.id, jobNumber: order.jobNumber, trackingToken: order.trackingToken, previousStatus: stage });
    }

    return requeued;
  }

  /**
   * Post-commit side effects of requeueOrdersOfTechnician: status-only SSE (NEW), one ADMIN summary,
   * then re-run the queue so returned orders are assigned immediately. No customer LINE push.
   */
  static async afterRequeue(
    requeued: RequeuedOrder[],
    technicianName: string,
    reason: OrdersRequeuedDigestEvent['reason']
  ): Promise<void> {
    if (requeued.length === 0) return;

    const updatedAt = new Date().toISOString();
    for (const order of requeued) {
      SseService.broadcastUpdate(order.trackingToken, {
        trackingToken: order.trackingToken,
        jobNumber: order.jobNumber,
        status: 'NEW',
        updatedAt,
      });
    }

    await notifySafely({
      type: 'ORDERS_REQUEUED_DIGEST',
      technicianName,
      reason,
      orders: requeued.map((o) => ({ repairOrderId: o.id, jobNumber: o.jobNumber, previousStatus: o.previousStatus })),
    });

    await AssignmentService.processQueue();
  }
}
