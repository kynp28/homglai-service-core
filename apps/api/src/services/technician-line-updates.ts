import { AsyncLocalStorage } from 'node:async_hooks';
import prisma, { RepairStatus } from '@homglai/db';
import { statusLabelTh } from '../utils/customer-view';
import { LineStaffApi, techLineEnabled } from './line-staff-api';

/**
 * LINE messages cannot be edited after they are sent, so a job card in the technician's chat goes stale
 * when the job changes somewhere else (completed or delivered on the web, price decided at the front desk,
 * cancelled, ...). When the status changes we push the assigned technician a short update + a fresh job card.
 *
 * Changes made by tapping a button in the technicians' LINE chat are skipped: the webhook already replies
 * with the new card (see runAsLineAction).
 */
const lineAction = new AsyncLocalStorage<{ orderId: number }>();

/** Run a job action that came from a LINE postback; status pushes for that order are suppressed. */
export function runAsLineAction<T>(orderId: number, fn: () => Promise<T>): Promise<T> {
  return lineAction.run({ orderId }, fn);
}

/** Call post-commit from OrderEvents.statusChanged. Never throws. */
export function pushTechnicianStatusUpdate(orderId: number, status: RepairStatus): void {
  if (!techLineEnabled()) return;
  if (lineAction.getStore()?.orderId === orderId) return;
  // NEW = back in the queue / re-reserved: the JOB_RESERVED notification covers that
  if (status === 'NEW') return;
  send(orderId).catch((err) => console.error('[LINE Tech] status update push failed:', err?.message || err));
}

async function send(orderId: number): Promise<void> {
  const order = await prisma.repairOrder.findUnique({
    where: { id: orderId },
    select: {
      jobNumber: true,
      status: true,
      repairOutcome: true,
      technician: { select: { id: true, role: true, isActive: true, lineUserId: true } },
    },
  });
  const tech = order?.technician;
  if (!order || !tech || !tech.isActive || !tech.lineUserId) return;

  const label = statusLabelTh(order.status, order.repairOutcome);
  const closed = order.status === 'COMPLETED' || order.status === 'DELIVERED' || order.status === 'CANCELLED';
  const text = closed
    ? `อัปเดตใบงาน ${order.jobNumber}: ${label}\nปุ่มในข้อความก่อนหน้าของงานนี้ใช้ไม่ได้แล้ว`
    : `อัปเดตใบงาน ${order.jobNumber}: ${label}\nใช้ปุ่มในการ์ดล่าสุดนี้แทนการ์ดเดิม`;

  // Lazy import: line-staff.service -> repair.service -> order-events -> this file
  const { buildJobCard } = await import('./line-staff.service');
  const card = closed ? null : await buildJobCard(orderId, { id: tech.id, role: tech.role }).catch(() => null);
  await LineStaffApi.push(tech.lineUserId, card ? [{ type: 'text', text }, card] : [{ type: 'text', text }]);
}
