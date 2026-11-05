/**
 * Buttons the caller may use on one repair order (returned as `allowedActions` with the order detail).
 *
 * The web app shows a button only when its action is listed, so permission rules live in one place
 * (the API). Every rule mirrors the checks the endpoints themselves enforce; the endpoints still
 * check again, so a stale page or a direct API call is rejected the same way.
 */
import { RepairStatus } from '@homglai/db';

export const REPAIR_ACTIONS = [
  'ACCEPT', //               POST  /repairs/:id/accept
  'RELEASE', //              POST  /repairs/:id/release
  'ADD_ITEM', //             POST  /repairs/:id/items
  'RESOLVE_ITEM', //         PATCH /repairs/:id/items/:itemId/status   (phone price confirmation)
  'COMPLETE_ITEM', //        PATCH /repairs/:id/items/:itemId/complete
  'START_REPAIR', //         PATCH /repairs/:id/status REPAIRING        (no quotation needed, e.g. warranty)
  'STILL_WORKING', //        POST  /repairs/:id/still-working
  'COMPLETE', //             POST  /repairs/:id/complete               (outcome REPAIRED)
  'COMPLETE_NOT_REPAIRED', // POST  /repairs/:id/complete               (outcome NOT_REPAIRED)
  'REWORK', //               PATCH /repairs/:id/status COMPLETED -> REPAIRING
  'DELIVER', //              PATCH /repairs/:id/status DELIVERED (optional payment)
  'RECORD_PAYMENT', //       PUT   /repairs/:id/payment
  'EDIT_HELPERS', //         PUT   /repairs/:id/helpers
  'EDIT_INTAKE', //          PATCH /repairs/:id
  'CANCEL', //               PATCH /repairs/:id/status CANCELLED
] as const;
export type RepairAction = (typeof REPAIR_ACTIONS)[number];

const WORK_STATUSES: RepairStatus[] = ['INSPECTING', 'WAITING_APPROVAL', 'REPAIRING'];
const CANCELLABLE: RepairStatus[] = ['NEW', 'INSPECTING', 'WAITING_APPROVAL', 'REPAIRING'];
const CLOSED: RepairStatus[] = ['DELIVERED', 'CANCELLED'];

export function computeAllowedActions(
  user: { id: number; role: string },
  order: {
    status: RepairStatus;
    technicianId: number | null;
    acknowledgedAt: Date | null;
    itemStatuses: string[];
  }
): RepairAction[] {
  const isAdmin = user.role === 'ADMIN';
  const isFrontDesk = user.role === 'RECEPTIONIST' || isAdmin;
  const isOwnerTech = user.role === 'TECHNICIAN' && order.technicianId === user.id;
  const doesWork = isOwnerTech || isAdmin; // the assigned technician, or an ADMIN on their behalf

  const { status } = order;
  const reserved = status === 'NEW' && order.technicianId !== null && order.acknowledgedAt === null;
  const hasPending = order.itemStatuses.includes('PENDING');
  const hasApproved = order.itemStatuses.includes('APPROVED');

  const actions: RepairAction[] = [];
  const add = (condition: boolean, action: RepairAction) => {
    if (condition) actions.push(action);
  };

  add(reserved && doesWork, 'ACCEPT');
  add(reserved && isAdmin, 'RELEASE');
  add(WORK_STATUSES.includes(status) && doesWork, 'ADD_ITEM');
  add(status === 'WAITING_APPROVAL' && hasPending && (doesWork || isFrontDesk), 'RESOLVE_ITEM');
  add(WORK_STATUSES.includes(status) && hasApproved && doesWork, 'COMPLETE_ITEM');
  add((status === 'INSPECTING' || (status === 'WAITING_APPROVAL' && !hasPending)) && doesWork, 'START_REPAIR');
  add(WORK_STATUSES.includes(status) && doesWork, 'STILL_WORKING');
  add(status === 'REPAIRING' && !hasApproved && doesWork, 'COMPLETE');
  add((status === 'INSPECTING' || status === 'REPAIRING') && !hasPending && !hasApproved && doesWork, 'COMPLETE_NOT_REPAIRED');
  add(status === 'COMPLETED' && isFrontDesk, 'REWORK');
  add(status === 'COMPLETED' && isFrontDesk, 'DELIVER');
  add((status === 'COMPLETED' || status === 'DELIVERED') && isFrontDesk, 'RECORD_PAYMENT');
  add(!CLOSED.includes(status) && isFrontDesk, 'EDIT_HELPERS');
  add(!CLOSED.includes(status) && isFrontDesk, 'EDIT_INTAKE');
  add(CANCELLABLE.includes(status) && isFrontDesk, 'CANCEL');
  return actions;
}
