import prisma from '@homglai/db';
import { normalizePhone } from '../utils/phone';

const JOB_NUMBER_RE = /^REP-\d{4}-\d{4,}$/;
const PAPER_RECEIPT_RE = /^\d{1,10}$/;

/**
 * Public lookup key (SRS 3.2): "REP-YYMM-NNNN" (jobNumber) or 1-10 digits (paper receipt number).
 * Anything else is "not found". Phone numbers are never accepted as a lookup key.
 */
export function parseTrackingQuery(raw: unknown): { jobNumber: string } | { paperReceiptNo: string } | null {
  if (typeof raw !== 'string') return null;
  const query = raw.trim().toUpperCase();
  if (JOB_NUMBER_RE.test(query)) return { jobNumber: query };
  if (PAPER_RECEIPT_RE.test(query)) return { paperReceiptNo: query };
  return null;
}

const trackingOrderSelect = {
  id: true,
  jobNumber: true,
  trackingToken: true,
  status: true,
  repairOutcome: true,
  receivedDate: true,
  updatedAt: true,
  customer: { select: { phone: true } },
  machine: { select: { brand: true, model: true } },
} as const;

export async function findOrderByTrackingQuery(raw: unknown) {
  const key = parseTrackingQuery(raw);
  if (!key) return null;
  return prisma.repairOrder.findFirst({ where: key, select: trackingOrderSelect });
}

export type BindResult =
  | { ok: false }
  | { ok: true; alreadySubscribed: boolean; order: { id: number; jobNumber: string; trackingToken: string } };

/**
 * Links a LINE account to ONE repair order after the customer proves the phone number on file
 * (SRS 3.2, 6.2). Idempotent: linking again succeeds with alreadySubscribed = true.
 * A customer may link many orders; an order may be linked to several LINE accounts.
 * Every failure is the same `{ ok: false }` so callers cannot reveal which part was wrong.
 */
export async function bindLineToOrder(query: unknown, phone: unknown, lineUserId: string): Promise<BindResult> {
  if (typeof phone !== 'string' || !lineUserId) return { ok: false };
  const order = await findOrderByTrackingQuery(query);
  const inputPhone = normalizePhone(phone);
  if (!order || !inputPhone || normalizePhone(order.customer.phone) !== inputPhone) return { ok: false };

  const created = await prisma.orderLineSubscription.createMany({
    data: [{ repairOrderId: order.id, lineUserId }],
    skipDuplicates: true,
  });
  return {
    ok: true,
    alreadySubscribed: created.count === 0,
    order: { id: order.id, jobNumber: order.jobNumber, trackingToken: order.trackingToken },
  };
}

export async function subscribersOf(repairOrderId: number): Promise<string[]> {
  const rows = await prisma.orderLineSubscription.findMany({
    where: { repairOrderId },
    select: { lineUserId: true },
    orderBy: { id: 'asc' },
  });
  return rows.map((r) => r.lineUserId);
}

export async function isSubscribed(repairOrderId: number, lineUserId: string): Promise<boolean> {
  const row = await prisma.orderLineSubscription.findFirst({ where: { repairOrderId, lineUserId }, select: { id: true } });
  return row !== null;
}
