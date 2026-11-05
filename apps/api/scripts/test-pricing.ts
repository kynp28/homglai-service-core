/**
 * Phase 5 tests: price confirmation by phone, CUSTOMER_LINE_APPROVAL_ENABLED flag, POST /complete
 * (+ helper technicians, owner request), POST /still-working, needsProgressUpdate, PUT /helpers.
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
import { LineWebhookService } from '../src/services/line-webhook.service';

const API = 'http://localhost:4000/api';
const LINE_SECRET = process.env.LINE_CHANNEL_SECRET || 'test-line-secret';
const ADMIN = 1;
const RECEP = 2;
const TECHS = [3, 4, 5, 6, 7];
const OWNER_LINE = 'U_PRICING_OWNER';

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
async function tokenFor(id: number): Promise<Headers> {
  const e = await prisma.employee.findUniqueOrThrow({ where: { id } });
  return {
    Authorization: `Bearer ${jwt.sign({ employeeId: e.id, role: e.role }, getJwtSecret(), { algorithm: 'HS256', expiresIn: '30m' })}`,
  };
}
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
const order = (id: number) => prisma.repairOrder.findUniqueOrThrow({ where: { id } });
const item = (id: number) => prisma.repairItem.findUniqueOrThrow({ where: { id } });
const tech = (id: number) => prisma.employee.findUniqueOrThrow({ where: { id } });

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
    data: { status: 'OFFLINE', isActive: true, role: 'TECHNICIAN', availableSince: null },
  });
}

function signedWebhook(body: any) {
  const raw = JSON.stringify(body);
  return axios.post(`${API}/webhook/line`, raw, {
    headers: {
      'Content-Type': 'application/json',
      'x-line-signature': crypto.createHmac('sha256', LINE_SECRET).update(raw).digest('base64'),
    },
  });
}

async function main() {
  assertSafeDatabaseUrl();
  console.log('==================================================================');
  console.log('PHASE 5: PHONE PRICE CONFIRMATION / LINE FLAG / COMPLETE / STILL WORKING');
  console.log('==================================================================\n');

  const admin = await tokenFor(ADMIN);
  const recep = await tokenFor(RECEP);
  const t: Record<number, Headers> = {};
  for (const id of TECHS) t[id] = await tokenFor(id);

  await resetWorld();
  const customer = await prisma.customer.create({ data: { name: 'Pricing Customer', phone: `0852${String(Date.now()).slice(-6)}` } });
  const machine = await prisma.machine.create({ data: { brand: 'GEF', model: 'Aa+', customerId: customer.id } });
  let seq = 0;
  const mk = (status: any, technicianId: number | null, extra: any = {}) =>
    prisma.repairOrder.create({
      data: {
        jobNumber: `REP-P5-${String(++seq).padStart(4, '0')}`,
        trackingToken: crypto.randomBytes(24).toString('base64url'),
        status,
        receivedDate: getBangkokDateOnly(),
        customerId: customer.id,
        machineId: machine.id,
        technicianId,
        ...(technicianId ? { assignedAt: minutesAgo(200), acknowledgedAt: minutesAgo(190) } : {}),
        lastActivityAt: minutesAgo(5),
        ...extra,
      },
    });

  try {
    // ---------------------------------------------------------------
    // 1. Price confirmation by phone (SRS 3.4)
    // ---------------------------------------------------------------
    console.log('[Test 1] Recording phone confirmation per item...');
    await prisma.employee.update({ where: { id: 3 }, data: { status: 'BUSY' } });
    const O1 = await mk('INSPECTING', 3);
    const addItem = (body: any) => axios.post(`${API}/repairs/${O1.id}/items`, body, { headers: t[3] });
    const i1 = (await addItem({ name: 'ปั๊มน้ำ', unitPrice: 250 })).data.data.item;
    const i2 = (await addItem({ name: 'ค่าบริการ', itemType: 'SERVICE_FEE', unitPrice: 350 })).data.data.item;
    const i3 = (await addItem({ name: 'ซีลยาง', unitPrice: 100 })).data.data.item;
    eq((await order(O1.id)).status, 'WAITING_APPROVAL', 'O1 WAITING_APPROVAL after items');

    const itemStatusUrl = (id: number) => `${API}/repairs/${O1.id}/items/${id}/status`;
    await expectStatus(403, 'another technician records a result', () =>
      axios.patch(itemStatusUrl(i1.id), { status: 'APPROVED' }, { headers: t[4] })
    );
    eq((await item(i1.id)).status, 'PENDING', 'item unchanged after 403');
    await expectStatus(400, 'note longer than 500 characters', () =>
      axios.patch(itemStatusUrl(i1.id), { status: 'APPROVED', note: 'x'.repeat(501) }, { headers: t[3] })
    );

    await prisma.repairOrder.update({ where: { id: O1.id }, data: { lastActivityAt: minutesAgo(600), progressReminderCount: 2 } });
    const t1Start = new Date();
    await axios.patch(itemStatusUrl(i1.id), { status: 'APPROVED', note: 'โทรคุยกับเจ้าของร้าน 14:20' }, { headers: t[3] });
    const r1 = await item(i1.id);
    eq(r1.status, 'APPROVED', 'assigned technician approved i1');
    eq(r1.resolvedById, 3, 'resolvedById = technician');
    eq(r1.resolutionChannel, 'PHONE', 'resolutionChannel = PHONE');
    eq(r1.resolutionNote, 'โทรคุยกับเจ้าของร้าน 14:20', 'resolutionNote stored');
    assert(r1.resolvedAt && r1.resolvedAt >= new Date(t1Start.getTime() - 1000), 'resolvedAt stored');
    const o1a = await order(O1.id);
    assert(o1a.lastActivityAt && o1a.lastActivityAt >= new Date(t1Start.getTime() - 1000), 'recording a result updates lastActivityAt');
    eq(o1a.progressReminderCount, 0, 'activity clears the reminder counter');
    eq(o1a.status, 'WAITING_APPROVAL', 'still waiting for the other items');

    await axios.patch(itemStatusUrl(i2.id), { status: 'REJECTED' }, { headers: recep });
    const r2 = await item(i2.id);
    eq(r2.resolvedById, RECEP, 'RECEPTIONIST can record (resolvedById)');
    eq(r2.resolutionNote, null, 'note optional');
    const lastRes = await axios.patch(itemStatusUrl(i3.id), { status: 'APPROVED', note: 'ลูกค้าตกลงทางโทรศัพท์' }, { headers: admin });
    eq(lastRes.data.data.order.status, 'REPAIRING', 'all decided with approvals -> REPAIRING');
    eq((await item(i3.id)).resolvedById, ADMIN, 'ADMIN can record');
    const autoLog = await prisma.statusLog.findFirst({ where: { repairOrderId: O1.id, status: 'REPAIRING' } });
    eq(autoLog?.changedById, ADMIN, 'auto-transition StatusLog records who pressed (not null)');
    assert(autoLog?.note?.includes('phone'), 'StatusLog says it was confirmed by phone');
    await expectStatus(409, 'recording an already decided item', () =>
      axios.patch(itemStatusUrl(i1.id), { status: 'REJECTED' }, { headers: t[3] })
    );
    pass('Assigned technician / RECEPTIONIST / ADMIN record results with who, when, channel and note');

    // ---------------------------------------------------------------
    // 2. CUSTOMER_LINE_APPROVAL_ENABLED flag
    // ---------------------------------------------------------------
    console.log('\n[Test 2] LINE approval flag...');
    await prisma.customer.update({ where: { id: customer.id }, data: { lineUserId: OWNER_LINE } });
    const i4 = (await addItem({ name: 'วาล์วนิรภัย', unitPrice: 480 })).data.data.item;
    eq((await order(O1.id)).status, 'WAITING_APPROVAL', 'new item -> WAITING_APPROVAL');

    eq(
      await LineWebhookService.notifyCustomerNewItem(O1.id, { id: i4.id, name: i4.name, price: i4.amount }),
      'disabled',
      'flag off (default): no quotation push to the customer'
    );
    const postback = (status: string, userId = OWNER_LINE) => ({
      events: [
        {
          type: 'postback',
          replyToken: `rt-${Date.now()}`,
          source: { userId },
          postback: { data: `action=resolve_item&orderId=${O1.id}&itemId=${i4.id}&status=${status}` },
        },
      ],
    });
    await signedWebhook(postback('APPROVED'));
    await new Promise((r) => setTimeout(r, 500));
    const i4off = await item(i4.id);
    eq(i4off.status, 'PENDING', 'flag off: postback resolve_item changes nothing');
    eq(i4off.resolvedAt, null, 'flag off: no resolution recorded');
    eq(
      await LineWebhookService.handleResolveItemPostback(
        { orderId: O1.id, itemId: i4.id, status: 'APPROVED', lineUserId: OWNER_LINE, replyToken: '' },
        { approvalEnabled: false }
      ),
      'disabled',
      'flag off: handler reports disabled'
    );
    pass('Flag off: no push, postback ignored with a "shop will call" reply');

    eq(
      await LineWebhookService.handleResolveItemPostback(
        { orderId: O1.id, itemId: i4.id, status: 'APPROVED', lineUserId: 'U_STRANGER', replyToken: '' },
        { approvalEnabled: true }
      ),
      'forbidden',
      'flag on: non-owner still rejected'
    );
    eq((await item(i4.id)).status, 'PENDING', 'non-owner changed nothing');
    eq(
      await LineWebhookService.handleResolveItemPostback(
        { orderId: O1.id, itemId: i4.id, status: 'APPROVED', lineUserId: OWNER_LINE, replyToken: '' },
        { approvalEnabled: true }
      ),
      'resolved',
      'flag on: owner approval works'
    );
    const i4on = await item(i4.id);
    eq(i4on.status, 'APPROVED', 'flag on: item APPROVED');
    eq(i4on.resolutionChannel, 'LINE', 'flag on: resolutionChannel = LINE');
    eq(i4on.resolvedById, null, 'flag on: resolvedById = null (customer)');
    eq((await order(O1.id)).status, 'REPAIRING', 'flag on: order back to REPAIRING');
    const lineLog = await prisma.statusLog.findFirst({ where: { repairOrderId: O1.id, status: 'REPAIRING', note: { contains: 'LINE' } } });
    assert(lineLog && lineLog.changedById === null, 'LINE resolution logged without an employee');
    assert(
      (await LineWebhookService.notifyCustomerNewItem(O1.id, { id: i4.id, name: i4.name, price: '480.00' }, { approvalEnabled: true })) !== 'disabled',
      'flag on: quotation push is attempted'
    );
    pass('Flag on: original LINE approval behaviour with channel = LINE');

    // ---------------------------------------------------------------
    // 3. POST /complete
    // ---------------------------------------------------------------
    console.log('\n[Test 3] POST /api/repairs/:id/complete ...');
    const P = await mk('NEW', null); // waiting in the pool for the next free technician
    await prisma.employee.update({ where: { id: 7 }, data: { isActive: false } });

    const completeUrl = `${API}/repairs/${O1.id}/complete`;
    const blocked = await expectStatus(409, 'complete with APPROVED items not yet completed', () =>
      axios.post(completeUrl, { completionSummary: 'x' }, { headers: t[3] })
    );
    eq(blocked.details?.approvedItemsNotCompleted, 3, '409 reports how many approved items are pending');
    for (const it of [i1, i3, i4]) {
      await axios.patch(`${API}/repairs/${O1.id}/items/${it.id}/complete`, {}, { headers: t[3] });
    }
    await expectStatus(403, 'another technician completes', () => axios.post(completeUrl, { completionSummary: 'x' }, { headers: t[4] }));
    await expectStatus(403, 'RECEPTIONIST completes', () => axios.post(completeUrl, { completionSummary: 'x' }, { headers: recep }));
    await expectStatus(403, 'technician PATCHes status to COMPLETED', () =>
      axios.patch(`${API}/repairs/${O1.id}/status`, { status: 'COMPLETED' }, { headers: t[3] })
    );
    await expectStatus(400, 'empty completionSummary', () => axios.post(completeUrl, { completionSummary: '  ' }, { headers: t[3] }));
    await expectStatus(400, 'completionSummary over 2000 characters', () =>
      axios.post(completeUrl, { completionSummary: 'x'.repeat(2001) }, { headers: t[3] })
    );
    await expectStatus(400, 'owner listed as helper', () =>
      axios.post(completeUrl, { completionSummary: 'x', helperTechnicianIds: [3] }, { headers: t[3] })
    );
    await expectStatus(400, 'RECEPTIONIST listed as helper', () =>
      axios.post(completeUrl, { completionSummary: 'x', helperTechnicianIds: [RECEP] }, { headers: t[3] })
    );
    await expectStatus(400, 'deactivated technician listed as helper', () =>
      axios.post(completeUrl, { completionSummary: 'x', helperTechnicianIds: [7] }, { headers: t[3] })
    );
    await expectStatus(400, 'unknown field', () => axios.post(completeUrl, { completionSummary: 'x', status: 'DELIVERED' }, { headers: t[3] }));
    eq((await order(O1.id)).status, 'REPAIRING', 'nothing changed by rejected attempts');

    const done = await axios.post(
      completeUrl,
      { completionSummary: 'เปลี่ยนปั๊มน้ำและซีลยาง ทดสอบแรงดัน 9 บาร์ผ่าน', helperTechnicianIds: [4, 5, 4] },
      { headers: t[3] }
    );
    const doneData = done.data.data;
    eq(doneData.status, 'COMPLETED', 'O1 COMPLETED');
    eq(doneData.completionSummary, 'เปลี่ยนปั๊มน้ำและซีลยาง ทดสอบแรงดัน 9 บาร์ผ่าน', 'completionSummary saved');
    eq(JSON.stringify(doneData.helpers.map((h: any) => h.technician.id)), JSON.stringify([4, 5]), 'helpers recorded (duplicates ignored)');
    assert(doneData.helpers.every((h: any) => h.addedBy.id === 3 && h.technician.name), 'helpers added by the owner, with names');
    const completedLog = await prisma.statusLog.findFirst({ where: { repairOrderId: O1.id, status: 'COMPLETED' } });
    eq(completedLog?.changedById, 3, 'COMPLETED logged with the technician');
    eq((await order(P.id)).technicianId, 3, 'freed technician immediately reserved the next pool job');
    eq((await tech(3)).status, 'RESERVED', 'technician RESERVED for the next job');
    eq((await tech(4)).status, 'OFFLINE', 'helpers are not touched by the queue');
    await expectStatus(409, 'complete twice', () => axios.post(completeUrl, { completionSummary: 'x' }, { headers: admin }));
    pass('Completed with summary + helpers; technician freed and given the next job');

    // ADMIN may still use PATCH /status -> COMPLETED (summary optional), same rules
    await prisma.employee.update({ where: { id: 6 }, data: { status: 'BUSY' } });
    const O2 = await mk('REPAIRING', 6);
    await expectStatus(403, 'technician PATCHes own job to COMPLETED', () =>
      axios.patch(`${API}/repairs/${O2.id}/status`, { status: 'COMPLETED' }, { headers: t[6] })
    );
    const adminDone = await axios.patch(`${API}/repairs/${O2.id}/status`, { status: 'COMPLETED' }, { headers: admin });
    eq(adminDone.data.data.status, 'COMPLETED', 'ADMIN PATCH -> COMPLETED still allowed');
    eq(adminDone.data.data.completionSummary, null, 'summary optional on the ADMIN path');
    eq((await tech(6)).status, 'AVAILABLE', 'technician freed via the shared completion path');
    pass('ADMIN PATCH -> COMPLETED uses the same completion path');

    // ---------------------------------------------------------------
    // 4. PUT /helpers (ADMIN / RECEPTIONIST until delivered)
    // ---------------------------------------------------------------
    console.log('\n[Test 4] PUT /api/repairs/:id/helpers ...');
    const helpersUrl = `${API}/repairs/${O1.id}/helpers`;
    await expectStatus(403, 'TECHNICIAN edits helpers', () => axios.put(helpersUrl, { technicianIds: [5] }, { headers: t[3] }));
    const h1 = await axios.put(helpersUrl, { technicianIds: [5] }, { headers: recep });
    eq(JSON.stringify(h1.data.data.helpers.map((h: any) => h.technician.id)), JSON.stringify([5]), 'RECEPTIONIST replaced the list');
    eq(h1.data.data.helpers[0].addedBy.id, 3, 'kept helper keeps who originally added it');
    assert(
      await prisma.statusLog.findFirst({ where: { repairOrderId: O1.id, note: { contains: 'Helper technicians updated by RECEPTIONIST' } } }),
      'helper change logged'
    );
    await expectStatus(400, 'owner as helper via PUT', () => axios.put(helpersUrl, { technicianIds: [3] }, { headers: admin }));
    await expectStatus(400, 'more than 10 helpers', () =>
      axios.put(helpersUrl, { technicianIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] }, { headers: admin })
    );
    const h2 = await axios.put(helpersUrl, { technicianIds: [4, 6] }, { headers: admin });
    eq(JSON.stringify(h2.data.data.helpers.map((h: any) => h.technician.id)), JSON.stringify([4, 6]), 'ADMIN set helpers');
    eq(h2.data.data.helpers[0].addedBy.id, ADMIN, 'new helper rows record the ADMIN');
    const cleared = await axios.put(helpersUrl, { technicianIds: [] }, { headers: admin });
    eq(cleared.data.data.helpers.length, 0, 'empty list clears helpers');
    await axios.put(helpersUrl, { technicianIds: [4] }, { headers: admin });
    await axios.patch(`${API}/repairs/${O1.id}/status`, { status: 'DELIVERED' }, { headers: recep });
    await expectStatus(409, 'edit helpers after DELIVERED', () => axios.put(helpersUrl, { technicianIds: [5] }, { headers: recep }));
    eq(await prisma.repairOrderHelper.count({ where: { repairOrderId: O1.id } }), 1, 'helpers kept after delivery');
    pass('Helpers editable by RECEPTIONIST/ADMIN until delivery');

    // ---------------------------------------------------------------
    // 5. still-working + needsProgressUpdate (lastActivityAt set back in the DB)
    // ---------------------------------------------------------------
    console.log('\n[Test 5] still-working and needsProgressUpdate...');
    await axios.post(`${API}/repairs/${P.id}/accept`, {}, { headers: t[3] });
    await prisma.repairOrder.update({
      where: { id: P.id },
      data: { lastActivityAt: minutesAgo(3 * 24 * 60), progressReminderCount: 2, lastProgressReminderAt: minutesAgo(60) },
    });
    await prisma.employee.updateMany({ where: { id: { in: [4, 5, 6] } }, data: { status: 'BUSY' } });
    const S3 = await mk('WAITING_APPROVAL', 4, { lastActivityAt: minutesAgo(3 * 24 * 60) }); // idle -> listed
    const S2 = await mk('REPAIRING', 6, { lastActivityAt: new Date() }); // fresh -> not listed
    const S4 = await mk('COMPLETED', 5, { lastActivityAt: minutesAgo(3 * 24 * 60) }); // not active -> not listed

    const needAdmin = (await axios.get(`${API}/repairs?needsProgressUpdate=true&limit=100`, { headers: admin })).data.data.orders;
    eq(JSON.stringify(needAdmin.map((o: any) => o.id).sort()), JSON.stringify([P.id, S3.id].sort()), 'ADMIN sees every idle active job');
    assert(needAdmin.every((o: any) => o.idleBusinessMinutes >= 60), 'idleBusinessMinutes >= threshold');
    const needT3 = (await axios.get(`${API}/repairs?needsProgressUpdate=true`, { headers: t[3] })).data.data.orders;
    eq(JSON.stringify(needT3.map((o: any) => o.id)), JSON.stringify([P.id]), 'technician sees only own idle job');
    const needT6 = (await axios.get(`${API}/repairs?needsProgressUpdate=true`, { headers: t[6] })).data.data.orders;
    eq(needT6.length, 0, 'fresh job not listed');
    await expectStatus(400, 'needsProgressUpdate=yes', () => axios.get(`${API}/repairs?needsProgressUpdate=yes`, { headers: admin }));
    pass('needsProgressUpdate returns only jobs idle past the threshold (business minutes)');

    await expectStatus(403, 'another technician presses still-working', () =>
      axios.post(`${API}/repairs/${P.id}/still-working`, {}, { headers: t[4] })
    );
    await expectStatus(403, 'RECEPTIONIST presses still-working', () =>
      axios.post(`${API}/repairs/${P.id}/still-working`, {}, { headers: recep })
    );
    await expectStatus(409, 'still-working on a COMPLETED job', () =>
      axios.post(`${API}/repairs/${S4.id}/still-working`, {}, { headers: admin })
    );
    const swStart = new Date();
    await axios.post(`${API}/repairs/${P.id}/still-working`, {}, { headers: t[3] });
    const pAfter = await order(P.id);
    assert(pAfter.lastActivityAt && pAfter.lastActivityAt >= new Date(swStart.getTime() - 1000), 'still-working resets lastActivityAt');
    eq(pAfter.progressReminderCount, 0, 'still-working resets progressReminderCount');
    eq(pAfter.lastProgressReminderAt, null, 'still-working clears lastProgressReminderAt');
    eq(pAfter.status, 'INSPECTING', 'status unchanged');
    const needAfter = (await axios.get(`${API}/repairs?needsProgressUpdate=true&limit=100`, { headers: admin })).data.data.orders;
    eq(JSON.stringify(needAfter.map((o: any) => o.id)), JSON.stringify([S3.id]), 'job drops off the list after still-working');
    pass('still-working resets the timer and counters');

    // ---------------------------------------------------------------
    // 6. Rework (COMPLETED -> REPAIRING) when no technician is AVAILABLE
    // ---------------------------------------------------------------
    console.log('\n[Test 6] Rework with no free technician goes to the head of the queue...');
    // Every active technician is busy: 3 (P), 4 (S3), 5 (S4 owner), 6 (S2); 7 is deactivated
    await prisma.employee.updateMany({ where: { id: { in: [3, 4, 5, 6] } }, data: { status: 'BUSY' } });
    const N = await mk('NEW', null, { createdAt: minutesAgo(300), assignedAt: null, acknowledgedAt: null }); // older normal pool job
    const R = await mk('COMPLETED', 5, { completionSummary: 'เปลี่ยนมอเตอร์' });
    await prisma.repairItem.create({ data: { repairOrderId: R.id, name: 'มอเตอร์', unitPrice: 900, status: 'COMPLETED' } });

    const rework = await axios.patch(`${API}/repairs/${R.id}/status`, { status: 'REPAIRING', note: 'ลูกค้าแจ้งยังรั่ว' }, { headers: admin });
    eq(rework.status, 200, 'rework accepted instead of 409');
    const rPooled = await order(R.id);
    eq(rPooled.status, 'NEW', 'rework order back in the pool as NEW');
    eq(rPooled.technicianId, null, 'no technician held');
    eq(rPooled.queuePriority, 1, 'rework at the head of the queue');
    eq(rPooled.completionSummary, 'เปลี่ยนมอเตอร์', 'completion summary kept');
    eq((await tech(5)).status, 'BUSY', 'previous technician untouched (no second job)');
    const poolLog = await prisma.statusLog.findFirst({ where: { repairOrderId: R.id, status: 'NEW' }, orderBy: { id: 'desc' } });
    eq(poolLog?.changedById, ADMIN, 'log records who requested the rework');
    assert(poolLog?.note?.includes('ลูกค้าแจ้งยังรั่ว'), 'log keeps the note');

    // Technician 6 finishes S2 -> freed -> must get the rework before the older normal job
    await axios.patch(`${API}/repairs/${S2.id}/status`, { status: 'COMPLETED' }, { headers: admin });
    const rReserved = await order(R.id);
    eq(rReserved.technicianId, 6, 'next free technician reserved the rework first');
    eq((await order(N.id)).technicianId, null, 'older normal job still waiting');
    eq((await tech(6)).status, 'RESERVED', 'technician RESERVED');
    const accepted = await axios.post(`${API}/repairs/${R.id}/accept`, {}, { headers: t[6] });
    eq(accepted.data.data.status, 'REPAIRING', 'accepting a rework resumes at REPAIRING');
    eq((await order(R.id)).queuePriority, 0, 'priority reset after accept');
    pass('Rework with no free technician is queued first and resumes at REPAIRING for whoever is free');

    console.log('\n==================================================================');
    console.log('PHASE 5 PRICING / COMPLETE / STILL-WORKING TESTS PASSED');
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
  console.error('\nPhase 5 Test Failed:', err.response?.data || err.message);
  await prisma.$disconnect();
  process.exit(1);
});
