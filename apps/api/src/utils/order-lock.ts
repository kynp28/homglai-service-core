import { Prisma, RepairStatus } from '@homglai/db';

/**
 * Locks one RepairOrder row for the rest of the transaction (SELECT ... FOR UPDATE) and returns its
 * current status and technician. Any other transaction that changes the same order (rework,
 * requeue, status change) waits until this one commits, so checks made after the lock stay true.
 * Returns null when the order does not exist.
 */
export async function lockOrderRow(
  tx: Prisma.TransactionClient,
  repairOrderId: number
): Promise<{ status: RepairStatus; technicianId: number | null } | null> {
  const rows = await tx.$queryRaw<Array<{ status: string; technicianId: number | bigint | null }>>`
    SELECT status, technicianId FROM RepairOrder WHERE id = ${repairOrderId} FOR UPDATE`;
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    status: row.status as RepairStatus,
    technicianId: row.technicianId === null ? null : Number(row.technicianId),
  };
}
