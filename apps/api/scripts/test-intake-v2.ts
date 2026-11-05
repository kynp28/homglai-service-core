/**
 * Phase 2 tests: paper-form intake, intake edit (PATCH), RepairItem v2 + totalAmount,
 * technician visibility and staff search.
 *
 * Runs against the API started by test-runner.js (port 4000) on a *_test database.
 */
import axios, { AxiosResponse } from 'axios';
import prisma from '@homglai/db';
import { assertSafeDatabaseUrl } from '../src/utils/test-safety';
import { getBangkokDateOnly } from '../src/utils/date';
import { getJwtSecret } from '../src/config/env';
import jwt from 'jsonwebtoken';

const API_BASE = 'http://localhost:4000/api';

// Paper receipt numbers used by this suite (cleaned up before the run so it can be re-run)
const SAMPLE_RECEIPT = '5595';
const OTHER_RECEIPT = '5596';
const TECH1_ID = 3;
const TECH2_ID = 4;

type Headers = { Authorization: string };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

function assertEq(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    throw new Error(`ASSERTION FAILED: ${message}\n  Expected: ${JSON.stringify(expected)}\n  Actual:   ${JSON.stringify(actual)}`);
  }
}

/** Calls the API and asserts it fails with `status`. Returns the error response body. */
async function expectStatus(status: number, label: string, call: () => Promise<AxiosResponse>): Promise<any> {
  try {
    const res = await call();
    throw new Error(`ASSERTION FAILED: ${label} — expected HTTP ${status}, got ${res.status}`);
  } catch (err: any) {
    if (!err.response) throw err;
    if (err.response.status !== status) {
      throw new Error(
        `ASSERTION FAILED: ${label} — expected HTTP ${status}, got ${err.response.status}: ${JSON.stringify(err.response.data)}`
      );
    }
    console.log(`  [PASS] ${label} -> ${status}`);
    return err.response.data;
  }
}

/**
 * Issues a token for a seeded employee without calling POST /auth/login.
 * The login endpoint is rate limited (10 per 15 min per IP) and the smoke + concurrency suites
 * already use that budget; login itself is covered by the smoke suite. The API still loads the
 * employee from the DB on every request, so role and isActive checks remain real.
 */
async function login(username: string): Promise<Headers> {
  const employee = await prisma.employee.findUniqueOrThrow({ where: { username } });
  assert(employee.isActive, `seeded employee ${username} must be active`);
  const token = jwt.sign({ employeeId: employee.id, role: employee.role }, getJwtSecret(), {
    algorithm: 'HS256',
    expiresIn: '15m',
  });
  return { Authorization: `Bearer ${token}` };
}

function dateStr(value: string | Date): string {
  return new Date(value).toISOString().slice(0, 10);
}

