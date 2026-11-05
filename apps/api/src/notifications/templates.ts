/**
 * Thai message templates for staff notifications — the single place for this wording.
 */
import { MachineLabel, NotificationEvent } from './types';

export interface RenderedNotification {
  title: string;
  body: string;
}

function machineText(machine: MachineLabel): string {
  return `${machine.brand} ${machine.model}`.trim();
}

/** SRS 3.6 wording, e.g. ใบงาน REP-2611-0001 (เครื่อง GEF Aa+) ยังดำเนินการซ่อมอยู่ไหม? ... */
export function progressCheckLine(jobNumber: string, machine: MachineLabel): string {
  return `ใบงาน ${jobNumber} (เครื่อง ${machineText(machine)}) ยังดำเนินการซ่อมอยู่ไหม? กรุณาอัปเดตสถานะ หรือกด 'ยังซ่อมอยู่'`;
}

export function renderNotification(event: NotificationEvent): RenderedNotification {
  switch (event.type) {
    case 'JOB_RESERVED':
      return {
        title: 'มีงานซ่อมใหม่รอคุณกดรับ',
        body: `ใบงาน ${event.jobNumber} (เครื่อง ${machineText(event.machine)}) ถูกจ่ายให้คุณแล้ว กรุณากดรับงาน`,
      };
    case 'ACK_OVERDUE_DIGEST':
      return {
        title: `ช่างยังไม่กดรับงาน ${event.orders.length} ใบงาน`,
        body: event.orders
          .map((o) => `- ใบงาน ${o.jobNumber}: ${o.technicianName} ยังไม่กดรับงาน (รอมาแล้ว ${o.waitingMinutes} นาที)`)
          .join('\n'),
      };
    case 'PROGRESS_CHECK':
      return {
        title:
          event.orders.length === 1
            ? `ใบงาน ${event.orders[0].jobNumber} ยังซ่อมอยู่ไหม?`
            : `กรุณาอัปเดตความคืบหน้า ${event.orders.length} ใบงาน`,
        body: event.orders.map((o) => progressCheckLine(o.jobNumber, o.machine)).join('\n'),
      };
    case 'PROGRESS_UNANSWERED_DIGEST':
      return {
        title: `ช่างไม่ตอบเรื่องความคืบหน้า ${event.orders.length} ใบงาน`,
        body: event.orders
          .map((o) => `- ใบงาน ${o.jobNumber}: ${o.technicianName} ไม่ตอบติดต่อกัน ${o.unansweredCount} รอบ`)
          .join('\n'),
      };
    default: {
      const unreachable: never = event;
      throw new Error(`Unknown notification event: ${JSON.stringify(unreachable)}`);
    }
  }
}
