/**
 * Phase 4 tests: technician queue with RESERVED -> accept (SRS 3.3, 4, 6.3).
 * FIFO by availableSince, no auto-move of unaccepted jobs, concurrent accept, ADMIN accept on behalf,
 * awaitingAck list, release, cancel before accept, RESERVED self-status guard, and returning jobs to
 * the pool when a technician is deactivated or leaves the TECHNICIAN role.
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

const API = 'http://localhost:4000/api';
const ADMIN = 1;
const RECEP = 2;
const TECHS = [3, 4, 5, 6, 7];

type Headers = { Authorization: string };

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

/** Token without POST /auth/login (rate limited; login is covered by the smoke suite). */
async function tokenFor(id: number): Promise<Headers> {
  const e = await prisma.employee.findUniqueOrThrow({ where: { id } });
  return {
    Authorization: `Bearer ${jwt.sign({ employeeId: e.id, role: e.role }, getJwtSecret(), { algorithm: 'HS256', expiresIn: '30m' })}`,
  };
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

async function setTech(id: number, status: 'AVAILABLE' | 'BUSY' | 'OFFLINE' | 'RESERVED', idleMinutes?: number) {
  await prisma.employee.update({
    where: { id },
    data: { status, isActive: true, role: 'TECHNICIAN', availableSince: idleMinutes === undefined ? null : minutesAgo(idleMinutes) },
  });
}

async function resetWorld() {
  await prisma.notification.deleteMany({});
  await prisma.repairOrderImage.deleteMany({});
  await prisma.orderLineSubscription.deleteMany({});
  await prisma.statusLog.deleteMany({});
  await prisma.repairItem.deleteMany({});
  await prisma.repairOrderSymptom.deleteMany({});
  await prisma.repairOrderHelper.deleteMany({});
  await prisma.repairOrder.deleteMany({});
  await prisma.employee.updateMany({
    where: { id: { in: TECHS } },
    data: { status: 'OFFLINE', isActive: true, role: 'TECHNICIAN', availableSince: null },
  });
}

const order = (id: number) => prisma.repairOrder.findUniqueOrThrow({ where: { id } });
const tech = (id: number) => prisma.employee.findUniqueOrThrow({ where: { id } });

let phoneSeq = 0;
async function createOrderViaApi(recep: Headers, label: string) {
  phoneSeq++;
  const res = await axios.post(
    `${API}/repairs`,
    {
      customer: { name: `Queue ${label}`, phone: `0870${String(Date.now() % 100000).padStart(5, '0')}${phoneSeq % 10}` },
      machine: { brand: 'GEF', model: 'Aa+' },
      symptomIds: [1],
    },
    { headers: recep }
  );
  return res.data.data as { id: number; jobNumber: string };
}

async function main() {
  assertSafeDatabaseUrl();
  console.log('==================================================================');
  console.log('PHASE 4: TECHNICIAN QUEUE (RESERVED / ACCEPT / RELEASE / REQUEUE)');
  console.log('==================================================================\n');

  const admin = await tokenFor(ADMIN);
  const recep = await tokenFor(RECEP);
  const t: Record<number, Headers> = {};
  for (const id of TECHS) t[id] = await tokenFor(id);

  try {
    // ---------------------------------------------------------------
    // 1. FIFO: 3 technicians + 5 orders -> longest-idle technician first, rest stay in the pool
    // ---------------------------------------------------------------
    console.log('[Test 1] 3 technicians x 5 orders, FIFO by availableSince...');
    await resetWorld();
    await setTech(5, 'AVAILABLE', 30); // idle longest
    await setTech(3, 'AVAILABLE', 20);
    await setTech(4, 'AVAILABLE', 10);
    const O: { id: number; jobNumber: string }[] = [];
    for (let i = 1; i <= 5; i++) O.push(await createOrderViaApi(recep, `O${i}`));

    const expectedTech = [5, 3, 4, null, null];
    for (let i = 0; i < 5; i++) {
      const o = await order(O[i].id);
      eq(o.status, 'NEW', `O${i + 1} stays NEW (reserved jobs are not INSPECTING)`);
      eq(o.technicianId, expectedTech[i], `O${i + 1} technician`);
      eq(o.acknowledgedAt, null, `O${i + 1} not acknowledged`);
      eq(!!o.assignedAt, expectedTech[i] !== null, `O${i + 1} assignedAt set only when reserved`);
    }
    for (const id of [5, 3, 4]) {
      eq((await tech(id)).status, 'RESERVED', `technician ${id} RESERVED`);
      eq(await prisma.notification.count({ where: { recipientId: id, type: 'JOB_RESERVED' } }), 1, `technician ${id} got one JOB_RESERVED`);
    }
    pass('O1->tech5, O2->tech3, O3->tech4 (longest idle first); O4, O5 wait in the pool; no double assignment');

    // ---------------------------------------------------------------
    // 2. Unaccepted job is not moved; another technician who becomes free gets the next job
    // ---------------------------------------------------------------
    console.log('\n[Test 2] Unaccepted job stays; next free technician takes the next job...');
    const t6Status = await axios.patch(`${API}/employees/6/status`, { status: 'AVAILABLE' }, { headers: t[6] });
    eq(t6Status.data.data.assignedOrder?.id, O[3].id, 'tech6 becoming AVAILABLE is reserved O4 (assignedOrder covers reserved jobs)');
    eq(t6Status.data.data.assignedOrder?.status, 'NEW', 'assignedOrder is the reserved NEW job');
    eq((await order(O[0].id)).technicianId, 5, 'O1 still reserved for tech5 (never moved)');
    pass('Reserved job not moved; queue kept running for the other technician');

    await expectStatus(409, 'RESERVED tech5 sets itself AVAILABLE', () =>
      axios.patch(`${API}/employees/5/status`, { status: 'AVAILABLE' }, { headers: t[5] })
    );
    await expectStatus(409, 'RESERVED tech5 sets itself OFFLINE', () =>
      axios.patch(`${API}/employees/5/status`, { status: 'OFFLINE' }, { headers: t[5] })
    );
    await expectStatus(409, 'ADMIN changes status of a RESERVED technician', () =>
      axios.patch(`${API}/employees/5/status`, { status: 'OFFLINE' }, { headers: admin })
    );

    // ---------------------------------------------------------------
    // 3. 10 concurrent accepts on one job -> exactly 1 succeeds
    // ---------------------------------------------------------------
    console.log('\n[Test 3] 10 concurrent accept requests on O1...');
    const results = await Promise.all(
      Array.from({ length: 10 }).map(() =>
        axios
          .post(`${API}/repairs/${O[0].id}/accept`, {}, { headers: t[5] })
          .then((r) => r.status)
          .catch((e) => e.response?.status)
      )
    );
    eq(results.filter((s) => s === 200).length, 1, 'exactly one accept succeeded');
    eq(results.filter((s) => s === 409).length, 9, 'nine accepts got 409');
    const o1 = await order(O[0].id);
    eq(o1.status, 'INSPECTING', 'O1 INSPECTING after accept');
    assert(o1.acknowledgedAt && o1.lastActivityAt, 'acknowledgedAt and lastActivityAt set');
    eq((await tech(5)).status, 'BUSY', 'tech5 BUSY');
    const o1Logs = await prisma.statusLog.findMany({ where: { repairOrderId: O[0].id, status: 'INSPECTING' } });
    eq(o1Logs.length, 1, 'one INSPECTING log');
    eq(o1Logs[0].changedById, 5, 'accept logged with the technician');
    pass('1 x 200, 9 x 409; O1 INSPECTING, tech5 BUSY');

    // ---------------------------------------------------------------
    // 4. Who may accept
    // ---------------------------------------------------------------
    console.log('\n[Test 4] Accept permissions...');
    await expectStatus(403, 'another technician accepts O3 (reserved for tech4)', () =>
      axios.post(`${API}/repairs/${O[2].id}/accept`, {}, { headers: t[3] })
    );
    await expectStatus(403, 'RECEPTIONIST accepts', () => axios.post(`${API}/repairs/${O[2].id}/accept`, {}, { headers: recep }));
    const adminAccept = await axios.post(`${API}/repairs/${O[2].id}/accept`, {}, { headers: admin });
    eq(adminAccept.data.data.status, 'INSPECTING', 'ADMIN accepts on behalf of tech4');
    eq((await tech(4)).status, 'BUSY', 'tech4 BUSY after ADMIN accept');
    const behalfLog = (await prisma.statusLog.findMany({ where: { repairOrderId: O[2].id, status: 'INSPECTING' } }))[0];
    eq(behalfLog.changedById, ADMIN, 'log changedById = ADMIN');
    assert(/Accepted by ADMIN .* on behalf of /.test(behalfLog.note ?? ''), `log says ADMIN accepted on behalf (got "${behalfLog.note}")`);
    pass('ADMIN accepted on behalf; log records it');
    await expectStatus(409, 'accept an already accepted job', () => axios.post(`${API}/repairs/${O[2].id}/accept`, {}, { headers: admin }));
    await expectStatus(409, 'accept an unassigned pool job', () => axios.post(`${API}/repairs/${O[4].id}/accept`, {}, { headers: admin }));
    await expectStatus(404, 'accept unknown order', () => axios.post(`${API}/repairs/999999999/accept`, {}, { headers: admin }));

    // ---------------------------------------------------------------
    // 5. GET /api/repairs?awaitingAck=true
    // ---------------------------------------------------------------
    console.log('\n[Test 5] awaitingAck list...');
    const awaitingAdmin = (await axios.get(`${API}/repairs?awaitingAck=true&limit=100`, { headers: admin })).data.data.orders;
    eq(JSON.stringify(awaitingAdmin.map((o: any) => o.id).sort()), JSON.stringify([O[1].id, O[3].id].sort()), 'ADMIN sees all reserved jobs (O2, O4)');
    for (const o of awaitingAdmin) {
      assert(o.assignedAt, 'assignedAt returned');
      assert(typeof o.waitingMinutes === 'number' && o.waitingMinutes >= 0, 'waitingMinutes returned');
    }
    const awaitingT3 = (await axios.get(`${API}/repairs?awaitingAck=true`, { headers: t[3] })).data.data.orders;
    eq(JSON.stringify(awaitingT3.map((o: any) => o.id)), JSON.stringify([O[1].id]), 'technician sees only own reserved job');
    const awaitingT5 = (await axios.get(`${API}/repairs?awaitingAck=true`, { headers: t[5] })).data.data.orders;
    eq(awaitingT5.length, 0, 'technician with an accepted job has nothing awaiting');
    pass('awaitingAck: ADMIN all, TECHNICIAN own, with assignedAt + waitingMinutes');
    await expectStatus(400, 'awaitingAck=yes', () => axios.get(`${API}/repairs?awaitingAck=yes`, { headers: admin }));

    // ---------------------------------------------------------------
    // 6. ADMIN release
    // ---------------------------------------------------------------
    console.log('\n[Test 6] ADMIN releases a reserved job...');
    await setTech(7, 'AVAILABLE', 60); // waiting longest, no queue run triggered by a direct DB write
    const releaseStart = new Date();
    await expectStatus(403, 'TECHNICIAN releases', () => axios.post(`${API}/repairs/${O[1].id}/release`, {}, { headers: t[3] }));
    await expectStatus(409, 'release an accepted job', () => axios.post(`${API}/repairs/${O[0].id}/release`, {}, { headers: admin }));
    await axios.post(`${API}/repairs/${O[1].id}/release`, {}, { headers: admin });
    const t3AfterRelease = await tech(3);
    assert(t3AfterRelease.availableSince && t3AfterRelease.availableSince >= releaseStart, 'released technician went AVAILABLE (availableSince = now)');
    eq((await order(O[1].id)).technicianId, 7, 'released O2 went back to the pool and to the longest-idle technician (tech7)');
    eq((await order(O[4].id)).technicianId, 3, 'queue re-ran: O5 reserved for the released tech3');
    const releaseLog = await prisma.statusLog.findFirst({ where: { repairOrderId: O[1].id, note: { contains: 'Released back to job pool' } } });
    eq(releaseLog?.changedById, ADMIN, 'release logged with the ADMIN');
    pass('Released job returned to pool; technician AVAILABLE; queue re-ran');

    // ---------------------------------------------------------------
    // 7. Cancel before accept frees the RESERVED technician
    // ---------------------------------------------------------------
    console.log('\n[Test 7] Cancel a reserved job before acceptance...');
    const cancelStart = new Date();
    await axios.patch(`${API}/repairs/${O[3].id}/status`, { status: 'CANCELLED' }, { headers: recep });
    const t6 = await tech(6);
    eq(t6.status, 'AVAILABLE', 'tech6 RESERVED -> AVAILABLE after cancel');
    assert(t6.availableSince && t6.availableSince >= cancelStart, 'availableSince reset on cancel');
    assert((await order(O[3].id)).closedAt, 'closedAt set on CANCELLED');
    pass('Cancel before accept released the technician; closedAt set');

    // ---------------------------------------------------------------
    // 8. Deactivate a RESERVED technician -> job back to pool and reassigned at once
    // ---------------------------------------------------------------
    console.log('\n[Test 8] Deactivate a RESERVED technician...');
    eq((await order(O[4].id)).technicianId, 3, 'precondition: O5 reserved for tech3');
    await axios.patch(`${API}/employees/3`, { isActive: false }, { headers: admin });
    const o5 = await order(O[4].id);
    eq(o5.technicianId, 6, 'O5 immediately reserved for the free tech6');
    eq(o5.status, 'NEW', 'O5 still NEW');
    eq(o5.queuePriority, 0, 'unaccepted job keeps FIFO priority (0)');
    const t3 = await tech(3);
    eq(t3.status, 'OFFLINE', 'deactivated technician OFFLINE');
    eq(t3.isActive, false, 'deactivated technician inactive');
    assert(await prisma.statusLog.findFirst({ where: { repairOrderId: O[4].id, note: { contains: 'Returned to job pool' } } }), 'requeue StatusLog written');
    const digest = await prisma.notification.findFirst({ where: { recipientId: ADMIN, type: 'ORDERS_REQUEUED_DIGEST' } });
    assert(digest && digest.body.includes(O[4].jobNumber) && digest.body.includes('รอช่างกดรับงาน'), 'ADMIN got the requeue summary');
    await expectStatus(401, 'deactivated technician calls the API', () => axios.post(`${API}/repairs/${O[4].id}/accept`, {}, { headers: t[3] }));
    await axios.patch(`${API}/employees/3`, { isActive: true }, { headers: admin });
    pass('RESERVED job returned to pool and reassigned immediately; ADMIN summary sent');

    // ---------------------------------------------------------------
    // 9. Deactivate a technician holding 3 accepted jobs (+1 COMPLETED)
    // ---------------------------------------------------------------
    console.log('\n[Test 9] Deactivate a technician with INSPECTING / WAITING_APPROVAL / REPAIRING / COMPLETED jobs...');
    await resetWorld();
    await setTech(7, 'BUSY');
    await setTech(4, 'AVAILABLE', 10); // the only free technician
    const customer = await prisma.customer.create({ data: { name: 'Queue Customer', phone: `0861${String(Date.now()).slice(-6)}` } });
    const machine = await prisma.machine.create({ data: { brand: 'GEF', model: 'Aa+', customerId: customer.id } });
    const mk = (jobNumber: string, status: any, createdMinutesAgo: number, extra: any = {}) =>
      prisma.repairOrder.create({
        data: {
          jobNumber,
          trackingToken: crypto.randomBytes(24).toString('base64url'),
          status,
          receivedDate: getBangkokDateOnly(),
          customerId: customer.id,
          machineId: machine.id,
          createdAt: minutesAgo(createdMinutesAgo),
          ...extra,
        },
      });
    const accepted = { technicianId: 7, assignedAt: minutesAgo(100), acknowledgedAt: minutesAgo(95), lastActivityAt: minutesAgo(30) };
    const N1 = await mk('REP-Q-N1', 'NEW', 180); // ordinary pool job, OLDER than the returned ones
    const P1 = await mk('REP-Q-P1', 'INSPECTING', 120, accepted);
    const P2 = await mk('REP-Q-P2', 'WAITING_APPROVAL', 110, accepted);
    const P3 = await mk('REP-Q-P3', 'REPAIRING', 100, { ...accepted, completionSummary: 'งานค้าง: รออะไหล่' });
    const P4 = await mk('REP-Q-P4', 'COMPLETED', 90, accepted);
    await prisma.repairItem.create({ data: { repairOrderId: P2.id, name: 'ปั๊มน้ำ', unitPrice: 1200, status: 'PENDING' } });
    await prisma.repairItem.create({ data: { repairOrderId: P3.id, name: 'วาล์ว', unitPrice: 500, status: 'APPROVED' } });
    await prisma.repairItem.create({ data: { repairOrderId: P3.id, name: 'ซีล', unitPrice: 80, status: 'COMPLETED' } });
    await prisma.repairOrderImage.create({ data: { repairOrderId: P2.id, kind: 'INTAKE', storagePath: 'test/p2.jpg', uploadedById: ADMIN } });
    for (const p of [P1, P2, P3]) {
      await prisma.statusLog.create({ data: { repairOrderId: p.id, status: p.status, changedById: 7, note: 'history' } });
    }

    await axios.patch(`${API}/employees/7`, { isActive: false }, { headers: admin });

    const p1 = await order(P1.id);
    eq(p1.technicianId, 4, 'returned job P1 assigned before the older ordinary job N1');
    eq(p1.status, 'NEW', 'P1 NEW (reserved)');
    eq(p1.queuePriority, 1, 'P1 head-of-queue priority until accepted');
    for (const p of [P2, P3]) {
      const row = await order(p.id);
      eq(row.status, 'NEW', `${p.jobNumber} back to NEW`);
      eq(row.technicianId, null, `${p.jobNumber} unassigned (no free technician)`);
      eq(row.queuePriority, 1, `${p.jobNumber} queuePriority 1`);
      eq(row.acknowledgedAt, null, `${p.jobNumber} acknowledgedAt cleared`);
    }
    const n1 = await order(N1.id);
    eq(n1.technicianId, null, 'ordinary job N1 still waiting');
    eq(n1.queuePriority, 0, 'N1 priority 0');
    const p4 = await order(P4.id);
    eq(p4.status, 'COMPLETED', 'COMPLETED job not moved');
    eq(p4.technicianId, 7, 'COMPLETED job keeps its technician');
    eq(await prisma.repairItem.count({ where: { repairOrderId: P2.id, status: 'PENDING' } }), 1, 'P2 PENDING item kept');
    eq(await prisma.repairItem.count({ where: { repairOrderId: P3.id } }), 2, 'P3 items kept');
    eq(await prisma.repairOrderImage.count({ where: { repairOrderId: P2.id } }), 1, 'P2 image kept');
    eq((await order(P3.id)).completionSummary, 'งานค้าง: รออะไหล่', 'completionSummary kept');
    for (const p of [P1, P2, P3]) {
      assert(await prisma.statusLog.findFirst({ where: { repairOrderId: p.id, note: 'history' } }), `${p.jobNumber} history kept`);
      const log = await prisma.statusLog.findFirst({ where: { repairOrderId: p.id, note: { contains: `previous stage: ${p.status}` } } });
      assert(log && log.changedById === ADMIN && log.status === 'NEW', `${p.jobNumber} requeue log names previous stage ${p.status}`);
    }
    const digest9 = await prisma.notification.findFirst({ where: { recipientId: ADMIN, type: 'ORDERS_REQUEUED_DIGEST' } });
    assert(digest9, 'ADMIN summary sent');
    for (const label of ['REP-Q-P1', 'REP-Q-P2', 'REP-Q-P3', 'กำลังตรวจเช็ค', 'รอยืนยันราคา', 'กำลังซ่อม']) {
      assert(digest9.body.includes(label), `summary mentions ${label}`);
    }
    assert(!digest9.body.includes('REP-Q-P4'), 'summary does not list the COMPLETED job');
    eq(await prisma.notification.count({ where: { type: 'ORDERS_REQUEUED_DIGEST', recipientId: { not: ADMIN } } }), 0, 'summary only to ADMINs');
    await expectStatus(401, 'deactivated technician reads its old job', () => axios.get(`${API}/repairs/${P4.id}`, { headers: t[7] }));
    pass('3 open jobs back at the head of the queue with items/images/history; COMPLETED untouched; ADMIN summary');

    // Accepting returned jobs resumes the stage they were in
    const acc1 = await axios.post(`${API}/repairs/${P1.id}/accept`, {}, { headers: t[4] });
    eq(acc1.data.data.status, 'INSPECTING', 'P1 resumes at INSPECTING');
    eq((await order(P1.id)).queuePriority, 0, 'priority reset on accept');

    const t5Avail = await axios.patch(`${API}/employees/5/status`, { status: 'AVAILABLE' }, { headers: t[5] });
    eq(t5Avail.data.data.assignedOrder?.id, P2.id, 'next free technician gets returned P2 before N1');
    const acc2 = await axios.post(`${API}/repairs/${P2.id}/accept`, {}, { headers: t[5] });
    eq(acc2.data.data.status, 'WAITING_APPROVAL', 'P2 (PENDING item) resumes at WAITING_APPROVAL');
    assert(
      await prisma.statusLog.findFirst({ where: { repairOrderId: P2.id, note: { contains: 'resumed at WAITING_APPROVAL' } } }),
      'accept log notes the resumed stage'
    );

    const t6Avail = await axios.patch(`${API}/employees/6/status`, { status: 'AVAILABLE' }, { headers: t[6] });
    eq(t6Avail.data.data.assignedOrder?.id, P3.id, 'then P3');
    const acc3 = await axios.post(`${API}/repairs/${P3.id}/accept`, {}, { headers: t[6] });
    eq(acc3.data.data.status, 'REPAIRING', 'P3 (APPROVED item) resumes at REPAIRING');
    eq((await order(N1.id)).technicianId, null, 'N1 still waits (no free technician)');
    pass('Returned jobs resume at INSPECTING / WAITING_APPROVAL / REPAIRING; priority reset to 0');

    // ---------------------------------------------------------------
    // 10. Role change TECHNICIAN -> RECEPTIONIST behaves like deactivation
    // ---------------------------------------------------------------
    console.log('\n[Test 10] Technician moved to RECEPTIONIST...');
    await axios.patch(`${API}/employees/6`, { role: 'RECEPTIONIST' }, { headers: admin });
    const p3 = await order(P3.id);
    eq(p3.status, 'NEW', 'P3 back to NEW');
    eq(p3.technicianId, null, 'P3 unassigned');
    eq(p3.queuePriority, 1, 'P3 head of queue');
    const t6r = await tech(6);
    eq(t6r.role, 'RECEPTIONIST', 'role changed');
    eq(t6r.status, 'OFFLINE', 'former technician OFFLINE');
    await expectStatus(403, 'former technician adds an item to its old job', () =>
      axios.post(`${API}/repairs/${P3.id}/items`, { name: 'x', unitPrice: 10 }, { headers: t[6] })
    );
    await axios.patch(`${API}/employees/6`, { role: 'TECHNICIAN' }, { headers: admin });
    const t3Avail = await axios.patch(`${API}/employees/3/status`, { status: 'AVAILABLE' }, { headers: t[3] });
    eq(t3Avail.data.data.assignedOrder?.id, P3.id, 'returned P3 is assigned before the older N1');
    pass('Role change returned the job to the head of the queue');

    console.log('\n==================================================================');
    console.log('PHASE 4 QUEUE TESTS PASSED');
    console.log('==================================================================\n');
  } finally {
    await prisma.employee.updateMany({
      where: { id: { in: TECHS } },
      data: { status: 'AVAILABLE', isActive: true, role: 'TECHNICIAN', availableSince: null },
    });
    await prisma.$disconnect();
  }
}

main().catch(async (err) => {
  console.error('\nPhase 4 Queue Test Failed:', err.response?.data || err.message);
  await prisma.$disconnect();
  process.exit(1);
});
