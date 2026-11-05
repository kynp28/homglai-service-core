/**
 * Phase 6 tests: public search whitelist (PDPA), same 404 for every miss, rate limits, public SSE
 * payload, LINE link per order (subscribe-line + webhook), customer status messages.
 *
 * Runs against the API started by test-runner.js (port 4000, NODE_ENV=test, LINE_IDENTITY_VERIFIER=mock)
 * on a *_test database.
 */
import axios, { AxiosResponse } from 'axios';
import crypto from 'crypto';
import http from 'http';
import jwt from 'jsonwebtoken';
import prisma from '@homglai/db';
import { assertSafeDatabaseUrl } from '../src/utils/test-safety';
import { getJwtSecret } from '../src/config/env';
import { getBangkokDateOnly } from '../src/utils/date';
import { customerStatusMessage, notifyCustomersOfStatus } from '../src/services/customer-notifier';
import { LineWebhookService, bindFailures } from '../src/services/line-webhook.service';
import { NOT_REPAIRED_LABEL_TH } from '../src/utils/customer-view';

type Headers = Record<string, string>;

const API = 'http://localhost:4000/api';
const TECHS = [3, 4, 5, 6, 7];

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
  return {
    Authorization: `Bearer ${jwt.sign({ employeeId: e.id, role: e.role }, getJwtSecret(), { algorithm: 'HS256', expiresIn: '30m' })}`,
  };
}
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

// Raw HTTP helpers (no throw on 4xx, body kept as the exact text the server sent)
let searchCalls = 0;
let subscribeCalls = 0;
async function search(body: unknown, headers: Headers = {}): Promise<AxiosResponse<string>> {
  searchCalls++;
  return axios.post(`${API}/tracking/search`, body, {
    headers: { 'Content-Type': 'application/json', ...headers },
    transformResponse: (r) => r,
    validateStatus: () => true,
  });
}
async function subscribe(body: unknown): Promise<AxiosResponse<string>> {
  subscribeCalls++;
  return axios.post(`${API}/tracking/subscribe-line`, body, {
    headers: { 'Content-Type': 'application/json' },
    transformResponse: (r) => r,
    validateStatus: () => true,
  });
}

