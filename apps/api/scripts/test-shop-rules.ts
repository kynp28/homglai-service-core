/**
 * Phase 5b tests (owner decisions 2026-11-05):
 *  1. Job-number counter: concurrent intakes get contiguous, unique numbers; counter resyncs after a collision
 *  2. Shop holidays API
 *  3. Technician weekly day off + holidays pause needsProgressUpdate timers
 *  4. "Not repaired" completion (POST /complete outcome NOT_REPAIRED)
 *  5. Payment record at / after delivery (record only, warnings)
 *  6. allowedActions (buttons per role / status / ownership) + technicians cannot deliver or cancel
 *
 * Runs against the API started by test-runner.js (port 4000) on a *_test database.
 */
import axios, { AxiosResponse } from 'axios';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import prisma from '@homglai/db';
import { assertSafeDatabaseUrl } from '../src/utils/test-safety';
import { getJwtSecret } from '../src/config/env';
import { getBangkokDateOnly } from '../src/utils/date';
import { jobNumberPrefix, formatJobNumber } from '../src/utils/job-number';
import { computeAllowedActions } from '../src/utils/allowed-actions';

type Headers = Record<string, string>;

const API = 'http://localhost:4000/api';
const ADMIN = 1;
const RECEP = 2;
const TECHS = [3, 4, 5, 6, 7];
const DAY_MS = 86_400_000;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}
function eq(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    throw new Error(`ASSERTION FAILED: ${message}\n  Expected: ${JSON.stringify(expected)}\n  Actual:   ${JSON.stringify(actual)}`);
  }
}
function pass(message: string): void {
  console.log(`  [PASS] ${message}`);
}
async function expectStatus(status: number, label: string, call: () => Promise<AxiosResponse>): Promise<any> {
  try {
    const res = await call();
    throw new Error(`ASSERTION FAILED: ${label} — expected HTTP ${status}, got ${res.status}`);
  } catch (err: any) {
    if (!err.response) throw err;
    if (err.response.status !== status) {
      throw new Error(`ASSERTION FAILED: ${label} — expected HTTP ${status}, got ${err.response.status}: ${JSON.stringify(err.response.data)}`);
    }
    pass(`${label} -> ${status}`);
    return err.response.data;
  }
}
async function tokenFor(id: number): Promise<Headers> {
  const e = await prisma.employee.findUniqueOrThrow({ where: { id } });
  return {
    Authorization: `Bearer ${jwt.sign({ employeeId: e.id, role: e.role }, getJwtSecret(), { algorithm: 'HS256', expiresIn: '30m' })}`,
  };
}
const order = (id: number) => prisma.repairOrder.findUniqueOrThrow({ where: { id } });
const tech = (id: number) => prisma.employee.findUniqueOrThrow({ where: { id } });
const dateKey = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (key: string, n: number) => dateKey(new Date(new Date(`${key}T00:00:00.000Z`).getTime() + n * DAY_MS));

async function resetWorld() {
  await prisma.notification.deleteMany({});
  await prisma.repairOrderImage.deleteMany({});
  await prisma.orderLineSubscription.deleteMany({});
  await prisma.repairOrderHelper.deleteMany({});
  await prisma.statusLog.deleteMany({});
  await prisma.repairItem.deleteMany({});
  await prisma.repairOrderSymptom.deleteMany({});
  await prisma.repairOrder.deleteMany({});
  await prisma.shopHoliday.deleteMany({});
  await prisma.employee.updateMany({
    where: { id: { in: TECHS } },
    data: { status: 'OFFLINE', isActive: true, role: 'TECHNICIAN', availableSince: null, weeklyDayOff: null },
  });
}

