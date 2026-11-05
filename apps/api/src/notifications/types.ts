/**
 * Staff notification events (SRS 3.3, 3.6). Discriminated by `type`.
 * Events never carry customer personal data (name / phone / address) — only job and machine labels.
 */
export interface MachineLabel {
  brand: string;
  model: string;
}

/** A job was reserved for a technician and is waiting for them to accept it (to: that technician). */
export interface JobReservedEvent {
  type: 'JOB_RESERVED';
  technicianId: number;
  repairOrderId: number;
  jobNumber: string;
  machine: MachineLabel;
}

/** Technicians have not accepted reserved jobs in time (to: every active ADMIN). */
export interface AckOverdueDigestEvent {
  type: 'ACK_OVERDUE_DIGEST';
  orders: Array<{
    repairOrderId: number;
    jobNumber: string;
    technicianName: string;
    waitingMinutes: number;
  }>;
}

/** "Are you still repairing?" for one or more idle jobs, combined into one message (to: that technician). */
export interface ProgressCheckEvent {
  type: 'PROGRESS_CHECK';
  technicianId: number;
  orders: Array<{
    repairOrderId: number;
    jobNumber: string;
    machine: MachineLabel;
  }>;
}

/** Technicians did not answer progress checks N times (to: every active ADMIN). */
export interface ProgressUnansweredDigestEvent {
  type: 'PROGRESS_UNANSWERED_DIGEST';
  orders: Array<{
    repairOrderId: number;
    jobNumber: string;
    technicianName: string;
    unansweredCount: number;
  }>;
}

export type NotificationEvent =
  | JobReservedEvent
  | AckOverdueDigestEvent
  | ProgressCheckEvent
  | ProgressUnansweredDigestEvent;

export type NotificationType = NotificationEvent['type'];

export interface NotifyResult {
  /** Number of recipients the notification was delivered to */
  delivered: number;
}

/** Delivery channel for staff notifications (DB inbox today; LINE for staff later). */
export interface Notifier {
  notify(event: NotificationEvent): Promise<NotifyResult>;
}
