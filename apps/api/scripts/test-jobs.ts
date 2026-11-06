/**
 * Phase 8 tests: background jobs driven by runJobsOnce(now) with simulated times (no waiting).
 * The API under test runs with JOBS_ENABLED=false; this script runs the rounds itself.
 */
import crypto from 'crypto';
import prisma from '@homglai/db';
import { assertSafeDatabaseUrl } from '../src/utils/test-safety';
import { getAppConfig } from '../src/config/env';
import { getBangkokDateOnly } from '../src/utils/date';
import { resetJobState, runJobsOnce } from '../src/jobs/run-jobs';
import { RepairService } from '../src/services/repair.service';

const TECHS = [3, 4, 5, 6, 7];
const ADMIN = 1;
const MIN = 60_000;

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

/** Bangkok wall-clock time, e.g. bkk('2026-12-01', '09:00'). */
const bkk = (day: string, hm: string) => new Date(`${day}T${hm}:00+07:00`);
const techNotes = (technicianId: number) =>
  prisma.notification.findMany({ where: { recipientId: technicianId, type: 'PROGRESS_CHECK' }, orderBy: { id: 'asc' } });

const adminNotes = (type: string) =>
  prisma.notification.findMany({ where: { recipientId: ADMIN, type }, orderBy: { id: 'asc' } });

