import prisma from '@homglai/db';
import { getAppConfig, getJwtSecret } from '../config/env';
import { AppError } from '../utils/app-error';
import { LineApiIdentityVerifier, LineIdentityVerifier, MockLineIdentityVerifier } from './line-identity';
import { RepairService } from './repair.service';
import { ACCEPT_JOB_ACTION, LineStaffApi, START_REPAIR_ACTION, STILL_WORKING_ACTION, staffJobUrl } from './line-staff-api';
import { computeAllowedActions } from '../utils/allowed-actions';
import { statusLabelTh } from '../utils/customer-view';
import jwt from 'jsonwebtoken';
import { notifySafely } from '../notifications';
import { runAsLineAction } from './technician-line-updates';

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

  /**
   * POST /api/auth/line — sign in from the technicians' LIFF without a password: the LIFF token is verified
   * with LINE and must belong to a LINE account already linked to an active employee. Returns the same
   * { token, employee } as /api/auth/login (12-hour JWT).
   */
  async loginWithLine(lineAccessToken: unknown) {
    if (typeof lineAccessToken !== 'string' || lineAccessToken.length === 0 || lineAccessToken.length > 2000) {
      throw new AppError(400, 'lineAccessToken is required');
    }
    const lineUserId = await LineStaffService.verifier().verify(lineAccessToken);
    if (!lineUserId) throw new AppError(401, 'LINE token is invalid or was not issued by the technicians\' LIFF');
    const employee = await prisma.employee.findFirst({
      where: { lineUserId, isActive: true },
      select: { id: true, username: true, name: true, role: true, status: true },
    });
    if (!employee) throw new AppError(404, 'LINE_NOT_LINKED');
    const token = jwt.sign({ employeeId: employee.id, role: employee.role }, getJwtSecret(), {
      algorithm: 'HS256',
      expiresIn: '12h',
    });
    return { token, employee };
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
    let name = '';
    try {
      const updated = await prisma.employee.update({ where: { id: employeeId }, data: { lineUserId }, select: { name: true } });
      name = updated.name;
    } catch (err: any) {
      if (err?.code === 'P2002') throw new AppError(409, 'บัญชี LINE นี้ผูกกับพนักงานคนอื่นแล้ว');
      throw err;
    }
    // Confirmation in the chat (also proves the push reaches this account); never fails the link
    const pushed = await LineStaffApi.push(lineUserId, [
      {
        type: 'text',
        text: `ผูก LINE กับบัญชีพนักงาน "${name}" เรียบร้อยแล้ว ✅\nต่อจากนี้งานซ่อมใหม่และการแจ้งเตือนจะส่งมาที่แชตนี้`,
      },
    ]);
    return { lineLinked: true, confirmationSent: pushed };
  },

  /**
   * Self-unlink requires a reason (owner decision 2026-11-08): every active ADMIN is notified with it,
   * so a technician cannot quietly switch off job notifications.
   */
  async unlinkEmployee(employeeId: number, reason: unknown) {
    const text = typeof reason === 'string' ? reason.trim() : '';
    if (text.length < 3 || text.length > 300) {
      throw new AppError(400, 'กรุณาระบุเหตุผลที่ยกเลิกการผูก LINE (3–300 ตัวอักษร)');
    }
    const employee = await prisma.employee.findUnique({ where: { id: employeeId }, select: { name: true, lineUserId: true } });
    if (!employee) throw new AppError(404, 'Employee not found');
    if (employee.lineUserId === null) return { lineLinked: false };
    await prisma.employee.update({ where: { id: employeeId }, data: { lineUserId: null } });
    await notifySafely({ type: 'LINE_UNLINKED', employeeId, employeeName: employee.name, reason: text });
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

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * "Job card": the job's current status with the buttons for its NEXT steps (from computeAllowedActions —
 * the same rules as the web app). One-tap steps are postbacks; steps that need input open the LIFF app.
 * LINE buttons templates hold at most 4 actions: up to 3 steps + "เปิดใบงาน".
 */