async function main() {
  assertSafeDatabaseUrl();
  console.log('==================================================================');
  console.log('PHASE 5b: JOB NUMBERS / HOLIDAYS / DAY OFF / NOT REPAIRED / PAYMENT');
  console.log('==================================================================\n');

  const admin = await tokenFor(ADMIN);
  const recep = await tokenFor(RECEP);
  const t: Record<number, Headers> = {};
  for (const id of TECHS) t[id] = await tokenFor(id);

  await resetWorld();
  const customer = await prisma.customer.create({ data: { name: 'Shop Rules Customer', phone: `0853${String(Date.now()).slice(-6)}` } });
  const machine = await prisma.machine.create({ data: { brand: 'LEHEHE', model: 'LH-01', customerId: customer.id } });
  let seq = 0;
  const mk = (status: any, technicianId: number | null, extra: any = {}) =>
    prisma.repairOrder.create({
      data: {
        jobNumber: `REP-P5B-${String(++seq).padStart(4, '0')}`,
        trackingToken: crypto.randomBytes(24).toString('base64url'),
        status,
        receivedDate: getBangkokDateOnly(),
        customerId: customer.id,
        machineId: machine.id,
        technicianId,
        ...(technicianId ? { assignedAt: new Date(Date.now() - 3 * DAY_MS), acknowledgedAt: new Date(Date.now() - 3 * DAY_MS) } : {}),
        lastActivityAt: new Date(),
        ...extra,
      },
    });
  const addItem = (repairOrderId: number, name: string, unitPrice: number, status: any, itemType: any = 'PART') =>
    prisma.repairItem.create({ data: { repairOrderId, name, unitPrice, status, itemType } });

  try {
    // ---------------------------------------------------------------
    // 1. Job-number counter
    // ---------------------------------------------------------------
    console.log('[Test 1] Job numbers from the counter table...');
    const prefix = jobNumberPrefix(new Date());
    const before = await prisma.jobNumberSequence.findUnique({ where: { prefix } });
    const start = before?.lastSeq ?? 0;
    const N = 25;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        axios.post(
          `${API}/repairs`,
          {
            customer: { name: `Seq Customer ${i}`, phone: `0862${String(Date.now() + i).slice(-6)}` },
            machine: { brand: 'GEF', model: 'Aa+' },
            symptomIds: [1],
          },
          { headers: admin }
        )
      )
    );
    const numbers = results.map((r) => r.data.data.jobNumber as string).sort();
    const expected = Array.from({ length: N }, (_, i) => formatJobNumber(prefix, start + i + 1));
    eq(JSON.stringify(numbers), JSON.stringify(expected), `${N} concurrent intakes got ${prefix}-${start + 1}..${start + N}, no gap, no duplicate`);
    eq((await prisma.jobNumberSequence.findUniqueOrThrow({ where: { prefix } })).lastSeq, start + N, 'counter advanced by exactly N');
    pass(`${N} concurrent intakes: unique, contiguous job numbers (no collision, no retry)`);

    // A number inserted by hand ahead of the counter: the next intake collides once, resyncs, succeeds
    const handNumber = formatJobNumber(prefix, start + N + 1);
    await mk('NEW', null, { jobNumber: handNumber });
    const afterHand = await axios.post(
      `${API}/repairs`,
      { customer: { name: 'Seq Customer X', phone: `0863${String(Date.now()).slice(-6)}` }, machine: { brand: 'GEF', model: 'Aa+' }, symptomIds: [1] },
      { headers: admin }
    );
    eq(afterHand.data.data.jobNumber, formatJobNumber(prefix, start + N + 2), 'counter resynced past the hand-inserted number');
    pass('Counter behind stored data recovers automatically');

    await resetWorld();

    // ---------------------------------------------------------------
    // 2. Holidays API
    // ---------------------------------------------------------------
    console.log('\n[Test 2] Shop holidays API...');
    const today = dateKey(getBangkokDateOnly());
    const d30 = addDays(today, 30);
    const created = await axios.post(`${API}/holidays`, { date: d30, toDate: addDays(today, 32), name: 'สงกรานต์' }, { headers: admin });
    eq(created.status, 201, 'range created');
    eq(JSON.stringify(created.data.data.map((h: any) => dateKey(new Date(h.date)))), JSON.stringify([d30, addDays(today, 31), addDays(today, 32)]), '3 consecutive days stored');
    const dup = await expectStatus(409, 'overlapping range', () =>
      axios.post(`${API}/holidays`, { date: addDays(today, 32), toDate: addDays(today, 33), name: 'ซ้ำ' }, { headers: admin })
    );
    eq(JSON.stringify(dup.details?.existingDates), JSON.stringify([addDays(today, 32)]), '409 lists the existing date');
    eq(await prisma.shopHoliday.count(), 3, 'nothing stored by the rejected range');
    await expectStatus(400, 'toDate before date', () => axios.post(`${API}/holidays`, { date: d30, toDate: today, name: 'x' }, { headers: admin }));
    await expectStatus(400, 'range longer than 31 days', () =>
      axios.post(`${API}/holidays`, { date: addDays(today, 100), toDate: addDays(today, 131), name: 'x' }, { headers: admin })
    );
    await expectStatus(400, 'not a real date', () => axios.post(`${API}/holidays`, { date: '2027-02-30', name: 'x' }, { headers: admin }));
    await expectStatus(400, 'empty name', () => axios.post(`${API}/holidays`, { date: addDays(today, 60), name: ' ' }, { headers: admin }));
    await expectStatus(400, 'unknown field', () => axios.post(`${API}/holidays`, { date: addDays(today, 60), name: 'x', repeat: true }, { headers: admin }));
    await expectStatus(403, 'RECEPTIONIST adds a holiday', () => axios.post(`${API}/holidays`, { date: addDays(today, 60), name: 'x' }, { headers: recep }));
    await expectStatus(403, 'TECHNICIAN adds a holiday', () => axios.post(`${API}/holidays`, { date: addDays(today, 60), name: 'x' }, { headers: t[3] }));
    const listed = (await axios.get(`${API}/holidays?from=${addDays(today, 31)}`, { headers: t[3] })).data.data;
    eq(listed.length, 2, 'TECHNICIAN can list; from filter applied');
    await expectStatus(400, 'list with bad from', () => axios.get(`${API}/holidays?from=tomorrow`, { headers: admin }));
    await expectStatus(403, 'RECEPTIONIST deletes', () => axios.delete(`${API}/holidays/${listed[0].id}`, { headers: recep }));
    await axios.delete(`${API}/holidays/${listed[0].id}`, { headers: admin });
    await expectStatus(404, 'delete twice', () => axios.delete(`${API}/holidays/${listed[0].id}`, { headers: admin }));
    eq(await prisma.shopHoliday.count(), 2, 'one holiday removed');
    pass('ADMIN manages holidays; everyone can read them');

    // ---------------------------------------------------------------
    // 3. Day off + holidays pause the idle timer
    // ---------------------------------------------------------------
    console.log('\n[Test 3] Weekly day off and holidays pause needsProgressUpdate...');
    await expectStatus(400, 'weeklyDayOff 7', () => axios.patch(`${API}/employees/4`, { weeklyDayOff: 7 }, { headers: admin }));
    await expectStatus(400, 'weeklyDayOff 1.5', () => axios.patch(`${API}/employees/4`, { weeklyDayOff: 1.5 }, { headers: admin }));
    await expectStatus(403, 'TECHNICIAN sets own day off', () => axios.patch(`${API}/employees/4`, { weeklyDayOff: 2 }, { headers: t[4] }));

    const todayMidnightUtc = getBangkokDateOnly(); // 00:00 UTC of today's Bangkok date
    const yesterday0900 = new Date(todayMidnightUtc.getTime() - DAY_MS + 2 * 60 * 60_000); // 09:00 Bangkok yesterday
    const yesterdayWeekday = new Date(todayMidnightUtc.getTime() - DAY_MS).getUTCDay();

    const setOff = await axios.patch(`${API}/employees/4`, { weeklyDayOff: yesterdayWeekday }, { headers: admin });
    eq(setOff.data.data.weeklyDayOff, yesterdayWeekday, 'PATCH returns weeklyDayOff');
    const empList = (await axios.get(`${API}/employees`, { headers: admin })).data.data;
    eq(empList.find((e: any) => e.id === 4).weeklyDayOff, yesterdayWeekday, 'employee list shows weeklyDayOff');

    await axios.post(`${API}/holidays`, { date: today, name: 'ปิดร้านวันนี้' }, { headers: admin });
    await prisma.employee.updateMany({ where: { id: { in: [4, 5] } }, data: { status: 'BUSY' } });
    const A = await mk('REPAIRING', 4, { lastActivityAt: yesterday0900 }); // yesterday = tech4's day off, today = holiday
    const B = await mk('REPAIRING', 5, { lastActivityAt: yesterday0900 }); // only today is closed
    const need = (await axios.get(`${API}/repairs?needsProgressUpdate=true&limit=100`, { headers: admin })).data.data.orders;
    eq(JSON.stringify(need.map((o: any) => o.id)), JSON.stringify([B.id]), 'job of the technician on day off is not idle');
    eq(need[0].idleBusinessMinutes, 510, 'yesterday 09:00-17:30 counted, today (holiday) not');
    const t4need = (await axios.get(`${API}/repairs?needsProgressUpdate=true`, { headers: t[4] })).data.data.orders;
    eq(t4need.length, 0, 'technician on day off sees nothing overdue');

    const cleared = await axios.patch(`${API}/employees/4`, { weeklyDayOff: null }, { headers: admin });
    eq(cleared.data.data.weeklyDayOff, null, 'weeklyDayOff cleared with null');
    const need2 = (await axios.get(`${API}/repairs?needsProgressUpdate=true&limit=100`, { headers: admin })).data.data.orders;
    eq(JSON.stringify(need2.map((o: any) => o.id).sort()), JSON.stringify([A.id, B.id].sort()), 'without the day off both jobs are idle');
    pass('Holiday and the technician weekly day off are not counted as idle time');

    await resetWorld();

    // ---------------------------------------------------------------
    // 4. Not repaired
    // ---------------------------------------------------------------
    console.log('\n[Test 4] Closing a job as NOT_REPAIRED (customer declined)...');
    await prisma.employee.updateMany({ where: { id: { in: [3, 4, 5] } }, data: { status: 'BUSY' } });
    const declined = await mk('INSPECTING', 3);
    await addItem(declined.id, 'เปลี่ยนบอร์ด', 2500, 'REJECTED');
    const inspecting = await mk('INSPECTING', 4);
    const waiting = await mk('WAITING_APPROVAL', 5);
    await addItem(waiting.id, 'ปั๊ม', 900, 'PENDING');

    await expectStatus(409, 'REPAIRED from INSPECTING', () =>
      axios.post(`${API}/repairs/${inspecting.id}/complete`, { completionSummary: 'x' }, { headers: t[4] })
    );
    await expectStatus(409, 'NOT_REPAIRED with a PENDING quotation', () =>
      axios.post(`${API}/repairs/${waiting.id}/complete`, { completionSummary: 'x', outcome: 'NOT_REPAIRED' }, { headers: t[5] })
    );
    await expectStatus(400, 'unknown outcome', () =>
      axios.post(`${API}/repairs/${declined.id}/complete`, { completionSummary: 'x', outcome: 'BROKEN' }, { headers: t[3] })
    );
    await expectStatus(403, 'another technician closes it', () =>
      axios.post(`${API}/repairs/${declined.id}/complete`, { completionSummary: 'x', outcome: 'NOT_REPAIRED' }, { headers: t[4] })
    );
    const nr = await axios.post(
      `${API}/repairs/${declined.id}/complete`,
      { completionSummary: 'ลูกค้าไม่ซ่อม ราคาบอร์ดสูงเกินไป', outcome: 'NOT_REPAIRED' },
      { headers: t[3] }
    );
    eq(nr.data.data.status, 'COMPLETED', 'declined job COMPLETED');
    eq(nr.data.data.repairOutcome, 'NOT_REPAIRED', 'repairOutcome NOT_REPAIRED');
    eq(nr.data.data.payment.payableAmount, '0.00', 'nothing payable (all items rejected)');
    eq(nr.data.data.payment.warning, null, 'no payment warning when nothing is payable');
    eq((await tech(3)).status, 'AVAILABLE', 'technician freed');
    const nrLog = await prisma.statusLog.findFirst({ where: { repairOrderId: declined.id, status: 'COMPLETED' } });
    assert(nrLog?.note?.includes('ไม่ซ่อม'), 'log says closed without repair');

    // Inspection fee approved by phone -> REPAIRING -> fee item done -> NOT_REPAIRED from REPAIRING
    const feeJob = await mk('REPAIRING', 5);
    await addItem(feeJob.id, 'ค่าตรวจเช็ค', 300, 'COMPLETED', 'SERVICE_FEE');
    await prisma.repairOrder.update({ where: { id: waiting.id }, data: { technicianId: 6 } }); // tech5 holds only feeJob now
    const feeDone = await axios.post(
      `${API}/repairs/${feeJob.id}/complete`,
      { completionSummary: 'ตรวจเช็คแล้ว ลูกค้าไม่ซ่อม เก็บค่าตรวจ', outcome: 'NOT_REPAIRED' },
      { headers: t[5] }
    );
    eq(feeDone.data.data.repairOutcome, 'NOT_REPAIRED', 'NOT_REPAIRED from REPAIRING');
    eq(feeDone.data.data.payment.payableAmount, '300.00', 'inspection fee is payable');

    // Normal completion stores REPAIRED
    await prisma.employee.update({ where: { id: 6 }, data: { status: 'BUSY' } });
    const normal = await mk('REPAIRING', 6);
    await prisma.repairOrder.update({ where: { id: waiting.id }, data: { technicianId: 7 } });
    const normalDone = await axios.post(`${API}/repairs/${normal.id}/complete`, { completionSummary: 'ซ่อมเสร็จ' }, { headers: t[6] });
    eq(normalDone.data.data.repairOutcome, 'REPAIRED', 'default outcome REPAIRED');

    // Rework of a NOT_REPAIRED job (customer changed their mind). tech3 is AVAILABLE again:
    // the job is reserved for the original technician, who is notified and must accept it.
    await prisma.notification.deleteMany({ where: { recipientId: 3 } });
    await expectStatus(403, 'TECHNICIAN requests rework of own job', () =>
      axios.patch(`${API}/repairs/${declined.id}/status`, { status: 'REPAIRING' }, { headers: t[3] })
    );
    eq((await order(declined.id)).status, 'COMPLETED', 'unchanged after 403');
    // Front desk requests the rework (owner decision 2026-11-05)
    const rework = await axios.patch(`${API}/repairs/${declined.id}/status`, { status: 'REPAIRING', note: 'ลูกค้าเปลี่ยนใจ' }, { headers: recep });
    eq(rework.data.data.status, 'NEW', 'rework waits for acceptance (NEW, reserved)');
    const reserved = await order(declined.id);
    eq(reserved.technicianId, 3, 'reserved for the original technician');
    assert(reserved.assignedAt && reserved.acknowledgedAt === null, 'assignedAt set, not yet acknowledged');
    eq(reserved.repairOutcome, null, 'rework clears repairOutcome');
    eq((await tech(3)).status, 'RESERVED', 'original technician RESERVED (not silently BUSY)');
    const reworkNote = await prisma.notification.findFirst({ where: { recipientId: 3, type: 'JOB_RESERVED', repairOrderId: declined.id } });
    eq(reworkNote?.title, 'มีงานตีกลับซ่อมใหม่รอคุณกดรับ', 'technician notified that it is a rework');
    const reworkLog = await prisma.statusLog.findFirst({ where: { repairOrderId: declined.id, status: 'NEW' }, orderBy: { id: 'desc' } });
    assert(reworkLog?.note?.includes('จองให้ช่างเดิม') && reworkLog.note.includes('ลูกค้าเปลี่ยนใจ'), 'log explains the reservation');
    eq(reworkLog?.changedById, RECEP, 'log records the receptionist who requested it');
    const acceptedRework = await axios.post(`${API}/repairs/${declined.id}/accept`, {}, { headers: t[3] });
    eq(acceptedRework.data.data.status, 'INSPECTING', 'no approved item -> resumes at INSPECTING for a new quotation');
    eq((await tech(3)).status, 'BUSY', 'technician BUSY after accepting');
    pass('NOT_REPAIRED closes INSPECTING/REPAIRING jobs; REPAIRED stays the default; rework requested by the front desk, reserved, notified and accepted');

    // ---------------------------------------------------------------
    // 5. Payment
    // ---------------------------------------------------------------
    console.log('\n[Test 5] Payment record at / after delivery...');
    // feeJob COMPLETED, payable 300
    await expectStatus(400, 'payment with a status other than DELIVERED', () =>
      axios.patch(`${API}/repairs/${inspecting.id}/status`, { status: 'CANCELLED', payment: { amount: 1, method: 'CASH' } }, { headers: admin })
    );
    eq((await order(inspecting.id)).status, 'INSPECTING', 'order unchanged by the 400');
    await expectStatus(400, 'negative amount at delivery', () =>
      axios.patch(`${API}/repairs/${feeJob.id}/status`, { status: 'DELIVERED', payment: { amount: -1, method: 'CASH' } }, { headers: recep })
    );
    const delivered = await axios.patch(
      `${API}/repairs/${feeJob.id}/status`,
      { status: 'DELIVERED', payment: { amount: 300, method: 'CASH' } },
      { headers: recep }
    );
    eq(delivered.data.data.status, 'DELIVERED', 'delivered');
    eq(delivered.data.data.payment.status, 'MATCHED', 'payment matches payable');
    eq(delivered.data.data.payment.paidAmount, '300.00', 'paidAmount 2 decimals');
    eq(delivered.data.data.payment.warning, null, 'no warning');
    const feeRow = await order(feeJob.id);
    eq(feeRow.paymentMethod, 'CASH', 'method stored');
    eq(feeRow.paymentRecordedById, RECEP, 'recorded by receptionist');
    assert(feeRow.paidAt, 'paidAt stored');
    const payLog = await prisma.statusLog.findFirst({ where: { repairOrderId: feeJob.id, note: { contains: 'บันทึกการรับเงิน 300.00' } } });
    assert(payLog?.changedById === RECEP, 'payment written to the log');

    // Normal job: payable 845.30, delivered without payment -> warning, not blocked
    await addItem(normal.id, 'ปั๊มน้ำ', 545.3, 'COMPLETED');
    await addItem(normal.id, 'ค่าแรง', 300, 'COMPLETED', 'LABOR_HOURS');
    await addItem(normal.id, 'ซีล (ลูกค้าไม่เอา)', 100, 'REJECTED');
    const noPay = await axios.patch(`${API}/repairs/${normal.id}/status`, { status: 'DELIVERED' }, { headers: recep });
    eq(noPay.data.data.status, 'DELIVERED', 'delivery not blocked without payment');
    eq(noPay.data.data.payment.status, 'NOT_RECORDED', 'NOT_RECORDED');
    eq(noPay.data.data.payment.payableAmount, '845.30', 'payable excludes REJECTED items');
    eq(noPay.data.data.payment.warning?.code, 'PAYMENT_NOT_RECORDED', 'warning code');
    assert(noPay.data.data.payment.warning?.message.includes('845.30'), 'Thai warning names the payable amount');

    const payUrl = `${API}/repairs/${normal.id}/payment`;
    await expectStatus(403, 'TECHNICIAN records payment', () => axios.put(payUrl, { amount: 845.3, method: 'CASH' }, { headers: t[6] }));
    await expectStatus(400, 'amount with 3 decimals', () => axios.put(payUrl, { amount: 1.005, method: 'CASH' }, { headers: recep }));
    await expectStatus(400, 'unknown method', () => axios.put(payUrl, { amount: 10, method: 'CARD' }, { headers: recep }));
    await expectStatus(400, 'amount as text', () => axios.put(payUrl, { amount: '845.30', method: 'CASH' }, { headers: recep }));
    await expectStatus(400, 'unknown field', () => axios.put(payUrl, { amount: 10, method: 'CASH', paidAt: '2026-01-01' }, { headers: recep }));
    await expectStatus(400, 'note over 500 characters', () => axios.put(payUrl, { amount: 10, method: 'CASH', note: 'x'.repeat(501) }, { headers: recep }));
    await expectStatus(409, 'payment on an INSPECTING order', () =>
      axios.put(`${API}/repairs/${inspecting.id}/payment`, { amount: 10, method: 'CASH' }, { headers: admin })
    );
    await expectStatus(404, 'payment on unknown order', () => axios.put(`${API}/repairs/999999/payment`, { amount: 10, method: 'CASH' }, { headers: admin }));

    const diff = await axios.put(payUrl, { amount: 800, method: 'TRANSFER', note: 'ลดให้ 45.30' }, { headers: recep });
    eq(diff.data.data.payment.status, 'DIFFERENT', 'different amount flagged');
    eq(diff.data.data.payment.warning?.code, 'PAYMENT_AMOUNT_DIFFERS', 'warning code');
    eq(diff.data.data.payment.method, 'TRANSFER', 'method in detail');
    eq(diff.data.data.payment.note, 'ลดให้ 45.30', 'note in detail');
    eq(diff.data.data.payment.recordedBy?.id, RECEP, 'recordedBy in detail');
    const fixed = await axios.put(payUrl, { amount: 845.3, method: 'TRANSFER' }, { headers: admin });
    eq(fixed.data.data.payment.status, 'MATCHED', 'corrected by ADMIN');
    eq(fixed.data.data.payment.note, null, 'note cleared when not sent');
    eq(
      await prisma.statusLog.count({ where: { repairOrderId: normal.id, note: { contains: 'แก้ไขการรับเงิน' } } }),
      1,
      'correction logged as an update'
    );
    const techView = (await axios.get(`${API}/repairs/${declined.id}`, { headers: t[3] })).data.data;
    assert(techView.payment && techView.payment.status === 'NOT_RECORDED', 'detail always carries the payment summary');
    pass('Payment recorded at delivery or later; mismatch / missing payment only warns');

    // ---------------------------------------------------------------
    // 6. allowedActions
    // ---------------------------------------------------------------
    console.log('\n[Test 6] allowedActions...');
    const acts = (role: string, id: number, status: any, technicianId: number | null, items: string[] = [], acknowledged = true) =>
      computeAllowedActions({ id, role }, { status, technicianId, acknowledgedAt: acknowledged ? new Date() : null, itemStatuses: items }).join(',');
    const cases: Array<[string, string, string]> = [
      ['reserved NEW, owner technician', acts('TECHNICIAN', 3, 'NEW', 3, [], false), 'ACCEPT'],
      ['reserved NEW, other technician', acts('TECHNICIAN', 4, 'NEW', 3, [], false), ''],
      ['reserved NEW, ADMIN', acts('ADMIN', 1, 'NEW', 3, [], false), 'ACCEPT,RELEASE,EDIT_HELPERS,EDIT_INTAKE,CANCEL'],
      ['reserved NEW, RECEPTIONIST', acts('RECEPTIONIST', 2, 'NEW', 3, [], false), 'EDIT_HELPERS,EDIT_INTAKE,CANCEL'],
      ['pool NEW, ADMIN', acts('ADMIN', 1, 'NEW', null, [], false), 'EDIT_HELPERS,EDIT_INTAKE,CANCEL'],
      ['INSPECTING, owner technician', acts('TECHNICIAN', 3, 'INSPECTING', 3), 'ADD_ITEM,START_REPAIR,STILL_WORKING,COMPLETE_NOT_REPAIRED'],
      ['WAITING_APPROVAL, owner technician', acts('TECHNICIAN', 3, 'WAITING_APPROVAL', 3, ['PENDING']), 'ADD_ITEM,RESOLVE_ITEM,STILL_WORKING'],
      ['WAITING_APPROVAL, RECEPTIONIST', acts('RECEPTIONIST', 2, 'WAITING_APPROVAL', 3, ['PENDING']), 'RESOLVE_ITEM,EDIT_HELPERS,EDIT_INTAKE,CANCEL'],
      ['REPAIRING with approved work left', acts('TECHNICIAN', 3, 'REPAIRING', 3, ['APPROVED', 'REJECTED']), 'ADD_ITEM,COMPLETE_ITEM,STILL_WORKING'],
      ['REPAIRING, all work done', acts('TECHNICIAN', 3, 'REPAIRING', 3, ['COMPLETED']), 'ADD_ITEM,STILL_WORKING,COMPLETE,COMPLETE_NOT_REPAIRED'],
      ['REPAIRING, other technician', acts('TECHNICIAN', 4, 'REPAIRING', 3, ['COMPLETED']), ''],
      ['COMPLETED, owner technician', acts('TECHNICIAN', 3, 'COMPLETED', 3), ''],
      ['COMPLETED, RECEPTIONIST', acts('RECEPTIONIST', 2, 'COMPLETED', 3), 'REWORK,DELIVER,RECORD_PAYMENT,EDIT_HELPERS,EDIT_INTAKE'],
      ['DELIVERED, RECEPTIONIST', acts('RECEPTIONIST', 2, 'DELIVERED', 3), 'RECORD_PAYMENT'],
      ['DELIVERED, owner technician', acts('TECHNICIAN', 3, 'DELIVERED', 3), ''],
      ['CANCELLED, ADMIN', acts('ADMIN', 1, 'CANCELLED', null), ''],
    ];
    for (const [label, actual, expected] of cases) eq(actual, expected, `allowedActions: ${label}`);
    pass(`${cases.length} role / status / ownership combinations`);

    eq(
      techView.allowedActions.join(','),
      'ADD_ITEM,START_REPAIR,STILL_WORKING,COMPLETE_NOT_REPAIRED',
      'GET detail returns allowedActions for the caller (reworked job back at INSPECTING)'
    );
    const recepView = (await axios.get(`${API}/repairs/${normal.id}`, { headers: recep })).data.data;
    eq(recepView.allowedActions.join(','), 'RECORD_PAYMENT', 'RECEPTIONIST on a DELIVERED job');

    // Technicians no longer deliver or cancel (front-desk decisions, matching allowedActions)
    await prisma.employee.update({ where: { id: 5 }, data: { status: 'BUSY' } });
    const ownDone = await mk('COMPLETED', 5, { completionSummary: 'x', repairOutcome: 'REPAIRED' });
    await expectStatus(403, 'TECHNICIAN delivers own COMPLETED job', () =>
      axios.patch(`${API}/repairs/${ownDone.id}/status`, { status: 'DELIVERED' }, { headers: t[5] })
    );
    await expectStatus(403, 'TECHNICIAN cancels own job', () =>
      axios.patch(`${API}/repairs/${inspecting.id}/status`, { status: 'CANCELLED' }, { headers: t[4] })
    );
    eq((await order(ownDone.id)).status, 'COMPLETED', 'unchanged after 403');
    pass('allowedActions matches what the endpoints accept');

    console.log('\n==================================================================');
    console.log('PHASE 5b SHOP RULES TESTS PASSED');
    console.log('==================================================================\n');
  } finally {
    await prisma.shopHoliday.deleteMany({});
    await prisma.employee.updateMany({
      where: { id: { in: TECHS } },
      data: { status: 'AVAILABLE', isActive: true, role: 'TECHNICIAN', availableSince: null, weeklyDayOff: null },
    });
    await prisma.$disconnect();
  }
}

main().catch(async (err) => {
  console.error('\nPhase 5b Test Failed:', err.response?.data || err.message);
  await prisma.$disconnect();
  process.exit(1);
});