function bangkokToday(offsetDays = 0): string {
  const d = getBangkokDateOnly(new Date());
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function randomPhone(): string {
  return `08${Math.floor(10000000 + Math.random() * 89999999)}`;
}

async function cleanupOrdersByReceipt(receipts: string[]): Promise<void> {
  const orders = await prisma.repairOrder.findMany({
    where: { paperReceiptNo: { in: receipts } },
    select: { id: true },
  });
  const ids = orders.map((o) => o.id);
  if (ids.length === 0) return;
  await prisma.statusLog.deleteMany({ where: { repairOrderId: { in: ids } } });
  await prisma.repairItem.deleteMany({ where: { repairOrderId: { in: ids } } });
  await prisma.repairOrderSymptom.deleteMany({ where: { repairOrderId: { in: ids } } });
  await prisma.repairOrder.deleteMany({ where: { id: { in: ids } } });
}

/** Puts an order in INSPECTING with the given technician (test setup; phase 4 will add accept). */
async function assignForInspection(orderId: number, technicianId: number): Promise<void> {
  await prisma.repairOrder.update({
    where: { id: orderId },
    data: { status: 'INSPECTING', technicianId, assignedAt: new Date(), acknowledgedAt: new Date() },
  });
  await prisma.employee.update({ where: { id: technicianId }, data: { status: 'BUSY' } });
}

async function main() {
  assertSafeDatabaseUrl();

  console.log('==================================================================');
  console.log('PHASE 2: INTAKE (PAPER FORM) / ITEMS v2 / VISIBILITY TEST SUITE');
  console.log('==================================================================\n');

  const admin = await login('admin');
  const recep = await login('receptionist');
  const tech1 = await login('tech1');
  const tech2 = await login('tech2');

  await cleanupOrdersByReceipt([SAMPLE_RECEIPT, OTHER_RECEIPT]);

  // Keep every new order unassigned (NEW) so visibility tests are deterministic.
  const originalTechStatuses = await prisma.employee.findMany({
    where: { role: 'TECHNICIAN' },
    select: { id: true, status: true },
  });
  await prisma.employee.updateMany({ where: { role: 'TECHNICIAN' }, data: { status: 'BUSY' } });

  try {
    // ---------------------------------------------------------------
    // 1. Intake with the real sample paper form (book 112 / no. 5595)
    // ---------------------------------------------------------------
    console.log('[Test 1] Intake from sample paper form (book 112, receipt 5595)...');
    const samplePhone = randomPhone();
    const createRes = await axios.post(
      `${API_BASE}/repairs`,
      {
        paperBookNo: ' 112 ',
        paperReceiptNo: SAMPLE_RECEIPT,
        workType: 'REPAIR',
        customer: { name: 'บจก. ชวัลชา', phone: samplePhone, address: '99/9 ถ.สุขุมวิท ต.บ้านสวน อ.เมือง จ.ชลบุรี' },
        machine: { brand: 'GEF', model: 'Aa+' },
        symptomIds: [1],
        warrantyStatus: 'OUT_OF_WARRANTY',
        billingType: 'CHARGE_OUT_OF_WARRANTY',
        accessories: { powerCord: true, other: 'ฝาครอบ' },
        careAdvice: { cleanAfterUse: true, noOverload: true },
        loanerMachine: false,
        warningNote: 'ระวังสายไฟชำรุด',
      },
      { headers: recep }
    );
    assertEq(createRes.status, 201, 'POST /api/repairs returns 201');
    const sample = createRes.data.data;
    assertEq(sample.status, 'NEW', 'sample order stays NEW (all technicians busy)');
    assertEq(sample.technicianId, null, 'sample order is unassigned');
    assertEq(sample.paperBookNo, '112', 'paperBookNo trimmed');
    assertEq(sample.paperReceiptNo, SAMPLE_RECEIPT, 'paperReceiptNo stored');
    assertEq(sample.workType, 'REPAIR', 'workType REPAIR');
    assertEq(dateStr(sample.receivedDate), bangkokToday(), 'receivedDate defaults to today (Asia/Bangkok)');
    assertEq(sample.warrantyStatus, 'OUT_OF_WARRANTY', 'warrantyStatus stored');
    assertEq(sample.warrantyExpiryDate, null, 'no warrantyExpiryDate when OUT_OF_WARRANTY');
    assertEq(sample.billingType, 'CHARGE_OUT_OF_WARRANTY', 'billingType stored');
    assertEq(sample.accessories.powerCord, true, 'accessories.powerCord ticked');
    assertEq(sample.accessories.other, 'ฝาครอบ', 'accessories.other = ฝาครอบ');
    for (const key of ['drainTray', 'portafilter', 'basket1Shot', 'basket2Shot', 'waterTank', 'tamper', 'steamWandCover']) {
      assertEq(sample.accessories[key], false, `accessories.${key} defaults to false`);
    }
    assertEq(sample.careAdvice.cleanAfterUse, true, 'careAdvice.cleanAfterUse');
    assertEq(sample.careAdvice.noOverload, true, 'careAdvice.noOverload');
    assertEq(sample.loanerMachine, false, 'loanerMachine false');
    assertEq(sample.warningNote, 'ระวังสายไฟชำรุด', 'warningNote stored');
    assertEq(sample.customer.address, '99/9 ถ.สุขุมวิท ต.บ้านสวน อ.เมือง จ.ชลบุรี', 'customer.address stored');
    assert(sample.lastActivityAt, 'lastActivityAt set on create');
    assert(!('lineUserId' in sample.customer), 'customer.lineUserId never returned');
    console.log(`  [PASS] Sample order ${sample.jobNumber} created with all paper-form fields.`);

    // Address is not cleared when a later intake for the same customer omits it
    const repeat = await axios.post(
      `${API_BASE}/repairs`,
      { customer: { name: 'บจก. ชวัลชา', phone: samplePhone }, machine: { brand: 'GEF', model: 'Aa+' }, symptomIds: [1] },
      { headers: recep }
    );
    assertEq(repeat.data.data.customer.address, sample.customer.address, 'existing customer.address kept when omitted');
    assertEq(repeat.data.data.paperReceiptNo, null, 'paperReceiptNo optional (legacy-compatible intake)');
    console.log('  [PASS] Omitted address does not clear the stored customer address; paperReceiptNo optional.');

    // ---------------------------------------------------------------
    // 2. Intake validation
    // ---------------------------------------------------------------
    console.log('\n[Test 2] Intake validation...');
    const base = () => ({
      customer: { name: 'Validation Customer', phone: randomPhone() },
      machine: { brand: 'GEF', model: 'Aa+' },
      symptomIds: [1],
    });
    const dupBody = await expectStatus(409, 'Duplicate paperReceiptNo', () =>
      axios.post(`${API_BASE}/repairs`, { ...base(), paperReceiptNo: SAMPLE_RECEIPT }, { headers: recep })
    );
    assert(/paper receipt/i.test(dupBody.message), `409 message names the paper receipt (got "${dupBody.message}")`);
    await expectStatus(400, 'paperReceiptNo with letters', () =>
      axios.post(`${API_BASE}/repairs`, { ...base(), paperReceiptNo: 'A5595' }, { headers: recep })
    );
    await expectStatus(400, 'paperReceiptNo longer than 10 digits', () =>
      axios.post(`${API_BASE}/repairs`, { ...base(), paperReceiptNo: '12345678901' }, { headers: recep })
    );
    await expectStatus(400, 'paperBookNo longer than 20 characters', () =>
      axios.post(`${API_BASE}/repairs`, { ...base(), paperBookNo: 'x'.repeat(21) }, { headers: recep })
    );
    await expectStatus(400, 'accessories with unknown key', () =>
      axios.post(`${API_BASE}/repairs`, { ...base(), accessories: { powerCord: true, milkJug: true } }, { headers: recep })
    );
    await expectStatus(400, 'accessories.other longer than 100 characters', () =>
      axios.post(`${API_BASE}/repairs`, { ...base(), accessories: { other: 'x'.repeat(101) } }, { headers: recep })
    );
    await expectStatus(400, 'careAdvice with unknown key', () =>
      axios.post(`${API_BASE}/repairs`, { ...base(), careAdvice: { cleanAfterUse: true, descale: true } }, { headers: recep })
    );
    await expectStatus(400, 'IN_WARRANTY without warrantyExpiryDate', () =>
      axios.post(`${API_BASE}/repairs`, { ...base(), warrantyStatus: 'IN_WARRANTY' }, { headers: recep })
    );
    await expectStatus(400, 'OUT_OF_WARRANTY with warrantyExpiryDate', () =>
      axios.post(
        `${API_BASE}/repairs`,
        { ...base(), warrantyStatus: 'OUT_OF_WARRANTY', warrantyExpiryDate: '2027-01-31' },
        { headers: recep }
      )
    );
    await expectStatus(400, 'workType other than REPAIR', () =>
      axios.post(`${API_BASE}/repairs`, { ...base(), workType: 'ONSITE_REPAIR' }, { headers: recep })
    );
    await expectStatus(400, 'receivedDate 2 days in the future', () =>
      axios.post(`${API_BASE}/repairs`, { ...base(), receivedDate: bangkokToday(2) }, { headers: recep })
    );
    await expectStatus(400, 'receivedDate not a real date', () =>
      axios.post(`${API_BASE}/repairs`, { ...base(), receivedDate: '2026-02-30' }, { headers: recep })
    );
    await expectStatus(400, 'missing symptoms (minimum required fields unchanged)', () =>
      axios.post(`${API_BASE}/repairs`, { ...base(), symptomIds: [] }, { headers: recep })
    );

    const warrantyRes = await axios.post(
      `${API_BASE}/repairs`,
      {
        ...base(),
        paperReceiptNo: OTHER_RECEIPT,
        warrantyStatus: 'IN_WARRANTY',
        warrantyExpiryDate: '2027-03-31',
        billingType: 'NO_CHARGE_IN_WARRANTY',
        receivedDate: bangkokToday(-1),
        loanerMachine: true,
        loanerNote: 'เครื่องสำรอง LEHEHE #3',
      },
      { headers: admin }
    );
    const warrantyOrder = warrantyRes.data.data;
    assertEq(dateStr(warrantyOrder.warrantyExpiryDate), '2027-03-31', 'IN_WARRANTY + expiry accepted');
    assertEq(dateStr(warrantyOrder.receivedDate), bangkokToday(-1), 'receivedDate can be set to yesterday');
    assertEq(warrantyOrder.loanerNote, 'เครื่องสำรอง LEHEHE #3', 'loanerNote stored');
    const tomorrowRes = await axios.post(
      `${API_BASE}/repairs`,
      { ...base(), receivedDate: bangkokToday(1) },
      { headers: recep }
    );
    assertEq(dateStr(tomorrowRes.data.data.receivedDate), bangkokToday(1), 'receivedDate tomorrow (+1 day) allowed');
    console.log('  [PASS] Valid warranty / loaner / receivedDate variants accepted by ADMIN and RECEPTIONIST.');

    // ---------------------------------------------------------------
    // 3. Role checks for create / edit
    // ---------------------------------------------------------------
    console.log('\n[Test 3] Technician cannot create or edit intake...');
    await expectStatus(403, 'TECHNICIAN POST /api/repairs', () =>
      axios.post(`${API_BASE}/repairs`, base(), { headers: tech1 })
    );
    await expectStatus(403, 'TECHNICIAN PATCH /api/repairs/:id', () =>
      axios.patch(`${API_BASE}/repairs/${sample.id}`, { warningNote: 'x' }, { headers: tech1 })
    );

    // ---------------------------------------------------------------
    // 4. Technician visibility (SRS 4)
    // ---------------------------------------------------------------
    console.log('\n[Test 4] Technician visibility...');
    await expectStatus(403, 'TECHNICIAN viewing unassigned NEW order', () =>
      axios.get(`${API_BASE}/repairs/${sample.id}`, { headers: tech1 })
    );
    const tech1ListBefore = await axios.get(`${API_BASE}/repairs?limit=100`, { headers: tech1 });
    const tech1Orders: any[] = tech1ListBefore.data.data.orders;
    assert(!tech1Orders.some((o) => o.id === sample.id), 'unassigned NEW order is not in technician list');
    assert(tech1Orders.every((o) => o.technicianId === TECH1_ID), 'technician list contains only own orders');
    const tech1NewList = await axios.get(`${API_BASE}/repairs?status=NEW&limit=100`, { headers: tech1 });
    assert(
      tech1NewList.data.data.orders.every((o: any) => o.technicianId === TECH1_ID),
      'status=NEW filter for technician returns only own (reserved) orders'
    );
    console.log('  [PASS] Unassigned NEW orders are not listed for technicians.');

    // Order reserved for tech1 but not yet accepted (NEW + technicianId) is visible to tech1 only
    await prisma.repairOrder.update({
      where: { id: warrantyOrder.id },
      data: { technicianId: TECH1_ID, assignedAt: new Date() },
    });
    const reservedView = await axios.get(`${API_BASE}/repairs/${warrantyOrder.id}`, { headers: tech1 });
    assertEq(reservedView.data.data.status, 'NEW', 'reserved order still NEW');
    assert(
      (await axios.get(`${API_BASE}/repairs?limit=100`, { headers: tech1 })).data.data.orders.some(
        (o: any) => o.id === warrantyOrder.id
      ),
      'order awaiting acceptance appears in its technician list'
    );
    await expectStatus(403, 'Other TECHNICIAN viewing reserved order', () =>
      axios.get(`${API_BASE}/repairs/${warrantyOrder.id}`, { headers: tech2 })
    );
    await prisma.repairOrder.update({
      where: { id: warrantyOrder.id },
      data: { technicianId: null, assignedAt: null },
    });

    // ---------------------------------------------------------------
    // 5. PATCH /api/repairs/:id (edit intake)
    // ---------------------------------------------------------------
    console.log('\n[Test 5] PATCH /api/repairs/:id ...');
    const patchRes = await axios.patch(
      `${API_BASE}/repairs/${sample.id}`,
      {
        customer: { address: 'ที่อยู่ใหม่ ชลบุรี' },
        accessories: { powerCord: true, tamper: true, other: 'ฝาครอบ' },
        warningNote: 'ระวังสายไฟชำรุด (แก้ไข)',
        machine: { serialNumber: 'GEF-AA-0001' },
      },
      { headers: recep }
    );
    const patched = patchRes.data.data;
    assertEq(patched.customer.address, 'ที่อยู่ใหม่ ชลบุรี', 'customer.address updated');
    assertEq(patched.accessories.tamper, true, 'accessories updated');
    assertEq(patched.machine.serialNumber, 'GEF-AA-0001', 'machine.serialNumber updated');
    assertEq(patched.status, 'NEW', 'status unchanged by intake edit');
    const editLog = patched.statusLogs[patched.statusLogs.length - 1];
    assertEq(editLog.status, 'NEW', 'edit StatusLog uses current status');
    assertEq(editLog.changedBy?.id, 2, 'edit StatusLog records the receptionist');
    for (const field of ['customer.address', 'accessories', 'warningNote', 'machine.serialNumber']) {
      assert(editLog.note.includes(field), `edit StatusLog lists changed field ${field}`);
    }
    assert(!editLog.note.includes('ที่อยู่ใหม่'), 'edit StatusLog does not contain values');
    console.log('  [PASS] Intake edited; StatusLog lists changed field names only.');

    const logCountBefore = patched.statusLogs.length;
    const noopRes = await axios.patch(
      `${API_BASE}/repairs/${sample.id}`,
      { warningNote: 'ระวังสายไฟชำรุด (แก้ไข)', accessories: { other: 'ฝาครอบ', tamper: true, powerCord: true } },
      { headers: admin }
    );
    assertEq(noopRes.data.data.statusLogs.length, logCountBefore, 'no-op edit adds no StatusLog (JSON key order ignored)');
    console.log('  [PASS] Re-sending identical values is a no-op.');

    await expectStatus(400, 'PATCH with status', () =>
      axios.patch(`${API_BASE}/repairs/${sample.id}`, { status: 'CANCELLED' }, { headers: admin })
    );
    await expectStatus(400, 'PATCH with technicianId', () =>
      axios.patch(`${API_BASE}/repairs/${sample.id}`, { technicianId: TECH1_ID }, { headers: admin })
    );
    await expectStatus(400, 'PATCH with jobNumber', () =>
      axios.patch(`${API_BASE}/repairs/${sample.id}`, { jobNumber: 'REP-HACK-0001' }, { headers: admin })
    );
    await expectStatus(400, 'PATCH with customer.phone', () =>
      axios.patch(`${API_BASE}/repairs/${sample.id}`, { customer: { phone: '0899999999' } }, { headers: admin })
    );
    await expectStatus(400, 'PATCH with empty body', () =>
      axios.patch(`${API_BASE}/repairs/${sample.id}`, {}, { headers: admin })
    );
    await expectStatus(400, 'PATCH to IN_WARRANTY without expiry (merged check)', () =>
      axios.patch(`${API_BASE}/repairs/${sample.id}`, { warrantyStatus: 'IN_WARRANTY' }, { headers: admin })
    );
    await expectStatus(409, 'PATCH paperReceiptNo to one already used', () =>
      axios.patch(`${API_BASE}/repairs/${sample.id}`, { paperReceiptNo: OTHER_RECEIPT }, { headers: admin })
    );
    await expectStatus(404, 'PATCH unknown order', () =>
      axios.patch(`${API_BASE}/repairs/999999999`, { warningNote: 'x' }, { headers: admin })
    );
    const switchWarranty = await axios.patch(
      `${API_BASE}/repairs/${warrantyOrder.id}`,
      { warrantyStatus: 'OUT_OF_WARRANTY', warrantyExpiryDate: null, billingType: 'CHARGE_OUT_OF_WARRANTY' },
      { headers: admin }
    );
    assertEq(switchWarranty.data.data.warrantyExpiryDate, null, 'warranty switched to OUT_OF_WARRANTY with expiry cleared');

    // Closed orders cannot be edited
    await prisma.repairOrder.update({ where: { id: tomorrowRes.data.data.id }, data: { status: 'CANCELLED' } });
    await expectStatus(409, 'PATCH CANCELLED order', () =>
      axios.patch(`${API_BASE}/repairs/${tomorrowRes.data.data.id}`, { warningNote: 'x' }, { headers: admin })
    );
    await prisma.repairOrder.update({ where: { id: tomorrowRes.data.data.id }, data: { status: 'DELIVERED' } });
    await expectStatus(409, 'PATCH DELIVERED order', () =>
      axios.patch(`${API_BASE}/repairs/${tomorrowRes.data.data.id}`, { warningNote: 'x' }, { headers: admin })
    );

    // ---------------------------------------------------------------
    // 6. RepairItem v2 + totalAmount (sample receipt: 250 + 215 + 350 = 815.00)
    // ---------------------------------------------------------------
    console.log('\n[Test 6] RepairItem v2 and totalAmount...');
    await assignForInspection(sample.id, TECH1_ID);
    const activityBefore = (await prisma.repairOrder.findUniqueOrThrow({ where: { id: sample.id } })).lastActivityAt;
    await new Promise((r) => setTimeout(r, 20));

    const part = await axios.post(
      `${API_BASE}/repairs/${sample.id}/items`,
      { name: 'อะไหล่ตามบาร์โค้ด', itemType: 'PART', barcode: '1681573', quantity: 1, unitPrice: 250 },
      { headers: tech1 }
    );
    const partItem = part.data.data.item;
    assertEq(partItem.itemType, 'PART', 'PART itemType');
    assertEq(partItem.barcode, '1681573', 'barcode stored');
    assertEq(partItem.quantity, 1, 'quantity 1');
    assertEq(partItem.unitPrice, '250.00', 'unitPrice formatted');
    assertEq(partItem.amount, '250.00', 'amount = quantity x unitPrice');
    assertEq(partItem.price, '250.00', 'legacy price alias kept');
    assertEq(partItem.status, 'PENDING', 'item PENDING');
    assert('resolvedById' in partItem && 'resolutionChannel' in partItem, 'resolution fields present');

    // Legacy `price` alias still accepted
    const travel = await axios.post(
      `${API_BASE}/repairs/${sample.id}/items`,
      { name: 'ค่าเดินทาง', itemType: 'TRAVEL_FEE', quantity: 1, price: 215 },
      { headers: tech1 }
    );
    assertEq(travel.data.data.item.unitPrice, '215.00', 'legacy price alias maps to unitPrice');
    await axios.post(
      `${API_BASE}/repairs/${sample.id}/items`,
      { name: 'ค่าบริการ', itemType: 'SERVICE_FEE', quantity: 1, unitPrice: '350' },
      { headers: admin }
    );

    // LABOR_HOURS: hours only, price 0 allowed
    const labor = await axios.post(
      `${API_BASE}/repairs/${sample.id}/items`,
      { name: 'ชั่วโมงทำงาน', itemType: 'LABOR_HOURS', quantity: 2, unitPrice: 0 },
      { headers: tech1 }
    );
    assertEq(labor.data.data.item.amount, '0.00', 'LABOR_HOURS with unitPrice 0 accepted');

    // An item that will be REJECTED must not count in totalAmount
    const rejected = await axios.post(
      `${API_BASE}/repairs/${sample.id}/items`,
      { name: 'ปะเก็น', itemType: 'PART', quantity: 3, unitPrice: 10.1 },
      { headers: tech1 }
    );
    assertEq(rejected.data.data.item.amount, '30.30', 'amount uses Decimal math (3 x 10.10 = 30.30)');
    await axios.patch(
      `${API_BASE}/repairs/${sample.id}/items/${rejected.data.data.item.id}/status`,
      { status: 'REJECTED' },
      { headers: admin }
    );

    const detail = (await axios.get(`${API_BASE}/repairs/${sample.id}`, { headers: tech1 })).data.data;
    assertEq(detail.totalAmount, '815.00', 'totalAmount = 250 + 215 + 350 (+0 labor, rejected excluded)');
    assertEq(detail.repairItems.length, 5, 'five items on the order');
    for (const item of detail.repairItems) {
      for (const key of ['quantity', 'unitPrice', 'amount', 'itemType', 'barcode', 'status', 'price']) {
        assert(key in item, `item ${item.id} has ${key}`);
      }
    }
    assertEq(detail.customer.phone, samplePhone, 'assigned technician sees the full phone number');
    assert(!('trackingToken' in detail), 'trackingToken hidden from technician');
    for (const key of ['paperBookNo', 'paperReceiptNo', 'receivedDate', 'workType', 'warrantyStatus', 'warrantyExpiryDate',
      'billingType', 'loanerMachine', 'loanerNote', 'accessories', 'careAdvice', 'warningNote', 'lastActivityAt']) {
      assert(key in detail, `detail includes ${key}`);
    }
    const activityAfter = (await prisma.repairOrder.findUniqueOrThrow({ where: { id: sample.id } })).lastActivityAt;
    assert(activityAfter && activityBefore && activityAfter > activityBefore, 'adding items updates lastActivityAt');
    console.log('  [PASS] Sample order totalAmount = 815.00 with all v2 item fields.');

    await expectStatus(403, 'Other TECHNICIAN viewing assigned order', () =>
      axios.get(`${API_BASE}/repairs/${sample.id}`, { headers: tech2 })
    );

    // Item validation
    const itemUrl = `${API_BASE}/repairs/${sample.id}/items`;
    await expectStatus(400, 'PART with unitPrice 0', () =>
      axios.post(itemUrl, { name: 'x', itemType: 'PART', unitPrice: 0 }, { headers: tech1 })
    );
    await expectStatus(400, 'quantity 1000', () =>
      axios.post(itemUrl, { name: 'x', quantity: 1000, unitPrice: 10 }, { headers: tech1 })
    );
    await expectStatus(400, 'quantity 0', () =>
      axios.post(itemUrl, { name: 'x', quantity: 0, unitPrice: 10 }, { headers: tech1 })
    );
    await expectStatus(400, 'quantity 1.5', () =>
      axios.post(itemUrl, { name: 'x', quantity: 1.5, unitPrice: 10 }, { headers: tech1 })
    );
    await expectStatus(400, 'unknown itemType', () =>
      axios.post(itemUrl, { name: 'x', itemType: 'DISCOUNT', unitPrice: 10 }, { headers: tech1 })
    );
    await expectStatus(400, 'missing unitPrice and price', () =>
      axios.post(itemUrl, { name: 'x' }, { headers: tech1 })
    );
    await expectStatus(400, 'unitPrice and price disagree', () =>
      axios.post(itemUrl, { name: 'x', unitPrice: 10, price: 20 }, { headers: tech1 })
    );
    await expectStatus(400, 'unitPrice with 3 decimals', () =>
      axios.post(itemUrl, { name: 'x', unitPrice: 10.123 }, { headers: tech1 })
    );
    await expectStatus(400, 'barcode longer than 64 characters', () =>
      axios.post(itemUrl, { name: 'x', unitPrice: 10, barcode: '9'.repeat(65) }, { headers: tech1 })
    );

    // ---------------------------------------------------------------
    // 7. Staff search + list summary fields
    // ---------------------------------------------------------------
    console.log('\n[Test 7] Staff search and list fields...');
    const searchCases: [string, string][] = [
      ['paperReceiptNo', SAMPLE_RECEIPT],
      ['paperBookNo', '112'],
      ['customer.name', 'ชวัลชา'],
      ['jobNumber', sample.jobNumber],
      ['customer.phone', samplePhone],
    ];
    for (const [label, term] of searchCases) {
      const res = await axios.get(`${API_BASE}/repairs?limit=100&search=${encodeURIComponent(term)}`, { headers: recep });
      const found = res.data.data.orders.find((o: any) => o.id === sample.id);
      assert(found, `search by ${label} ("${term}") finds the sample order`);
    }
    const listed = (await axios.get(`${API_BASE}/repairs?limit=100&search=${SAMPLE_RECEIPT}`, { headers: admin })).data.data
      .orders.find((o: any) => o.id === sample.id);
    assertEq(listed.paperReceiptNo, SAMPLE_RECEIPT, 'list includes paperReceiptNo');
    assertEq(dateStr(listed.receivedDate), bangkokToday(), 'list includes receivedDate');
    assertEq(listed.warrantyStatus, 'OUT_OF_WARRANTY', 'list includes warrantyStatus');
    assert(!('trackingToken' in listed), 'list does not include trackingToken');
    const techSearch = await axios.get(`${API_BASE}/repairs?limit=100&search=${OTHER_RECEIPT}`, { headers: tech1 });
    assertEq(techSearch.data.data.orders.length, 0, 'technician search cannot reach orders of others');
    console.log('  [PASS] Search by paperReceiptNo, paperBookNo, customer name, jobNumber and phone.');

    console.log('\n==================================================================');
    console.log('PHASE 2 INTAKE / ITEMS v2 / VISIBILITY TESTS PASSED');
    console.log('==================================================================\n');
  } finally {
    for (const t of originalTechStatuses) {
      await prisma.employee.update({ where: { id: t.id }, data: { status: t.status } });
    }
    await prisma.$disconnect();
  }
}

main().catch(async (err) => {
  console.error('\nPhase 2 Test Failed:', err.response?.data || err.message);
  await prisma.$disconnect();
  process.exit(1);
});
