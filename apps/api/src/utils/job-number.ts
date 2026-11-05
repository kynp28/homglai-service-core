/**
 * Job numbers REP-YYMM-NNNN (Bangkok month) from the JobNumberSequence counter table.
 *
 * The counter row is incremented with INSERT ... ON DUPLICATE KEY UPDATE inside the intake
 * transaction. InnoDB holds the row lock until commit, so concurrent intakes of the same month are
 * serialised on that row and can never produce the same number (no retry, no unique-key error).
 * LAST_INSERT_ID(expr) hands the new value back on the same connection.
 */
import { Prisma } from '@homglai/db';
import { getBangkokYearMonth } from './date';

export function jobNumberPrefix(at: Date): string {
  return `REP-${getBangkokYearMonth(at)}`;
}

export function formatJobNumber(prefix: string, seq: number): string {
  return `${prefix}-${seq.toString().padStart(4, '0')}`;
}

/** Allocates the next job number. Must run inside the intake transaction. */
export async function allocateJobNumber(tx: Prisma.TransactionClient, at: Date = new Date()): Promise<string> {
  const prefix = jobNumberPrefix(at);
  await tx.$executeRaw`
    INSERT INTO \`JobNumberSequence\` (\`prefix\`, \`lastSeq\`, \`updatedAt\`)
    VALUES (${prefix}, LAST_INSERT_ID(1), CURRENT_TIMESTAMP(3))
    ON DUPLICATE KEY UPDATE \`lastSeq\` = LAST_INSERT_ID(\`lastSeq\` + 1), \`updatedAt\` = CURRENT_TIMESTAMP(3)`;
  const rows = await tx.$queryRaw<{ seq: bigint | number }[]>`SELECT LAST_INSERT_ID() AS seq`;
  return formatJobNumber(prefix, Number(rows[0].seq));
}

/**
 * Safety net: moves the counter past the highest jobNumber already stored for the prefix (e.g. rows
 * inserted by hand or by an older build). Called only after an unexpected jobNumber collision.
 */
export async function resyncJobNumberCounter(tx: Prisma.TransactionClient, at: Date = new Date()): Promise<void> {
  const prefix = jobNumberPrefix(at);
  const pattern = `^${prefix}-[0-9]+$`;
  await tx.$executeRaw`
    INSERT INTO \`JobNumberSequence\` (\`prefix\`, \`lastSeq\`, \`updatedAt\`)
    SELECT ${prefix}, COALESCE(MAX(CAST(SUBSTRING_INDEX(\`jobNumber\`, '-', -1) AS UNSIGNED)), 0), CURRENT_TIMESTAMP(3)
    FROM \`RepairOrder\` WHERE \`jobNumber\` REGEXP ${pattern}
    ON DUPLICATE KEY UPDATE \`lastSeq\` = GREATEST(\`lastSeq\`, VALUES(\`lastSeq\`)), \`updatedAt\` = CURRENT_TIMESTAMP(3)`;
}
