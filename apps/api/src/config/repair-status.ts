import { ItemStatus, RepairStatus } from '@homglai/db';
import { AppError } from '../utils/app-error';

/**
 * Transitions allowed through PATCH /api/repairs/:id/status (manual).
 * NEW -> INSPECTING / WAITING_APPROVAL / REPAIRING happen ONLY through POST /api/repairs/:id/accept
 * (see ACCEPT_TARGETS); returning an order to NEW happens only through the queue
 * (release / technician deactivation), never manually.
 */
export const ALLOWED_TRANSITIONS: Record<RepairStatus, RepairStatus[]> = {
  NEW: ['CANCELLED'],
  INSPECTING: ['WAITING_APPROVAL', 'REPAIRING', 'CANCELLED'],
  WAITING_APPROVAL: ['REPAIRING', 'CANCELLED'],
  REPAIRING: ['WAITING_APPROVAL', 'COMPLETED', 'CANCELLED'],
  COMPLETED: ['DELIVERED', 'REPAIRING'],
  DELIVERED: [],
  CANCELLED: [],
};

/** System-only targets of POST /api/repairs/:id/accept (from NEW). */
export const ACCEPT_TARGETS: RepairStatus[] = ['INSPECTING', 'WAITING_APPROVAL', 'REPAIRING'];

/**
 * Stage an accepted order resumes at. A normal new order has no items -> INSPECTING.
 * An order returned to the pool from a deactivated technician resumes where work stopped:
 * PENDING items -> WAITING_APPROVAL; otherwise APPROVED/COMPLETED items -> REPAIRING; else INSPECTING.
 */
export function resolveAcceptTarget(itemStatuses: ItemStatus[]): RepairStatus {
  if (itemStatuses.includes('PENDING')) return 'WAITING_APPROVAL';
  if (itemStatuses.includes('APPROVED') || itemStatuses.includes('COMPLETED')) return 'REPAIRING';
  return 'INSPECTING';
}

export function validateStatusTransition(currentStatus: RepairStatus, targetStatus: RepairStatus): void {
  // D.1(c): Setting same status responds with 409 and writes no log
  if (currentStatus === targetStatus) {
    throw new AppError(409, `Repair order is already in status ${currentStatus}`);
  }

  // D.1(b): INSPECTING and WAITING_APPROVAL cannot be manually set via status endpoint
  if (targetStatus === 'INSPECTING' || targetStatus === 'WAITING_APPROVAL') {
    throw new AppError(
      409,
      `Cannot set status to ${targetStatus} directly. INSPECTING is reached by accepting the job (POST /api/repairs/:id/accept), and WAITING_APPROVAL is triggered by adding quotation items.`
    );
  }

  const allowed = ALLOWED_TRANSITIONS[currentStatus] || [];
  if (!allowed.includes(targetStatus)) {
    throw new AppError(
      409,
      `Cannot transition status from ${currentStatus} to ${targetStatus}. Allowed target statuses: [${allowed.join(', ')}]`
    );
  }
}
