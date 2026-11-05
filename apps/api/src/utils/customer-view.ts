import { Prisma, RepairStatus } from '@homglai/db';

/**
 * Customer fields returned to staff. Since Phase 6 LINE accounts are linked per repair order
 * (OrderLineSubscription); `lineLinked` is derived from the order's subscription count.
 */
export const customerResponseSelect = {
  id: true,
  name: true,
  phone: true,
  address: true,
  createdAt: true,
} satisfies Prisma.CustomerSelect;

/** Add to an order `include` so withPublicCustomer can derive customer.lineLinked. */
export const lineLinkCountInclude = {
  _count: { select: { lineSubscriptions: true } },
} satisfies Prisma.RepairOrderInclude;

type LineLinkCount = { _count?: { lineSubscriptions?: number } };

export function withPublicCustomer<T extends { customer: object } & LineLinkCount>(
  order: T
): Omit<T, 'customer' | '_count'> & { customer: T['customer'] & { lineLinked: boolean } } {
  const { _count, ...rest } = order;
  return {
    ...(rest as Omit<T, 'customer' | '_count'>),
    customer: { ...order.customer, lineLinked: (_count?.lineSubscriptions ?? 0) > 0 },
  };
}

// ---------------------------------------------------------------------------------------------
// Public tracking (SRS 3.2, 5): WHITELIST only — every field is copied explicitly.
// Never add customer, technician, items, prices, notes, images, trackingToken, lineUserId, serial.
// ---------------------------------------------------------------------------------------------

/** Thai status labels shown to customers (SRS 3.2). */
export const STATUS_LABEL_TH: Record<RepairStatus, string> = {
  NEW: 'รับเรื่องแล้ว/รอคิวช่าง',
  INSPECTING: 'กำลังตรวจเช็ค',
  WAITING_APPROVAL: 'รอยืนยันราคา',
  REPAIRING: 'กำลังซ่อม',
  COMPLETED: 'ซ่อมเสร็จ มารับเครื่องได้',
  DELIVERED: 'ส่งมอบแล้ว',
  CANCELLED: 'ยกเลิก',
};

/** COMPLETED closed as "customer declined" (Phase 5b) must not read as "repaired". */
export const NOT_REPAIRED_LABEL_TH = 'ตรวจเช็คแล้ว ไม่ได้ซ่อม มารับเครื่องคืนได้';

export function statusLabelTh(status: RepairStatus, repairOutcome?: string | null): string {
  if (status === 'COMPLETED' && repairOutcome === 'NOT_REPAIRED') return NOT_REPAIRED_LABEL_TH;
  return STATUS_LABEL_TH[status];
}

export interface PublicTrackingView {
  jobNumber: string;
  status: RepairStatus;
  statusLabelTh: string;
  receivedDate: string;
  updatedAt: string;
  machine: { brand: string; model: string };
  timeline: Array<{ status: RepairStatus; statusLabelTh: string; at: string }>;
}

/**
 * Builds the public tracking response. Status logs are reduced to (status, time) and consecutive
 * entries with the same status are collapsed (item / intake / payment logs repeat the status).
 */
export function toPublicTrackingView(order: {
  jobNumber: string;
  status: RepairStatus;
  repairOutcome: string | null;
  receivedDate: Date;
  updatedAt: Date;
  machine: { brand: string; model: string };
  statusLogs: Array<{ status: RepairStatus; createdAt: Date }>;
}): PublicTrackingView {
  const timeline: PublicTrackingView['timeline'] = [];
  for (const log of order.statusLogs) {
    if (timeline.length > 0 && timeline[timeline.length - 1].status === log.status) continue;
    timeline.push({ status: log.status, statusLabelTh: STATUS_LABEL_TH[log.status], at: log.createdAt.toISOString() });
  }
  // The latest COMPLETED step of a job closed without repair uses the "not repaired" label
  if (order.repairOutcome === 'NOT_REPAIRED') {
    for (let i = timeline.length - 1; i >= 0; i--) {
      if (timeline[i].status === 'COMPLETED') {
        timeline[i] = { ...timeline[i], statusLabelTh: NOT_REPAIRED_LABEL_TH };
        break;
      }
    }
  }
  return {
    jobNumber: order.jobNumber,
    status: order.status,
    statusLabelTh: statusLabelTh(order.status, order.repairOutcome),
    receivedDate: order.receivedDate.toISOString().slice(0, 10),
    updatedAt: order.updatedAt.toISOString(),
    machine: { brand: order.machine.brand, model: order.machine.model },
    timeline,
  };
}
