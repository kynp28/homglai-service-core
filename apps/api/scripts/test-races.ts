/**
 * Phase 9: requests pressed at the same moment on the same order. Each case fires real HTTP
 * requests in parallel against the API started by test-runner.js (*_test database only).
 *  1. Ten "item done" presses on one item           -> exactly one succeeds, one log line
 *  2. Six parallel photo uploads with 3 slots left  -> exactly 3 stored, never above the limit
 *  3. Payment pressed together with a rework        -> a payment is never recorded on a reopened job
 *  4. Helper list edited twice at the same moment   -> both answered 200, one consistent final list
 */
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import sharp from 'sharp';
import prisma from '@homglai/db';
import { assertSafeDatabaseUrl } from '../src/utils/test-safety';
import { getAppConfig, getJwtSecret } from '../src/config/env';
import { getBangkokDateOnly } from '../src/utils/date';

type Headers = Record<string, string>;
const API = 'http://localhost:4000/api';
const TECHS = [3, 4, 5, 6, 7];
const ADMIN = 1;
const RECEP = 2;

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
async function tokenFor(id: number): Promise<Headers> {
  const e = await prisma.employee.findUniqueOrThrow({ where: { id } });
  return { Authorization: `Bearer ${jwt.sign({ employeeId: e.id, role: e.role }, getJwtSecret(), { algorithm: 'HS256', expiresIn: '30m' })}` };
}
async function send(method: string, url: string, headers: Headers, body?: unknown): Promise<number> {
  const res = await fetch(`${API}${url}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  await res.text();
  return res.status;
}
const count = (codes: number[], code: number) => codes.filter((c) => c === code).length;

async function resetWorld() {
  await prisma.notification.deleteMany({});
  await prisma.repairOrderImage.deleteMany({});
  await prisma.orderLineSubscription.deleteMany({});
  await prisma.repairOrderHelper.deleteMany({});
  await prisma.statusLog.deleteMany({});
  await prisma.repairItem.deleteMany({});
  await prisma.repairOrderSymptom.deleteMany({});
  await prisma.repairOrder.deleteMany({});
  await prisma.employee.updateMany({
    where: { id: { in: TECHS } },
    data: { status: 'OFFLINE', isActive: true, role: 'TECHNICIAN', availableSince: null, weeklyDayOff: null },
  });
}

async function main() {
  assertSafeDatabaseUrl();
  console.log('==================================================================');
  console.log('PHASE 9: SIMULTANEOUS PRESSES ON THE SAME ORDER');
  console.log('==================================================================\n');
  const cfg = getAppConfig();
  const [admin, recep, tech3] = await Promise.all([tokenFor(ADMIN), tokenFor(RECEP), tokenFor(3)]);
  await resetWorld();
  const customer = await prisma.customer.create({ data: { name: 'Race Customer', phone: `0866${String(Date.now()).slice(-6)}` } });
  const machine = await prisma.machine.create({ data: { brand: 'GEF', model: 'Aa+', customerId: customer.id } });
  let seq = 0;
  const mk = (status: any, technicianId: number | null, extra: any = {}) =>
    prisma.repairOrder.create({
      data: {
        jobNumber: `REP-P9R-${String(++seq).padStart(4, '0')}`,
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

  try {
    // ---------------------------------------------------------------
    console.log('[Test 1] Ten "item done" presses on the same item...');
    await prisma.employee.update({ where: { id: 3 }, data: { status: 'BUSY' } });
    const O1 = await mk('REPAIRING', 3, { assignedAt: new Date(), acknowledgedAt: new Date() });
    const item = await prisma.repairItem.create({
      data: { repairOrderId: O1.id, name: 'ปั๊มน้ำ', unitPrice: 250, quantity: 1, status: 'APPROVED' },
    });
    const codes1 = await Promise.all(
      Array.from({ length: 10 }, () => send('PATCH', `/repairs/${O1.id}/items/${item.id}/complete`, tech3, {}))
    );
    eq(count(codes1, 200), 1, `exactly one press succeeds (got ${JSON.stringify(codes1)})`);
    eq(count(codes1, 409), 9, 'the other nine get 409');
    eq((await prisma.repairItem.findUniqueOrThrow({ where: { id: item.id } })).status, 'COMPLETED', 'item COMPLETED');
    eq(await prisma.statusLog.count({ where: { repairOrderId: O1.id, note: { contains: 'completed' } } }), 1, 'one log line, not ten');
    pass('1 x 200, 9 x 409, one log line');

    // ---------------------------------------------------------------
    const limit = cfg.imageMaxPerKind;
    const stored = limit - 3;
    console.log(`\n[Test 2] Six parallel uploads with ${stored} of ${limit} INTAKE photos already stored...`);
    const O2 = await mk('INSPECTING', 3);
    await prisma.repairOrderImage.createMany({
      data: Array.from({ length: stored }, () => ({
        repairOrderId: O2.id,
        kind: 'INTAKE' as const,
        storagePath: `${O2.id}/${crypto.randomUUID()}.jpg`,
        uploadedById: RECEP,
      })),
    });
    const photo = await sharp({ create: { width: 320, height: 240, channels: 3, background: { r: 90, g: 90, b: 90 } } }).jpeg().toBuffer();
    const upload = async () => {
      const fd = new FormData();
      fd.append('kind', 'INTAKE');
      fd.append('files', new Blob([new Uint8Array(photo)], { type: 'image/jpeg' }), 'intake.jpg');
      const res = await fetch(`${API}/repairs/${O2.id}/images`, { method: 'POST', headers: recep, body: fd });
      await res.text();
      return res.status;
    };
    const codes2 = await Promise.all(Array.from({ length: 6 }, upload));
    eq(count(codes2, 201), 3, `exactly 3 uploads stored (got ${JSON.stringify(codes2)})`);
    eq(count(codes2, 409), 3, 'the other 3 get 409');
    eq(await prisma.repairOrderImage.count({ where: { repairOrderId: O2.id, kind: 'INTAKE' } }), limit, `never above the limit of ${limit}`);
    pass(`3 x 201, 3 x 409, exactly ${limit} photos`);

    // ---------------------------------------------------------------
    console.log('\n[Test 3] Payment pressed together with a rework, 10 rounds...');
    let recorded = 0;
    let refused = 0;
    for (let round = 1; round <= 10; round++) {
      await prisma.employee.update({ where: { id: 3 }, data: { status: 'AVAILABLE', availableSince: new Date() } });
      const O3 = await mk('COMPLETED', 3, {
        assignedAt: new Date(),
        acknowledgedAt: new Date(),
        completionSummary: 'เปลี่ยนปั๊มน้ำ',
        repairOutcome: 'REPAIRED',
      });
      const [pay, rework] = await Promise.all([
        send('PUT', `/repairs/${O3.id}/payment`, recep, { amount: 815, method: 'CASH' }),
        send('PATCH', `/repairs/${O3.id}/status`, admin, { status: 'REPAIRING' }),
      ]);
      eq(rework, 200, `round ${round}: rework accepted`);
      const after = await prisma.repairOrder.findUniqueOrThrow({ where: { id: O3.id } });
      const payLogs = await prisma.statusLog.findMany({ where: { repairOrderId: O3.id, note: { contains: 'Payment' } } });
      if (pay === 200) {
        recorded++;
        eq(payLogs.length, 1, `round ${round}: one payment log`);
        eq(payLogs[0].status, 'COMPLETED', `round ${round}: payment recorded while the job was still COMPLETED`);
        const reworkLog = await prisma.statusLog.findFirst({
          where: { repairOrderId: O3.id, changedById: ADMIN }, // the rework is the only thing ADMIN pressed
          orderBy: { id: 'asc' },
        });
        assert(reworkLog && reworkLog.id > payLogs[0].id, `round ${round}: payment committed before the rework`);
      } else {
        refused++;
        eq(pay, 409, `round ${round}: payment refused with 409 (job already reopened)`);
        eq(after.paidAmount, null, `round ${round}: nothing recorded`);
        eq(payLogs.length, 0, `round ${round}: no payment log`);
      }
    }
    pass(`10 rounds: ${recorded} recorded before the rework, ${refused} refused after it; never on a reopened job`);

    // ---------------------------------------------------------------
    console.log('\n[Test 4] Helper list edited twice at the same moment...');
    const O4 = await mk('REPAIRING', 3, { assignedAt: new Date(), acknowledgedAt: new Date() });
    const codes4 = await Promise.all([
      send('PUT', `/repairs/${O4.id}/helpers`, recep, { technicianIds: [4, 5] }),
      send('PUT', `/repairs/${O4.id}/helpers`, admin, { technicianIds: [5, 6] }),
    ]);
    eq(JSON.stringify(codes4), JSON.stringify([200, 200]), 'both edits answered 200 (no 409 / 500 from a clash)');
    const helpers = (await prisma.repairOrderHelper.findMany({ where: { repairOrderId: O4.id }, orderBy: { technicianId: 'asc' } })).map(
      (h) => h.technicianId
    );
    assert(
      JSON.stringify(helpers) === '[4,5]' || JSON.stringify(helpers) === '[5,6]',
      `final list is exactly one of the two edits (got ${JSON.stringify(helpers)})`
    );
    eq(await prisma.statusLog.count({ where: { repairOrderId: O4.id, note: { contains: 'Helper technicians updated' } } }), 2, 'both edits logged');
    pass(`both 200; final helpers ${JSON.stringify(helpers)}; both logged`);

    console.log('\n==================================================================');
    console.log('PHASE 9 RACE TESTS PASSED');
    console.log('==================================================================\n');
  } finally {
    await prisma.employee.updateMany({
      where: { id: { in: TECHS } },
      data: { status: 'AVAILABLE', isActive: true, role: 'TECHNICIAN', availableSince: null, weeklyDayOff: null },
    });
    await prisma.$disconnect();
  }
}

main().catch(async (err) => {
  console.error('\nPhase 9 Race Test Failed:', err.message);
  await prisma.$disconnect();
  process.exit(1);
});
