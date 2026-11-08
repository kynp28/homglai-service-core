import prisma from '@homglai/db';
import { getAppConfig } from '../config/env';
import { AppError } from '../utils/app-error';
import { LineApiIdentityVerifier, LineIdentityVerifier, MockLineIdentityVerifier } from './line-identity';
import { RepairService } from './repair.service';
import { ACCEPT_JOB_ACTION, LineStaffApi } from './line-staff-api';

/**
 * LINE for technicians (separate Messaging API channel from the customers' OA):
 *  - an employee links their LINE account once through the technicians' LIFF (POST /api/employees/me/line)
 *  - JOB_RESERVED is pushed to that account with a "รับงานนี้" postback button (LineStaffNotifier)
 *  - the button press arrives at POST /api/webhook/line/tech and accepts the job as that employee
 * Everything is off until LINE_TECH_CHANNEL_ACCESS_TOKEN is set.
 */

export const LineStaffService = {
  /** Verifier for tokens issued by the technicians' LIFF (LINE_TECH_LOGIN_CHANNEL_ID). */
  verifier(): LineIdentityVerifier {
    const config = getAppConfig();
    if (config.lineIdentityVerifier === 'mock' && process.env.NODE_ENV === 'test') {
      return new MockLineIdentityVerifier();
    }
    return new LineApiIdentityVerifier(config.lineTechLoginChannelId);
  },

  /** Links the LINE account behind a technicians'-LIFF access token to an employee. */
  async linkEmployee(employeeId: number, lineAccessToken: unknown) {
    if (typeof lineAccessToken !== 'string' || lineAccessToken.length === 0) {
      throw new AppError(400, 'lineAccessToken is required');
    }
    if (!getAppConfig().lineTechLoginChannelId && getAppConfig().lineIdentityVerifier !== 'mock') {
      throw new AppError(503, 'LINE for technicians is not configured (LINE_TECH_LOGIN_CHANNEL_ID)');
    }
    const lineUserId = await LineStaffService.verifier().verify(lineAccessToken);
    if (!lineUserId) {
      throw new AppError(400, 'LINE token is invalid or was not issued by the technicians\' LIFF');
    }
    const owner = await prisma.employee.findFirst({ where: { lineUserId }, select: { id: true } });
    if (owner && owner.id !== employeeId) {
      throw new AppError(409, 'บัญชี LINE นี้ผูกกับพนักงานคนอื่นแล้ว');
    }
    try {
      await prisma.employee.update({ where: { id: employeeId }, data: { lineUserId } });
    } catch (err: any) {
      if (err?.code === 'P2002') throw new AppError(409, 'บัญชี LINE นี้ผูกกับพนักงานคนอื่นแล้ว');
      throw err;
    }
    return { lineLinked: true };
  },

  async unlinkEmployee(employeeId: number) {
    await prisma.employee.update({ where: { id: employeeId }, data: { lineUserId: null } });
    return { lineLinked: false };
  },

  /** Handles events from the technicians' channel webhook (signature already verified). */
  async processEvents(events: any[]): Promise<void> {
    for (const event of events) {
      try {
        await handleEvent(event);
      } catch (err: any) {
        console.error('[LINE Tech Webhook] event failed:', err?.message || err);
      }
    }
  },
};

function parsePostback(data: unknown): { action: string; orderId: number } | null {
  if (typeof data !== 'string') return null;
  const params = new URLSearchParams(data);
  const orderId = Number(params.get('orderId'));
  const action = params.get('action') ?? '';
  return action && Number.isInteger(orderId) && orderId > 0 ? { action, orderId } : null;
}

const NOT_LINKED_REPLY =
  'บัญชี LINE นี้ยังไม่ได้ผูกกับบัญชีพนักงาน กรุณาเปิดเมนู "ผูกบัญชีพนักงาน" แล้วเข้าสู่ระบบด้วยชื่อผู้ใช้ของคุณก่อน';

async function handleEvent(event: any): Promise<void> {
  const lineUserId: string | undefined = event?.source?.userId;
  const replyToken: string = event?.replyToken ?? '';
  if (!lineUserId) return;

  const employee = await prisma.employee.findFirst({
    where: { lineUserId, isActive: true },
    select: { id: true, role: true, name: true },
  });

  if (event.type === 'follow') {
    await LineStaffApi.reply(
      replyToken,
      employee ? `สวัสดีครับคุณ${employee.name} ระบบจะแจ้งงานซ่อมใหม่ทาง LINE นี้` : NOT_LINKED_REPLY
    );
    return;
  }

  if (event.type !== 'postback') return;
  const postback = parsePostback(event.postback?.data);
  if (!postback || postback.action !== ACCEPT_JOB_ACTION) return;

  if (!employee || (employee.role !== 'TECHNICIAN' && employee.role !== 'ADMIN')) {
    await LineStaffApi.reply(replyToken, NOT_LINKED_REPLY);
    return;
  }

  try {
    const order: any = await RepairService.acceptOrder(postback.orderId, { id: employee.id, role: employee.role });
    const machine = order?.machine ? ` (เครื่อง ${order.machine.brand} ${order.machine.model})` : '';
    await LineStaffApi.reply(
      replyToken,
      `รับงาน ${order?.jobNumber ?? ''}${machine} เรียบร้อยแล้ว สถานะ: กำลังตรวจเช็ค`
    );
  } catch (err: any) {
    const status = err instanceof AppError ? err.statusCode : 500;
    const text =
      status === 403
        ? 'รับงานไม่ได้: งานนี้ไม่ได้จ่ายให้คุณ'
        : status === 404
          ? 'ไม่พบใบงานนี้'
          : status === 409
            ? 'รับงานไม่ได้: งานนี้ถูกรับไปแล้ว หรือถูกปล่อยคืนเข้าคิวแล้ว'
            : 'รับงานไม่สำเร็จ กรุณาลองใหม่ หรือกดรับในหน้าเว็บ';
    if (status >= 500) console.error('[LINE Tech Webhook] accept failed:', err?.message || err);
    await LineStaffApi.reply(replyToken, text);
  }
}