/** Opens the public SSE stream and collects every data event. */
function openStream(trackingToken: string): Promise<{ events: any[]; close: () => void }> {
  return new Promise((resolve, reject) => {
    const events: any[] = [];
    const req = http.get(`${API}/tracking/stream/${trackingToken}`, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`SSE status ${res.statusCode}`));
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buffer += chunk;
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          for (const line of block.split('\n')) {
            if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6)));
          }
        }
      });
      resolve({ events, close: () => req.destroy() });
    });
    req.on('error', (err: any) => {
      if (err.code !== 'ECONNRESET') reject(err);
    });
  });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  console.log('PHASE 6: PUBLIC SEARCH / PDPA / SSE / LINE LINK PER ORDER');
  console.log('==================================================================\n');

  const admin = await tokenFor(1);
  const recep = await tokenFor(2);
  const tech3 = await tokenFor(3);

  await resetWorld();
  // Values that must never leak are unique strings, so a plain substring search proves absence
  const SECRET = {
    name: 'ZXQ-CUSTOMER-NAME',
    phone: `0867${String(Date.now()).slice(-6)}`,
    address: 'ZXQ-ADDRESS-77 ถนนลับ',
    serial: 'ZXQ-SERIAL-7731',
    item: 'ZXQ-ITEM-SECRET',
    price: '7731.55',
    note: 'ZXQ-NOTE-SECRET',
    techName: (await prisma.employee.findUniqueOrThrow({ where: { id: 3 } })).name,
  };
  const customer = await prisma.customer.create({ data: { name: SECRET.name, phone: SECRET.phone, address: SECRET.address } });
  const machine = await prisma.machine.create({ data: { brand: 'GEF', model: 'Aa+', serialNumber: SECRET.serial, customerId: customer.id } });
  const trackingToken = crypto.randomBytes(24).toString('base64url');
  const jobNumber = `REP-2611-9${String(Date.now()).slice(-4)}`;
  const paperReceiptNo = String(Date.now()).slice(-7);
  await prisma.employee.update({ where: { id: 3 }, data: { status: 'BUSY' } });
  const O = await prisma.repairOrder.create({
    data: {
      jobNumber,
      trackingToken,
      status: 'INSPECTING',
      receivedDate: getBangkokDateOnly(),
      paperReceiptNo,
      customerId: customer.id,
      machineId: machine.id,
      technicianId: 3,
      assignedAt: minutesAgo(50),
      acknowledgedAt: minutesAgo(45),
      lastActivityAt: minutesAgo(10),
      otherSymptom: SECRET.note,
      warningNote: SECRET.note,
    },
  });
  await prisma.repairItem.create({ data: { repairOrderId: O.id, name: SECRET.item, unitPrice: SECRET.price, status: 'REJECTED' } });
  const logs: Array<[any, number]> = [
    ['NEW', 60], ['NEW', 50], ['INSPECTING', 45], ['WAITING_APPROVAL', 40], ['WAITING_APPROVAL', 35], ['INSPECTING', 30],
  ];
  for (const [status, m] of logs) {
    await prisma.statusLog.create({ data: { repairOrderId: O.id, status, changedById: 3, note: `${SECRET.note} by ${SECRET.techName}`, createdAt: minutesAgo(m) } });
  }

  try {
    // ---------------------------------------------------------------
    // 1. Whitelist
    // ---------------------------------------------------------------
    console.log('[Test 1] Public search returns the whitelist only...');
    const byJob = await search({ query: jobNumber });
    eq(byJob.status, 200, 'search by job number');
    const byPaper = await search({ query: paperReceiptNo });
    eq(byPaper.status, 200, 'search by paper receipt number');
    const byLower = await search({ query: `  ${jobNumber.toLowerCase()}  ` });
    eq(byLower.status, 200, 'lower case / surrounding spaces normalised');
    eq(byJob.data, byPaper.data, 'job number and paper number give the identical response');
    eq(byJob.data, byLower.data, 'normalised query gives the identical response');

    const view = JSON.parse(byJob.data).data;
    eq(JSON.stringify(Object.keys(view).sort()), JSON.stringify(['jobNumber', 'machine', 'receivedDate', 'status', 'statusLabelTh', 'timeline', 'updatedAt']), 'top-level keys');
    eq(JSON.stringify(Object.keys(view.machine).sort()), JSON.stringify(['brand', 'model']), 'machine keys');
    eq(view.status, 'INSPECTING', 'status');
    eq(view.statusLabelTh, 'กำลังตรวจเช็ค', 'Thai label');
    eq(view.receivedDate, getBangkokDateOnly().toISOString().slice(0, 10), 'receivedDate YYYY-MM-DD');
    eq(JSON.stringify(view.timeline.map((t: any) => t.status)), JSON.stringify(['NEW', 'INSPECTING', 'WAITING_APPROVAL', 'INSPECTING']), 'timeline collapses consecutive repeats');
    assert(view.timeline.every((t: any) => JSON.stringify(Object.keys(t).sort()) === JSON.stringify(['at', 'status', 'statusLabelTh'])), 'timeline entries: status, statusLabelTh, at');
    eq(view.timeline[0].statusLabelTh, 'รับเรื่องแล้ว/รอคิวช่าง', 'NEW label');

    for (const [label, value] of Object.entries({ ...SECRET, trackingToken, customerId: `"customerId"`, lineUserId: 'lineUserId', technician: '"technician' })) {
      assert(!byJob.data.includes(value), `public search must not contain ${label} (${value})`);
    }
    pass('Only jobNumber/status/label/receivedDate/updatedAt/machine/timeline; no name, phone, address, technician, items, price, note, token, serial');

    // NOT_REPAIRED reads differently from "repaired"
    await prisma.repairOrder.update({ where: { id: O.id }, data: { status: 'COMPLETED', repairOutcome: 'NOT_REPAIRED' } });
    await prisma.statusLog.create({ data: { repairOrderId: O.id, status: 'COMPLETED', changedById: 3, note: 'x' } });
    const nr = JSON.parse((await search({ query: jobNumber })).data).data;
    eq(nr.statusLabelTh, NOT_REPAIRED_LABEL_TH, 'COMPLETED + NOT_REPAIRED label');
    eq(nr.timeline[nr.timeline.length - 1].statusLabelTh, NOT_REPAIRED_LABEL_TH, 'timeline step uses the not-repaired label');
    await prisma.repairOrder.update({ where: { id: O.id }, data: { status: 'INSPECTING', repairOutcome: null } });
    await prisma.statusLog.create({ data: { repairOrderId: O.id, status: 'INSPECTING', changedById: 3, note: 'x' } });
    pass('A job closed without repair is never shown as "ซ่อมเสร็จ"');

    // ---------------------------------------------------------------
    // 2. Same 404 for every miss
    // ---------------------------------------------------------------
    console.log('\n[Test 2] Every miss returns the identical 404 body...');
    const misses: unknown[] = [
      { query: 'REP-2611-000000' },
      { query: '9999999999' },
      { query: SECRET.phone.slice(0, 3) + '-' + SECRET.phone.slice(3) },
      { query: 'hello' },
      { query: 'REP-26-1' },
      { query: '' },
      { query: 12345 },
      {},
      { query: '12345678901' },
    ];
    const missBodies = new Set<string>();
    for (const body of misses) {
      const res = await search(body);
      eq(res.status, 404, `miss ${JSON.stringify(body)} -> 404`);
      missBodies.add(res.data);
    }
    eq(missBodies.size, 1, 'all miss bodies are byte-identical');
    eq(JSON.parse([...missBodies][0]).message, 'ไม่พบข้อมูลใบงาน กรุณาตรวจสอบเลขที่อีกครั้ง', 'Thai not-found message');
    pass(`${misses.length} kinds of miss (unknown, phone, bad format, empty, wrong type, missing) -> same 404 body`);

    // ---------------------------------------------------------------
    // 3. Public SSE payload
    // ---------------------------------------------------------------
    console.log('\n[Test 3] Public SSE sends { status, updatedAt } only...');
    const stream = await openStream(trackingToken);
    await sleep(200);
    const added = await axios.post(`${API}/repairs/${O.id}/items`, { name: 'ZXQ-SSE-ITEM', unitPrice: 999.99 }, { headers: tech3 });
    const newItemId = added.data.data.item.id;
    await axios.patch(`${API}/repairs/${O.id}/items/${newItemId}/status`, { status: 'APPROVED', note: 'ZXQ-SSE-NOTE' }, { headers: recep });
    await axios.patch(`${API}/repairs/${O.id}/items/${newItemId}/complete`, {}, { headers: tech3 });
    await sleep(500);
    stream.close();
    assert(stream.events.length >= 3, `received the events (${stream.events.length})`);
    for (const ev of stream.events) {
      eq(JSON.stringify(Object.keys(ev).sort()), JSON.stringify(['status', 'updatedAt']), 'SSE payload keys');
    }
    eq(JSON.stringify(stream.events.map((e) => e.status)), JSON.stringify(['WAITING_APPROVAL', 'REPAIRING', 'REPAIRING']), 'statuses in order');
    assert(!JSON.stringify(stream.events).includes('ZXQ'), 'no item name / note in SSE');
    pass('add item, phone confirmation and item completion -> SSE carries only status and updatedAt');

    // ---------------------------------------------------------------
    // 4. subscribe-line
    // ---------------------------------------------------------------
    console.log('\n[Test 4] POST /api/tracking/subscribe-line ...');
    const O2 = await prisma.repairOrder.create({
      data: {
        jobNumber: `${jobNumber}2`,
        trackingToken: crypto.randomBytes(24).toString('base64url'),
        status: 'NEW',
        receivedDate: getBangkokDateOnly(),
        customerId: customer.id,
        machineId: machine.id,
      },
    });
    const dashedPhone = `${SECRET.phone.slice(0, 3)}-${SECRET.phone.slice(3, 6)}-${SECRET.phone.slice(6)}`;
    const failures = [
      await subscribe({ query: jobNumber, phone: SECRET.phone }),
      await subscribe({ query: jobNumber, phone: SECRET.phone, lineAccessToken: 'not-a-real-token' }),
      await subscribe({ query: jobNumber, phone: '0800000000', lineAccessToken: 'mock:U_PRIV_A' }),
      await subscribe({ query: 'REP-2611-000000', phone: SECRET.phone, lineAccessToken: 'mock:U_PRIV_A' }),
    ];
    for (const f of failures) eq(f.status, 400, 'failure -> 400');
    eq(new Set(failures.map((f) => f.data)).size, 1, 'missing token / fake token / wrong phone / unknown order: identical body');
    eq(await prisma.orderLineSubscription.count(), 0, 'nothing linked by failures');
    pass('No token, fake token, wrong phone and unknown order get the same generic answer');

    const okA = await subscribe({ query: jobNumber, phone: dashedPhone, lineAccessToken: 'mock:U_PRIV_A' });
    eq(okA.status, 200, 'account A linked (phone normalised)');
    const okAData = JSON.parse(okA.data).data;
    eq(JSON.stringify(Object.keys(okAData).sort()), JSON.stringify(['alreadySubscribed', 'jobNumber', 'status', 'statusLabelTh', 'subscribed']), 'success keys (no token / ids)');
    eq(okAData.alreadySubscribed, false, 'first link');
    const againA = JSON.parse((await subscribe({ query: jobNumber, phone: SECRET.phone, lineAccessToken: 'mock:U_PRIV_A' })).data).data;
    eq(againA.alreadySubscribed, true, 'linking again is not an error');
    const okB = await subscribe({ query: paperReceiptNo, phone: SECRET.phone, lineAccessToken: 'mock:U_PRIV_B' });
    eq(okB.status, 200, 'account B links the same order with the paper number');
    const okA2 = await subscribe({ query: O2.jobNumber, phone: SECRET.phone, lineAccessToken: 'mock:U_PRIV_A' });
    eq(okA2.status, 200, 'account A links a second order');
    eq(
      JSON.stringify((await prisma.orderLineSubscription.findMany({ where: { repairOrderId: O.id }, orderBy: { id: 'asc' } })).map((s) => s.lineUserId)),
      JSON.stringify(['U_PRIV_A', 'U_PRIV_B']),
      'one order, two accounts'
    );
    eq(await prisma.orderLineSubscription.count({ where: { lineUserId: 'U_PRIV_A' } }), 2, 'one account, two orders');
    const staffView = (await axios.get(`${API}/repairs/${O.id}`, { headers: admin })).data.data;
    eq(staffView.customer.lineLinked, true, 'staff detail: customer.lineLinked from the order subscriptions');
    assert(!('lineUserId' in staffView.customer), 'staff detail never returns lineUserId');
    pass('Idempotent; many orders per account and many accounts per order');

    while (subscribeCalls < 10) {
      eq((await subscribe({ query: jobNumber, phone: SECRET.phone, lineAccessToken: 'mock:U_PRIV_A' })).status, 200, 'within limit');
    }
    eq((await subscribe({ query: jobNumber, phone: SECRET.phone, lineAccessToken: 'mock:U_PRIV_A' })).status, 429, '11th subscribe-line in 15 min -> 429');
    pass('subscribe-line limited to 10 requests / 15 min / IP');

    // ---------------------------------------------------------------
    // 5. LINE chat binding + customer status messages (in-process, recording notifier)
    // ---------------------------------------------------------------
    console.log('\n[Test 5] LINE chat binding and status messages...');
    bindFailures.attempts.clear();
    eq(await LineWebhookService.handleBindingMessage('U_PRIV_C', '', paperReceiptNo, SECRET.phone), 'bound', 'chat "<paper no.> <phone>" links');
    eq(await LineWebhookService.handleBindingMessage('U_PRIV_C', '', jobNumber, SECRET.phone), 'already', 'chat "<REP-...> <phone>" again -> already linked');
    for (let i = 0; i < 5; i++) {
      eq(await LineWebhookService.handleBindingMessage('U_PRIV_D', '', jobNumber, '0800000000'), 'failed', `wrong phone attempt ${i + 1}`);
    }
    eq(await LineWebhookService.handleBindingMessage('U_PRIV_D', '', jobNumber, SECRET.phone), 'too_many', '6th attempt blocked even with the right phone');
    eq(await prisma.orderLineSubscription.count({ where: { lineUserId: 'U_PRIV_D' } }), 0, 'blocked account not linked');
    pass('Chat binding uses the same service (job or paper number) and blocks after 5 failures / 15 min');

    const sent: Array<{ to: string; text: string }> = [];
    const recipients = await notifyCustomersOfStatus(O.id, { push: async (to, text) => void sent.push({ to, text }) });
    eq(JSON.stringify(recipients), JSON.stringify(['U_PRIV_A', 'U_PRIV_B', 'U_PRIV_C']), 'every linked account receives the message');
    eq(sent.length, 3, 'three pushes');
    const text = sent[0].text;
    assert(text.includes(jobNumber) && text.includes('กำลังซ่อม') && text.includes('GEF Aa+'), 'message has job number, Thai status, brand/model');
    for (const bad of ['999.99', SECRET.price, 'ZXQ', SECRET.name, SECRET.phone, 'บาท']) {
      assert(!text.includes(bad), `status message must not contain ${bad}`);
    }
    const failing = await notifyCustomersOfStatus(O.id, { push: async () => { throw new Error('LINE down'); } });
    eq(failing.length, 3, 'a failing LINE push does not throw');
    eq(
      customerStatusMessage({ jobNumber, status: 'COMPLETED', repairOutcome: 'NOT_REPAIRED', machine: { brand: 'GEF', model: 'Aa+' } }).includes(NOT_REPAIRED_LABEL_TH),
      true,
      'not-repaired wording'
    );
    pass('Status message: job, Thai status, machine — never prices or items; LINE failures are swallowed');

    // ---------------------------------------------------------------
    // 6. Public search rate limit (last: it exhausts the limit for this IP)
    // ---------------------------------------------------------------
    console.log('\n[Test 6] Public search rate limit...');
    const probe = await search({ query: jobNumber });
    const limit = Number(probe.headers['ratelimit-limit']);
    assert(limit >= 1, `RateLimit-Limit header present (${probe.headers['ratelimit-limit']})`);
    while (searchCalls < limit) {
      const r = await search({ query: 'hello' });
      eq(r.status, 404, `request ${searchCalls} within the limit`);
    }
    eq((await search({ query: jobNumber })).status, 429, `request ${limit + 1} -> 429`);
    eq((await search({ query: jobNumber }, { 'X-Forwarded-For': '203.0.113.9' })).status, 429, 'spoofed X-Forwarded-For does not reset the limit (TRUST_PROXY=false)');
    pass(`${limit} searches / 15 min / IP, then 429`);

    console.log('\n==================================================================');
    console.log('PHASE 6 PRIVACY / PUBLIC TRACKING TESTS PASSED');
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
  console.error('\nPhase 6 Test Failed:', err.response?.data || err.message);
  await prisma.$disconnect();
  process.exit(1);
});