async function main() {
  assertSafeDatabaseUrl();
  console.log('==================================================================');
  console.log('PHASE 8: BACKGROUND JOBS (runJobsOnce with simulated time)');
  console.log('==================================================================\n');
  const cfg = getAppConfig();

  await resetWorld();
  const customer = await prisma.customer.create({ data: { name: 'Jobs Customer', phone: `0855${String(Date.now()).slice(-6)}` } });
  const machine = await prisma.machine.create({ data: { brand: 'GEF', model: 'Aa+', customerId: customer.id } });
  let seq = 0;
  const mk = (status: any, technicianId: number | null, extra: any = {}) =>
    prisma.repairOrder.create({
      data: {
        jobNumber: `REP-P8-${String(++seq).padStart(4, '0')}`,
        trackingToken: crypto.randomBytes(24).toString('base64url'),
        status,
        receivedDate: getBangkokDateOnly(),
        customerId: customer.id,
        machineId: machine.id,
        technicianId,
        lastActivityAt: new Date(),
        ...extra,
      },
    });
  const order = (id: number) => prisma.repairOrder.findUniqueOrThrow({ where: { id } });

  try {
    // ---------------------------------------------------------------
    // 1. Reserved but not accepted -> one ADMIN digest per round
    // ---------------------------------------------------------------
    const T = cfg.ackTimeoutMinutes;
    const I = cfg.ackReminderIntervalMinutes;
    console.log(`[Test 1] Unaccepted reserved jobs (timeout ${T} min, repeat every ${I} min)...`);
    const t0 = new Date();
    const at = (minutes: number) => new Date(t0.getTime() + minutes * MIN);
    await prisma.employee.updateMany({ where: { id: { in: [3, 5] } }, data: { status: 'RESERVED' } });
    const A = await mk('NEW', 3, { assignedAt: t0 });
    const B = await mk('NEW', 5, { assignedAt: t0 });
    // Meanwhile another technician is free and a job waits in the pool
    await prisma.employee.update({ where: { id: 4 }, data: { status: 'AVAILABLE', availableSince: at(-10) } });
    const Q = await mk('NEW', null);

    const r1 = await runJobsOnce(at(T - 1));
    eq(r1.failedJobs.length, 0, 'no job failed');
    eq(r1.ackReminded, 0, `${T - 1} min: no reminder`);
    eq((await adminNotes('ACK_OVERDUE_DIGEST')).length, 0, `${T - 1} min: no digest`);
    eq((await order(Q.id)).technicianId, 4, 'the free technician got the next pool job in the same round');
    // tech4 accepts it straight away, so only A and B stay unaccepted below
    await RepairService.acceptOrder(Q.id, { id: 4, role: 'TECHNICIAN' });
    pass(`${T - 1} min: nothing sent; the queue kept running for the free technician`);

    const r2 = await runJobsOnce(at(T + 1));
    eq(r2.ackReminded, 2, `${T + 1} min: both jobs overdue`);
    let digests = await adminNotes('ACK_OVERDUE_DIGEST');
    eq(digests.length, 1, 'ONE digest for the ADMIN covering both jobs');
    assert(digests[0].body.includes(A.jobNumber) && digests[0].body.includes(B.jobNumber), 'digest lists both jobs');
    assert(digests[0].body.includes(`${T + 1} นาที`), 'digest shows how long they waited');
    const a1 = await order(A.id);
    eq(a1.technicianId, 3, 'job stays with its technician (never moved)');
    eq(a1.status, 'NEW', 'still waiting for acceptance');
    eq(a1.ackReminderCount, 1, 'ackReminderCount 1');

    const r3 = await runJobsOnce(at(T + 1));
    eq(r3.ackReminded, 0, 'same time again: nothing (reminder already claimed)');
    eq((await adminNotes('ACK_OVERDUE_DIGEST')).length, 1, 'no duplicate digest');
    eq((await runJobsOnce(at(T + I))).ackReminded, 0, `${T + I} min: interval not over yet`);
    pass(`${T + 1} min: one digest for both jobs; repeat run sends nothing`);

    const r4 = await runJobsOnce(at(T + 1 + I));
    eq(r4.ackReminded, 2, `${T + 1 + I} min: reminded again`);
    eq((await adminNotes('ACK_OVERDUE_DIGEST')).length, 2, 'second digest');
    eq((await order(A.id)).ackReminderCount, 2, 'ackReminderCount 2');

    // Two instances running the same round at the same moment: only one claims each reminder
    const [x, y] = await Promise.all([runJobsOnce(at(T + 1 + 2 * I)), runJobsOnce(at(T + 1 + 2 * I))]);
    eq(x.ackReminded + y.ackReminded, 2, 'parallel rounds: each job reminded exactly once');
    const newDigests = (await adminNotes('ACK_OVERDUE_DIGEST')).slice(2).map((n) => n.body).join('\n');
    eq(newDigests.split(A.jobNumber).length - 1, 1, 'parallel rounds: A in exactly one digest');
    eq(newDigests.split(B.jobNumber).length - 1, 1, 'parallel rounds: B in exactly one digest');
    pass('Repeats every interval; parallel rounds never double-send (compare-and-set)');

    await RepairService.acceptOrder(A.id, { id: ADMIN, role: 'ADMIN' });
    const r5 = await runJobsOnce(at(T + 1 + 3 * I));
    eq(r5.ackReminded, 1, 'after ADMIN accepted A on behalf, only B is reminded');
    digests = await adminNotes('ACK_OVERDUE_DIGEST');
    const last = digests[digests.length - 1].body;
    assert(last.includes(B.jobNumber) && !last.includes(A.jobNumber), 'accepted job no longer in the digest');
    pass('Accepting the job stops its reminders');

    // ---------------------------------------------------------------
    // 2. Safety net: technician deactivated / moved out of the role directly in the DB
    // ---------------------------------------------------------------
    console.log('\n[Test 2] Safety net for orders held by inactive / former technicians...');
    await resetWorld();
    const now = new Date();
    await prisma.employee.update({ where: { id: 6 }, data: { status: 'RESERVED' } });
    await prisma.employee.update({ where: { id: 7 }, data: { status: 'BUSY' } });
    const C = await mk('NEW', 6, { assignedAt: new Date(now.getTime() - 20 * MIN) });
    const D = await mk('REPAIRING', 7, { assignedAt: new Date(now.getTime() - 300 * MIN), acknowledgedAt: new Date(now.getTime() - 290 * MIN) });
    // Bypass the Phase 4 service: change the employees directly
    await prisma.employee.update({ where: { id: 6 }, data: { isActive: false } });
    await prisma.employee.update({ where: { id: 7 }, data: { role: 'RECEPTIONIST' } });
    await prisma.employee.update({ where: { id: 3 }, data: { status: 'AVAILABLE', availableSince: new Date(now.getTime() - 60 * MIN) } });
    await prisma.employee.update({ where: { id: 4 }, data: { status: 'AVAILABLE', availableSince: new Date(now.getTime() - 5 * MIN) } });

    const s1 = await runJobsOnce(now);
    eq(s1.requeued, 2, 'both orders returned to the pool');
    const d1 = await order(D.id);
    const c1 = await order(C.id);
    eq(d1.technicianId, 3, 'job in progress went to the head of the queue -> longest-idle technician');
    eq(c1.technicianId, 4, 'reserved job -> next technician');
    assert(d1.status === 'NEW' && d1.acknowledgedAt === null && c1.status === 'NEW' && c1.acknowledgedAt === null, 'both wait for acceptance again');
    eq((await adminNotes('ORDERS_REQUEUED_DIGEST')).length, 2, 'ADMIN summary per affected technician');
    const sysLog = await prisma.statusLog.findFirst({ where: { repairOrderId: D.id, note: { contains: 'Returned to job pool' } } });
    eq(sysLog?.changedById, null, 'returned by the system (no employee)');

    const s2 = await runJobsOnce(now);
    eq(s2.requeued, 0, 'second round: nothing more to return');
    eq((await adminNotes('ORDERS_REQUEUED_DIGEST')).length, 2, 'no duplicate summary');
    pass('Same Phase 4 requeue service; jobs reassigned at once; idempotent');

    // ---------------------------------------------------------------
    // 3. "Still repairing?" reminders (business minutes, one message per technician, ADMIN once)
    // ---------------------------------------------------------------
    console.log('\n[Test 3] Progress reminders during business hours...');
    eq(cfg.progressReminderIntervalMinutes, 60, 'test assumes PROGRESS_REMINDER_INTERVAL_MINUTES=60 (set by test-runner)');
    eq(cfg.progressUnansweredAdminThreshold, 3, 'test assumes PROGRESS_UNANSWERED_ADMIN_THRESHOLD=3 (set by test-runner)');
    await resetWorld();
    // Simulated days: 2026-12-01 is a Tuesday
    const D1 = '2026-12-01';
    const work = (techId: number, activity: Date) =>
      mk('REPAIRING', techId, { assignedAt: activity, acknowledgedAt: activity, lastActivityAt: activity });
    await prisma.employee.updateMany({ where: { id: { in: [3, 4] } }, data: { status: 'BUSY' } });
    const P1 = await work(3, bkk(D1, '09:00'));
    const P2 = await work(3, bkk(D1, '09:00'));
    const P3 = await work(3, bkk(D1, '09:00'));
    const P4 = await work(4, bkk(D1, '09:30'));
    const count = async (id: number) => (await order(id)).progressReminderCount;
    const digestBodies = async () => (await adminNotes('PROGRESS_UNANSWERED_DIGEST')).map((n) => n.body);

    let p = await runJobsOnce(bkk(D1, '09:59'));
    eq(p.failedJobs.length, 0, 'no job failed');
    eq(p.progressReminded, 0, '59 business minutes: not yet');
    p = await runJobsOnce(bkk(D1, '10:00'));
    eq(p.progressReminded, 3, '60 business minutes: tech3\'s three jobs are due');
    let t3 = await techNotes(3);
    eq(t3.length, 1, 'ONE message for the technician covering all three jobs');
    eq(t3[0].title, 'กรุณาอัปเดตความคืบหน้า 3 ใบงาน', 'combined title');
    assert([P1, P2, P3].every((o) => t3[0].body.includes(o.jobNumber)), 'message lists all three jobs');
    eq((await techNotes(4)).length, 0, 'tech4 (30 min idle) not reminded');
    eq((await runJobsOnce(bkk(D1, '10:00'))).progressReminded, 0, 'same time again: nothing (compare-and-set)');
    eq((await techNotes(3)).length, 1, 'no duplicate message');
    pass('Due at exactly 60 business minutes; one message per technician; no duplicates');

    p = await runJobsOnce(bkk(D1, '10:30'));
    eq(p.progressReminded, 1, '10:30: only P4 is due');
    const t4 = await techNotes(4);
    eq(t4.length, 1, 'tech4 got one message');
    eq(t4[0].title, `ใบงาน ${P4.jobNumber} ยังซ่อมอยู่ไหม?`, 'single-job title');
    pass('Next reminder counts from the last reminder, not from the start');

    // "ยังซ่อมอยู่" on P1: the real service resets the counter...
    await RepairService.stillWorking(P1.id, { id: 3, role: 'TECHNICIAN' });
    const p1 = await order(P1.id);
    eq(p1.progressReminderCount, 0, 'still-working clears the counter');
    eq(p1.lastProgressReminderAt, null, 'still-working clears the last reminder time');
    // ...it stamps the real clock; move that stamp onto the simulated day (as if pressed at 10:40)
    await prisma.repairOrder.update({ where: { id: P1.id }, data: { lastActivityAt: bkk(D1, '10:40') } });

    p = await runJobsOnce(bkk(D1, '11:00'));
    eq(p.progressReminded, 2, '11:00: P2 and P3 (2nd reminder); P1 restarted at 10:40');
    eq(await count(P1.id), 0, 'P1 not reminded');
    p = await runJobsOnce(bkk(D1, '11:40'));
    eq(await count(P1.id), 1, '11:40: P1 due 60 minutes after still-working');
    eq(await count(P4.id), 2, '11:40: P4 2nd reminder');
    eq(p.progressEscalated, 0, 'nothing reaches the threshold yet');
    eq((await digestBodies()).length, 0, 'no ADMIN digest yet');
    pass('Still-working restarts the timer and resets the counter');

    p = await runJobsOnce(bkk(D1, '12:00'));
    eq(p.progressEscalated, 2, '12:00: P2 and P3 reach 3 unanswered reminders');
    let digestsP = await digestBodies();
    eq(digestsP.length, 1, 'ONE ADMIN digest');
    assert(digestsP[0].includes(P2.jobNumber) && digestsP[0].includes(P3.jobNumber), 'digest lists P2 and P3');
    assert(!digestsP[0].includes(P1.jobNumber) && !digestsP[0].includes(P4.jobNumber), 'digest lists only jobs at the threshold');
    assert(digestsP[0].includes('ไม่ตอบติดต่อกัน 3 รอบ'), 'digest shows the unanswered count');

    p = await runJobsOnce(bkk(D1, '13:00'));
    eq(await count(P2.id), 4, '13:00: P2 4th reminder (technician still reminded)');
    digestsP = await digestBodies();
    eq(digestsP.length, 2, '13:00: P4 reaches the threshold -> new digest');
    assert(digestsP[1].includes(P4.jobNumber), 'second digest is about P4');
    assert(!digestsP[1].includes(P2.jobNumber) && !digestsP[1].includes(P3.jobNumber), '4th reminder of P2/P3 NOT reported again');

    p = await runJobsOnce(bkk(D1, '14:00'));
    eq(await count(P2.id), 5, '14:00: P2 5th reminder');
    eq(await count(P4.id), 4, '14:00: P4 4th reminder');
    digestsP = await digestBodies();
    eq(digestsP.length, 3, '14:00: P1 reaches the threshold -> new digest');
    assert(digestsP[2].includes(P1.jobNumber), 'third digest is about P1');
    assert(![P2, P3, P4].some((o) => digestsP[2].includes(o.jobNumber)), '4th/5th reminders NOT reported again');
    pass('ADMIN told once per job, exactly when the threshold is reached');

    // --- Outside business hours / overnight ---
    console.log('\n[Test 3b] Overnight: business minutes only...');
    await resetWorld();
    const D2 = '2026-12-02';
    await prisma.employee.update({ where: { id: 5 }, data: { status: 'BUSY' } });
    const P5 = await work(5, bkk(D1, '17:00'));
    eq((await runJobsOnce(bkk(D1, '17:31'))).progressReminded, 0, '17:31: shop closed, nothing sent');
    eq((await runJobsOnce(bkk(D2, '07:59'))).progressReminded, 0, '07:59 next day: not open yet');
    eq((await runJobsOnce(bkk(D2, '08:29'))).progressReminded, 0, '08:29: 30 + 29 = 59 business minutes');
    eq((await runJobsOnce(bkk(D2, '08:30'))).progressReminded, 1, '08:30: 30 + 30 = 60 business minutes');
    eq(await count(P5.id), 1, 'P5 reminded once');
    pass('Activity at 17:00 -> due 08:30 next morning; nothing sent outside 08:00-17:30');

    // --- Technician's weekly day off and shop holidays pause the timer ---
    console.log('\n[Test 3c] Day off and shop holiday pause the timer...');
    await resetWorld();
    const D3 = '2026-12-03'; // Thursday
    const D4 = '2026-12-04'; // Friday
    const D5 = '2026-12-05'; // Saturday (shop holiday below)
    const D6 = '2026-12-06'; // Sunday
    await prisma.employee.update({ where: { id: 5 }, data: { status: 'BUSY', weeklyDayOff: 4 } }); // Thursday
    await prisma.employee.update({ where: { id: 3 }, data: { status: 'BUSY' } });
    const P6 = await work(5, bkk(D2, '17:00'));
    eq((await runJobsOnce(bkk(D3, '10:00'))).progressReminded, 0, 'Thursday: tech5\'s day off, not reminded');
    eq(await count(P6.id), 0, 'P6 untouched on the day off');
    eq((await runJobsOnce(bkk(D4, '08:29'))).progressReminded, 0, 'Friday 08:29: 30 + 0 (day off) + 29 = 59');
    eq((await runJobsOnce(bkk(D4, '08:30'))).progressReminded, 1, 'Friday 08:30: 60 business minutes');
    eq(await count(P6.id), 1, 'P6 reminded');

    await prisma.shopHoliday.create({ data: { date: new Date(`${D5}T00:00:00.000Z`), name: 'ปิดร้านทดสอบ', createdById: ADMIN } });
    const P7 = await work(3, bkk(D4, '17:00'));
    await prisma.repairOrder.update({ where: { id: P6.id }, data: { lastActivityAt: bkk(D4, '17:00'), lastProgressReminderAt: null, progressReminderCount: 0 } });
    eq((await runJobsOnce(bkk(D5, '12:00'))).progressReminded, 0, 'Saturday: shop holiday, nobody reminded');
    eq((await runJobsOnce(bkk(D6, '08:29'))).progressReminded, 0, 'Sunday 08:29: holiday counts 0 -> 59');
    eq((await runJobsOnce(bkk(D6, '08:30'))).progressReminded, 2, 'Sunday 08:30: P6 and P7 due');
    eq(await count(P7.id), 1, 'P7 reminded');
    pass('Weekly day off and shop holidays: no message and the idle time does not grow');

    // ---------------------------------------------------------------
    // 4. Nightly photo purge: once per Bangkok day during 02:xx
    // ---------------------------------------------------------------
    console.log('\n[Test 4] Nightly image purge...');
    await resetWorld();
    resetJobState();
    const N1 = '2026-12-10';
    const N2 = '2026-12-11';
    const closed = await mk('DELIVERED', null, { closedAt: bkk('2026-10-01', '12:00') });
    const kept = await mk('DELIVERED', null, { closedAt: bkk(N1, '01:00') });
    const imageRow = (repairOrderId: number) =>
      prisma.repairOrderImage.create({
        data: { repairOrderId, kind: 'INTAKE', storagePath: `p8-missing/${crypto.randomUUID()}.jpg`, uploadedById: ADMIN },
      });
    const old = await imageRow(closed.id);
    const fresh = await imageRow(kept.id);

    eq((await runJobsOnce(bkk(N1, '01:59'))).imagesPurged, null, '01:59: purge does not run');
    eq(await prisma.repairOrderImage.count({ where: { id: old.id } }), 1, 'old photo still there');
    const g1 = await runJobsOnce(bkk(N1, '02:10'));
    eq(g1.failedJobs.length, 0, 'no job failed');
    eq(g1.imagesPurged, 1, '02:10: purge runs and removes the expired photo (file already gone counts as deleted)');
    eq(await prisma.repairOrderImage.count({ where: { id: old.id } }), 0, 'expired photo record removed');
    eq(await prisma.repairOrderImage.count({ where: { id: fresh.id } }), 1, 'photo of a recently closed order kept');
    eq((await runJobsOnce(bkk(N1, '02:40'))).imagesPurged, null, '02:40 same day: not again');
    eq((await runJobsOnce(bkk(N1, '03:00'))).imagesPurged, null, '03:00: outside the purge hour');
    eq((await runJobsOnce(bkk(N2, '02:05'))).imagesPurged, 0, 'next day 02:05: runs again (nothing left to remove)');
    pass('Runs once per day at 02:xx Bangkok time');

    console.log('\n==================================================================');
    console.log('PHASE 8 JOB TESTS PASSED');
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
  console.error('\nPhase 8 Test Failed:', err.message);
  await prisma.$disconnect();
  process.exit(1);
});
