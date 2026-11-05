import { Prisma } from '@homglai/db';

/**
 * Single source of truth for "activity" on a repair order (SRS 3.6): a status change, adding or
 * recording an item, uploading a photo, or pressing "ยังซ่อมอยู่". Activity restarts the progress
 * timer and clears the unanswered-reminder counter.
 */
export function activityFields(at: Date) {
  return {
    lastActivityAt: at,
    progressReminderCount: 0,
    lastProgressReminderAt: null,
  };
}

/** Records activity on an order inside an existing transaction (when no other order update happens). */
export async function recordActivity(
  tx: Prisma.TransactionClient,
  repairOrderId: number,
  at: Date = new Date()
): Promise<void> {
  await tx.repairOrder.updateMany({ where: { id: repairOrderId }, data: activityFields(at) });
}