export async function buildJobCard(orderId: number, actor: { id: number; role: string }): Promise<Record<string, unknown> | null> {
  const order = await prisma.repairOrder.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      jobNumber: true,
      status: true,
      repairOutcome: true,
      technicianId: true,
      acknowledgedAt: true,
      machine: { select: { brand: true, model: true } },
      repairItems: { select: { status: true } },
    },
  });
  if (!order) return null;
  const allowed = computeAllowedActions(actor, {
    status: order.status,
    technicianId: order.technicianId,
    acknowledgedAt: order.acknowledgedAt,
    itemStatuses: order.repairItems.map((i) => i.status),
  });
  const postback = (label: string, action: string, displayText: string) => ({
    type: 'postback',
    label,
    data: `action=${action}&orderId=${order.id}`,
    displayText,
  });
  const link = (label: string, step?: string) => {
    const uri = staffJobUrl(order.id, step);
    return uri ? { type: 'uri', label, uri } : null;
  };

  const steps: Array<Record<string, unknown> | null> = [];
  if (allowed.includes('ACCEPT')) steps.push(postback('รับงานนี้', ACCEPT_JOB_ACTION, `รับงาน ${order.jobNumber}`));
  if (allowed.includes('ADD_ITEM')) steps.push(link('เพิ่มรายการ/ราคา', 'add-item'));
  if (allowed.includes('START_REPAIR')) steps.push(postback('เริ่มซ่อม', START_REPAIR_ACTION, `เริ่มซ่อม ${order.jobNumber}`));
  if (allowed.includes('COMPLETE_ITEM')) steps.push(link('ทำรายการเสร็จ'));
  if (allowed.includes('COMPLETE')) steps.push(link('ส่งงานซ่อม', 'complete'));
  if (allowed.includes('STILL_WORKING')) steps.push(postback('ยังซ่อมอยู่', STILL_WORKING_ACTION, `ยังซ่อมอยู่ ${order.jobNumber}`));
  const actions = steps.filter((a): a is Record<string, unknown> => a !== null).slice(0, 3);
  const open = link('เปิดใบงาน');
  if (open) actions.push(open);
  if (actions.length === 0) return null;

  const status = statusLabelTh(order.status, order.repairOutcome);
  return {
    type: 'template',
    altText: clip(`${order.jobNumber}: ${status}`, 400),
    template: {
      type: 'buttons',
      title: clip(order.jobNumber, 40),
      text: clip(`${order.machine.brand} ${order.machine.model} · ${status}`, 60),
      actions,
    },
  };
}

/** Thai reply for an AppError from a job action. */
function actionErrorText(err: any, fallback: string): string {
  const status = err instanceof AppError ? err.statusCode : 500;
  if (status >= 500) console.error('[LINE Tech Webhook] action failed:', err?.message || err);
  if (status === 403) return 'ทำรายการไม่ได้: ใบงานนี้ไม่ได้อยู่กับคุณ';
  if (status === 404) return 'ไม่พบใบงานนี้';
  if (status === 409) return 'ทำรายการไม่ได้: ใบงานนี้เปลี่ยนสถานะไปแล้ว (ปุ่มนี้มาจากการ์ดเก่า)';
  return fallback;
}

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
  const known = [ACCEPT_JOB_ACTION, STILL_WORKING_ACTION, START_REPAIR_ACTION];
  if (!postback || !known.includes(postback.action)) return;

  if (!employee || (employee.role !== 'TECHNICIAN' && employee.role !== 'ADMIN')) {
    await LineStaffApi.reply(replyToken, NOT_LINKED_REPLY);
    return;
  }
  const actor = { id: employee.id, role: employee.role };

  let jobNumber = '';
  try {
    await runAsLineAction(postback.orderId, async () => {
      if (postback.action === ACCEPT_JOB_ACTION) {
        const order: any = await RepairService.acceptOrder(postback.orderId, actor);
        jobNumber = order?.jobNumber ?? '';
      } else if (postback.action === STILL_WORKING_ACTION) {
        const order: any = await RepairService.stillWorking(postback.orderId, actor);
        jobNumber = order?.jobNumber ?? '';
      } else {
        const order: any = await RepairService.updateStatus(postback.orderId, 'REPAIRING', actor);
        jobNumber = order?.jobNumber ?? '';
      }
    });
  } catch (err: any) {
    // Usually a tap on an old card: answer with where the job is NOW and, if any, the current buttons
    const errorText = actionErrorText(err, 'ทำรายการไม่สำเร็จ กรุณาลองใหม่ หรือกด "เปิดใบงาน"');
    const current = await currentStatusText(postback.orderId);
    const card = await buildJobCard(postback.orderId, actor).catch(() => null);
    const text = current ? `${errorText}\n${current}` : errorText;
    await LineStaffApi.replyMessages(replyToken, card ? [{ type: 'text', text }, card] : [{ type: 'text', text }]);
    return;
  }

  // Reply with the result (real status, which may skip ahead, e.g. accept -> กำลังซ่อม) + the next-step card
  const current = (await currentStatusText(postback.orderId)) ?? '';
  const done =
    postback.action === ACCEPT_JOB_ACTION
      ? `รับงาน ${jobNumber} เรียบร้อยแล้ว`
      : postback.action === STILL_WORKING_ACTION
        ? `รับทราบ ใบงาน ${jobNumber} ยังซ่อมอยู่ ระบบจะเริ่มนับเวลาเตือนใหม่`
        : `เริ่มซ่อม ${jobNumber} แล้ว`;
  const text = current ? `${done}\n${current}` : done;
  const card = await buildJobCard(postback.orderId, actor).catch(() => null);
  await LineStaffApi.replyMessages(replyToken, card ? [{ type: 'text', text }, card] : [{ type: 'text', text }]);
}

async function currentStatusText(orderId: number): Promise<string | null> {
  const order = await prisma.repairOrder
    .findUnique({ where: { id: orderId }, select: { jobNumber: true, status: true, repairOutcome: true } })
    .catch(() => null);
  return order ? `สถานะตอนนี้: ${statusLabelTh(order.status, order.repairOutcome)}` : null;
}
