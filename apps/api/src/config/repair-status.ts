import { RepairStatus } from '@homglai/db';
import { AppError } from '../utils/app-error';

export const ALLOWED_TRANSITIONS: Record<RepairStatus, RepairStatus[]> = {
  NEW: ['INSPECTING', 'CANCELLED'],
  INSPECTING: ['WAITING_APPROVAL', 'REPAIRING', 'CANCELLED'],
  WAITING_APPROVAL: ['REPAIRING', 'CANCELLED'],
  REPAIRING: ['WAITING_APPROVAL', 'COMPLETED', 'CANCELLED'],
  COMPLETED: ['DELIVERED', 'REPAIRING'],
  DELIVERED: [],
  CANCELLED: [],
};

export function validateStatusTransition(currentStatus: RepairStatus, targetStatus: RepairStatus): void {
  // D.1(c): Setting same status responds with 409 and writes no log
  if (currentStatus === targetStatus) {
    throw new AppError(409, `Repair order is already in status ${currentStatus}`);
  }

  // D.1(b): INSPECTING and WAITING_APPROVAL cannot be manually set via status endpoint
  if (targetStatus === 'INSPECTING' || targetStatus === 'WAITING_APPROVAL') {
    throw new AppError(
      409,
      `Cannot set status to ${targetStatus} directly. INSPECTING is assigned via technician queue, and WAITING_APPROVAL is triggered by adding quotation items.`
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
