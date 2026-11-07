/**
 * Phase 9: one full end-to-end path through the API, following the sample paper form
 * (book 112, receipt 5595): intake + intake photo -> technician RESERVED -> accept -> PART /
 * TRAVEL_FEE / SERVICE_FEE items -> phone confirmation -> items done -> complete + summary +
 * DELIVERY photo -> RECEPTIONIST delivers with payment -> public search by "5595" and by job
 * number with no personal data -> closedAt set -> photos purged after 30 days.
 * Runs against the API started by test-runner.js on a *_test database.
 */
import fs from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';
import sharp from 'sharp';
import prisma from '@homglai/db';
import { assertSafeDatabaseUrl } from '../src/utils/test-safety';
import { getAppConfig, getJwtSecret } from '../src/config/env';
import { getStorage, LocalDiskStorage } from '../src/storage/storage.service';
import { purgeExpiredImages } from '../src/services/image.service';

type Headers = Record<string, string>;
const API = 'http://localhost:4000/api';
const TECHS = [3, 4, 5, 6, 7];
const ADMIN = 1;
const RECEP = 2;
const TECH = 3;
const RECEIPT = '5595';
const DAY = 86_400_000;

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
/** JSON call that must succeed with `expected`; returns the parsed body. */
async function call(method: string, url: string, headers: Headers, body?: unknown, expected = 200): Promise<any> {
  const res = await fetch(`${API}${url}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (res.status !== expected) throw new Error(`ASSERTION FAILED: ${method} ${url} — expected HTTP ${expected}, got ${res.status}: ${text}`);
  return JSON.parse(text);
}
async function uploadPhoto(orderId: number, kind: string, headers: Headers): Promise<void> {
  const data = await sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 120, g: 80, b: 40 } } }).jpeg().toBuffer();
  const fd = new FormData();
  fd.append('kind', kind);
  fd.append('files', new Blob([new Uint8Array(data)], { type: 'image/jpeg' }), `${kind.toLowerCase()}.jpg`);
  const res = await fetch(`${API}/repairs/${orderId}/images`, { method: 'POST', headers, body: fd });
  if (res.status !== 201) throw new Error(`ASSERTION FAILED: upload ${kind} — expected 201, got ${res.status}: ${await res.text()}`);
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
  await prisma.employee.updateMany({
    where: { id: { in: TECHS } },
    data: { status: 'OFFLINE', isActive: true, role: 'TECHNICIAN', availableSince: null, weeklyDayOff: null },
  });
}

async function main() {
  assertSafeDatabaseUrl();
  console.log('==================================================================');
  console.log('PHASE 9: END-TO-END — SAMPLE PAPER FORM (BOOK 112, RECEIPT 5595)');
  console.log('==================================================================\n');
  const cfg = getAppConfig();
  const storage = getStorage();
  assert(storage instanceof LocalDiskStorage, 'local disk storage in tests');
  const [admin, recep, tech] = await Promise.all([tokenFor(ADMIN), tokenFor(RECEP), tokenFor(TECH)]);
  await resetWorld();

  try {
    // 1. Intake (front desk) + intake photo; the only free technician is reserved
    console.log('[Step 1] Intake from the paper form + intake photo...');
    await prisma.employee.update({ where: { id: TECH }, data: { status: 'AVAILABLE', availableSince: new Date(Date.now() - 60_000) } });
    const phone = `0861${String(Date.now()).slice(-6)}`;
    const customerName = 'บจก. ชวัลชา อีทูอี';
    const address = '99/9 ถ.สุขุมวิท ต.บ้านสวน อ.เมือง จ.ชลบุรี';
    const created = (
      await call(
        'POST',
        '/repairs',
        recep,
        {
          paperBookNo: '112',
          paperReceiptNo: RECEIPT,
          workType: 'REPAIR',
          customer: { name: customerName, phone, address },
          machine: { brand: 'GEF', model: 'Aa+', serialNumber: 'E2E-SN-0001' },
          symptomIds: [1],
          warrantyStatus: 'OUT_OF_WARRANTY',
          billingType: 'CHARGE_OUT_OF_WARRANTY',
          accessories: { powerCord: true },
          careAdvice: { cleanAfterUse: true },
          loanerMachine: false,
          warningNote: 'ระวังสายไฟชำรุด',
        },
        201
      )
    ).data;
    const id: number = created.id;
    const jobNumber: string = created.jobNumber;
    assert(/^REP-\d{4}-\d{4}$/.test(jobNumber), `job number format (${jobNumber})`);
    eq(created.status, 'NEW', 'new order is NEW');
    eq(created.technicianId, TECH, 'reserved for the free technician');
    eq((await prisma.employee.findUniqueOrThrow({ where: { id: TECH } })).status, 'RESERVED', 'technician RESERVED');
    eq(await prisma.notification.count({ where: { recipientId: TECH, type: 'JOB_RESERVED', repairOrderId: id } }), 1, 'technician notified');
    await uploadPhoto(id, 'INTAKE', recep);
    pass(`${jobNumber} created from book 112 / no. ${RECEIPT}; technician RESERVED and notified; intake photo stored`);

    // 2. Technician accepts
    console.log('\n[Step 2] Technician accepts...');
    const accepted = (await call('POST', `/repairs/${id}/accept`, tech)).data;
    eq(accepted.status, 'INSPECTING', 'INSPECTING after accept');
    eq((await prisma.employee.findUniqueOrThrow({ where: { id: TECH } })).status, 'BUSY', 'technician BUSY');
    pass('Accepted: NEW -> INSPECTING, technician BUSY');

    // 3. Quotation lines like the paper form
    console.log('\n[Step 3] Quotation lines (PART / TRAVEL_FEE / SERVICE_FEE)...');
    const lines = [
      { name: 'ปั๊มน้ำ', itemType: 'PART', quantity: 1, unitPrice: '250' },
      { name: 'ค่าเดินทาง', itemType: 'TRAVEL_FEE', quantity: 1, unitPrice: '215' },
      { name: 'ค่าบริการ', itemType: 'SERVICE_FEE', quantity: 1, unitPrice: '350' },
    ];
    const itemIds: number[] = [];
    for (const line of lines) itemIds.push((await call('POST', `/repairs/${id}/items`, tech, line, 201)).data.item.id);
    let detail = (await call('GET', `/repairs/${id}`, recep)).data;
    eq(detail.status, 'WAITING_APPROVAL', 'WAITING_APPROVAL after quotation');
    eq(detail.totalAmount, '815.00', 'total 250 + 215 + 350');
    pass('Three lines added; total 815.00; waiting for the customer');

    // 4. Technician records the phone confirmation of each line
    console.log('\n[Step 4] Phone confirmation recorded by the technician...');
    let last: any;
    for (const itemId of itemIds) {
      last = await call('PATCH', `/repairs/${id}/items/${itemId}/status`, tech, { status: 'APPROVED', note: 'ลูกค้าตกลงทางโทรศัพท์' });
    }
    eq(last.data.order.status, 'REPAIRING', 'all approved -> REPAIRING');
    const items = await prisma.repairItem.findMany({ where: { repairOrderId: id } });
    assert(items.every((i) => i.resolutionChannel === 'PHONE' && i.resolvedById === TECH && i.resolvedAt), 'channel PHONE, who and when stored');
    pass('Every line APPROVED by phone (who / when / channel stored); order REPAIRING');

    // 5. Work done: items completed, job completed with summary, delivery photo
    console.log('\n[Step 5] Items done, job completed with summary, delivery photo...');
    for (const itemId of itemIds) await call('PATCH', `/repairs/${id}/items/${itemId}/complete`, tech, {});
    const done = (await call('POST', `/repairs/${id}/complete`, tech, { completionSummary: 'เปลี่ยนปั๊มน้ำ ทดสอบปั่น 3 รอบ ปกติ' })).data;
    eq(done.status, 'COMPLETED', 'COMPLETED');
    eq((await prisma.employee.findUniqueOrThrow({ where: { id: TECH } })).status, 'AVAILABLE', 'technician free again');
    await uploadPhoto(id, 'DELIVERY', tech);
    eq(await prisma.repairOrderImage.count({ where: { repairOrderId: id } }), 2, 'intake + delivery photos');
    pass('Completed with summary; technician AVAILABLE; delivery photo stored');

    // 6. Front desk delivers and records the payment; the order closes
    console.log('\n[Step 6] RECEPTIONIST delivers with payment...');
    const delivered = (await call('PATCH', `/repairs/${id}/status`, recep, { status: 'DELIVERED', payment: { amount: 815, method: 'CASH' } })).data;
    eq(delivered.status, 'DELIVERED', 'DELIVERED');
    const closed = await prisma.repairOrder.findUniqueOrThrow({ where: { id } });
    assert(closed.closedAt instanceof Date, 'closedAt set');
    eq(closed.repairOutcome, 'REPAIRED', 'outcome REPAIRED');
    pass('Delivered; payment recorded; closedAt set');

    // 7. Public search by paper number and by job number, PDPA whitelist only
    console.log('\n[Step 7] Public search by "5595" and by job number...');
    const secrets = [customerName, phone, address, 'E2E-SN-0001', closed.trackingToken, 'ปั๊มน้ำ', 'ค่าเดินทาง', 'ค่าบริการ', 'ลูกค้าตกลง', 'เปลี่ยนปั๊มน้ำ', 'ระวังสายไฟ'];
    const techName = (await prisma.employee.findUniqueOrThrow({ where: { id: TECH } })).name;
    for (const query of [RECEIPT, jobNumber]) {
      const res = await fetch(`${API}/tracking/search`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) });
      const text = await res.text();
      eq(res.status, 200, `search "${query}" found`);
      const view = JSON.parse(text).data;
      eq(view.jobNumber, jobNumber, `search "${query}" -> ${jobNumber}`);
      eq(view.status, 'DELIVERED', 'public status DELIVERED');
      eq(JSON.stringify(Object.keys(view).sort()), JSON.stringify(['jobNumber', 'machine', 'receivedDate', 'status', 'statusLabelTh', 'timeline', 'updatedAt']), 'whitelisted keys only');
      for (const s of [...secrets, techName]) assert(!text.includes(s), `public response does not contain "${s}"`);
      for (const key of ['price', 'amount', 'unitPrice', 'payment', 'phone', 'image', 'technician', 'customer']) {
        assert(!text.toLowerCase().includes(`"${key.toLowerCase()}`), `no "${key}" field`);
      }
      eq(
        view.timeline.map((t: any) => t.status).join('>'),
        'NEW>INSPECTING>WAITING_APPROVAL>REPAIRING>COMPLETED>DELIVERED',
        'timeline follows the job'
      );
    }
    pass('Found by "5595" and by job number; no name, phone, address, serial, token, technician, items or prices');

    // 8. Photos purged 30 days after closing (counted from closedAt)
    console.log(`\n[Step 8] Photos purged ${cfg.imageRetentionDays} days after closing...`);
    const stored = (await prisma.repairOrderImage.findMany({ where: { repairOrderId: id } })).map((i) => i.storagePath);
    assert(stored.every((p) => fs.existsSync(path.join(storage.root, p))), 'photo files on disk before purge');
    const closedAt = closed.closedAt!.getTime();
    eq(await purgeExpiredImages(new Date(closedAt + (cfg.imageRetentionDays - 1) * DAY)), 0, `day ${cfg.imageRetentionDays - 1}: nothing purged`);
    eq(await prisma.repairOrderImage.count({ where: { repairOrderId: id } }), 2, 'photos kept before expiry');
    eq(await purgeExpiredImages(new Date(closedAt + (cfg.imageRetentionDays + 1) * DAY)), 2, `day ${cfg.imageRetentionDays + 1}: both photos purged`);
    eq(await prisma.repairOrderImage.count({ where: { repairOrderId: id } }), 0, 'photo records removed');
    assert(stored.every((p) => !fs.existsSync(path.join(storage.root, p))), 'photo files removed from disk');
    eq((await prisma.repairOrder.findUniqueOrThrow({ where: { id } })).status, 'DELIVERED', 'order itself is kept');
    pass('Photos kept until day 30, removed (records + files) after; the order stays');

    console.log('\n==================================================================');
    console.log('PHASE 9 END-TO-END TEST PASSED');
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
  console.error('\nPhase 9 E2E Test Failed:', err.message);
  await prisma.$disconnect();
  process.exit(1);
});
