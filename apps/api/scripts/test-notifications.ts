/**
 * Phase 3 tests: Notifier (DbNotifier, templates, recipients, safe delivery) and
 * GET /api/notifications + PATCH /api/notifications/:id/read.
 *
 * Runs against the API started by test-runner.js (port 4000) on a *_test database.
 */
import axios, { AxiosResponse } from 'axios';
import jwt from 'jsonwebtoken';
import prisma from '@homglai/db';
import { assertSafeDatabaseUrl } from '../src/utils/test-safety';
import { getJwtSecret } from '../src/config/env';
import {
  getNotifier,
  notifySafely,
  progressCheckLine,
  type NotificationEvent,
  type Notifier,
} from '../src/notifications';

const API_BASE = 'http://localhost:4000/api';
const ADMIN_ID = 1;
const RECEPTIONIST_ID = 2;
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

async function expectStatus(status: number, label: string, call: () => Promise<AxiosResponse>): Promise<any> {
  try {
    const res = await call();
    throw new Error(`ASSERTION FAILED: ${label} — expected HTTP ${status}, got ${res.status}`);
  } catch (err: any) {
    if (!err.response) throw err;
    if (err.response.status !== status) {
      throw new Error(`ASSERTION FAILED: ${label} — expected HTTP ${status}, got ${err.response.status}: ${JSON.stringify(err.response.data)}`);
    }
    console.log(`  [PASS] ${label} -> ${status}`);
    return err.response.data;
  }
}

/** Token for a seeded employee without POST /auth/login (rate limited; covered by the smoke suite). */
async function tokenFor(employeeId: number): Promise<Headers> {
  const e = await prisma.employee.findUniqueOrThrow({ where: { id: employeeId } });
  const token = jwt.sign({ employeeId: e.id, role: e.role }, getJwtSecret(), { algorithm: 'HS256', expiresIn: '15m' });
  return { Authorization: `Bearer ${token}` };
}

async function rowsFor(recipientId: number, type?: string) {
  return prisma.notification.findMany({ where: { recipientId, ...(type ? { type } : {}) }, orderBy: { id: 'asc' } });
}

async function main() {
  assertSafeDatabaseUrl();

  console.log('==================================================================');
  console.log('PHASE 3: NOTIFIER + /api/notifications TEST SUITE');
  console.log('==================================================================\n');

  // Clean slate for notifications (test DB only)
  await prisma.notification.deleteMany({});

  // Extra ADMINs: one active, one deactivated
  const stamp = Date.now();
  const extraActiveAdmin = await prisma.employee.create({
    data: { username: `ntf_admin_on_${stamp}`, name: 'Admin Active 2', role: 'ADMIN', passwordHash: 'x', isActive: true },
  });
  const extraInactiveAdmin = await prisma.employee.create({
    data: { username: `ntf_admin_off_${stamp}`, name: 'Admin Inactive', role: 'ADMIN', passwordHash: 'x', isActive: false },
  });
  const activeAdminIds = (
    await prisma.employee.findMany({ where: { role: 'ADMIN', isActive: true }, select: { id: true } })
  ).map((e) => e.id);
  assert(activeAdminIds.includes(ADMIN_ID) && activeAdminIds.includes(extraActiveAdmin.id), 'two active admins exist');

  try {
    const notifier = getNotifier();

    // ---------------------------------------------------------------
    // 1. ADMIN digest -> every active ADMIN, never inactive ADMINs or other roles
    // ---------------------------------------------------------------
    console.log('[Test 1] ADMIN digest recipients...');
    const ackDigest: NotificationEvent = {
      type: 'ACK_OVERDUE_DIGEST',
      orders: [
        { repairOrderId: 9001, jobNumber: 'REP-2611-0101', technicianName: 'Tech 1', waitingMinutes: 75 },
        { repairOrderId: 9002, jobNumber: 'REP-2611-0102', technicianName: 'Tech 2', waitingMinutes: 130 },
      ],
    };
    const ackResult = await notifier.notify(ackDigest);
    assertEq(ackResult.delivered, activeAdminIds.length, 'digest delivered once per active ADMIN');
    for (const id of activeAdminIds) {
      const rows = await rowsFor(id, 'ACK_OVERDUE_DIGEST');
      assertEq(rows.length, 1, `active ADMIN ${id} got exactly one digest row`);
      assert(rows[0].body.includes('REP-2611-0101') && rows[0].body.includes('REP-2611-0102'), 'digest lists both jobs');
      assertEq(rows[0].repairOrderId, null, 'multi-order digest has no single repairOrderId');
    }
    assertEq((await rowsFor(extraInactiveAdmin.id)).length, 0, 'inactive ADMIN receives nothing');
    assertEq((await rowsFor(RECEPTIONIST_ID)).length, 0, 'RECEPTIONIST receives no ADMIN digest');
    assertEq((await rowsFor(TECH1_ID)).length, 0, 'TECHNICIAN receives no ADMIN digest');
    console.log(`  [PASS] ACK_OVERDUE_DIGEST -> ${activeAdminIds.length} active ADMIN(s) only; inactive ADMIN / other roles excluded.`);

    const unansweredResult = await notifier.notify({
      type: 'PROGRESS_UNANSWERED_DIGEST',
      orders: [{ repairOrderId: 9003, jobNumber: 'REP-2611-0103', technicianName: 'Tech 2', unansweredCount: 3 }],
    });
    assertEq(unansweredResult.delivered, activeAdminIds.length, 'PROGRESS_UNANSWERED_DIGEST to every active ADMIN');
    const unansweredRow = (await rowsFor(ADMIN_ID, 'PROGRESS_UNANSWERED_DIGEST'))[0];
    assertEq(unansweredRow.repairOrderId, 9003, 'single-order digest keeps repairOrderId');
    assert(unansweredRow.body.includes('3 รอบ'), 'digest mentions unanswered count');
    assertEq((await rowsFor(extraInactiveAdmin.id)).length, 0, 'inactive ADMIN still receives nothing');
    console.log('  [PASS] PROGRESS_UNANSWERED_DIGEST -> active ADMINs only.');

    const empty = await notifier.notify({ type: 'ACK_OVERDUE_DIGEST', orders: [] });
    assertEq(empty.delivered, 0, 'empty digest stores nothing');
    console.log('  [PASS] Empty digest is a no-op.');

    // ---------------------------------------------------------------
    // 2. Technician events and Thai templates
    // ---------------------------------------------------------------
    console.log('\n[Test 2] Technician events and templates...');
    const reserved = await notifier.notify({
      type: 'JOB_RESERVED',
      technicianId: TECH1_ID,
      repairOrderId: 9010,
      jobNumber: 'REP-2611-0110',
      machine: { brand: 'GEF', model: 'Aa+' },
    });
    assertEq(reserved.delivered, 1, 'JOB_RESERVED delivered to one technician');
    const reservedRow = (await rowsFor(TECH1_ID, 'JOB_RESERVED'))[0];
    assertEq(reservedRow.repairOrderId, 9010, 'JOB_RESERVED keeps repairOrderId');
    assert(reservedRow.body.includes('REP-2611-0110') && reservedRow.body.includes('GEF Aa+'), 'JOB_RESERVED body names job + machine');
    assertEq((await rowsFor(TECH2_ID)).length, 0, 'other technician receives nothing');

    const expectedLine =
      "ใบงาน REP-2611-0001 (เครื่อง GEF Aa+) ยังดำเนินการซ่อมอยู่ไหม? กรุณาอัปเดตสถานะ หรือกด 'ยังซ่อมอยู่'";
    assertEq(progressCheckLine('REP-2611-0001', { brand: 'GEF', model: 'Aa+' }), expectedLine, 'PROGRESS_CHECK wording matches SRS 3.6');
    const progress = await notifier.notify({
      type: 'PROGRESS_CHECK',
      technicianId: TECH1_ID,
      orders: [
        { repairOrderId: 9011, jobNumber: 'REP-2611-0001', machine: { brand: 'GEF', model: 'Aa+' } },
        { repairOrderId: 9012, jobNumber: 'REP-2611-0002', machine: { brand: 'LEHEHE', model: 'LH-01' } },
      ],
    });
    assertEq(progress.delivered, 1, 'PROGRESS_CHECK for several jobs is ONE notification');
    const progressRows = await rowsFor(TECH1_ID, 'PROGRESS_CHECK');
    assertEq(progressRows.length, 1, 'one PROGRESS_CHECK row');
    assertEq(progressRows[0].body.split('\n')[0], expectedLine, 'first line uses the SRS sentence');
    assert(progressRows[0].body.includes('REP-2611-0002'), 'second job included in the same message');
    assert((progressRows[0].payload as any)?.orders?.length === 2, 'payload keeps the structured event');
    console.log('  [PASS] JOB_RESERVED / PROGRESS_CHECK go to the technician; SRS wording; multi-job in one message.');

    await prisma.employee.update({ where: { id: TECH2_ID }, data: { isActive: false } });
    const toInactive = await notifier.notify({
      type: 'JOB_RESERVED',
      technicianId: TECH2_ID,
      repairOrderId: 9013,
      jobNumber: 'REP-2611-0113',
      machine: { brand: 'GEF', model: 'Aa+' },
    });
    await prisma.employee.update({ where: { id: TECH2_ID }, data: { isActive: true } });
    assertEq(toInactive.delivered, 0, 'inactive technician receives nothing');
    console.log('  [PASS] Inactive technician receives nothing.');

    // ---------------------------------------------------------------
    // 3. Safe delivery never throws
    // ---------------------------------------------------------------
    console.log('\n[Test 3] notifySafely never throws...');
    const broken: Notifier = { notify: async () => { throw new Error('simulated outage'); } };
    const safe = await notifySafely(ackDigest, broken);
    assertEq(safe.delivered, 0, 'failing notifier is swallowed and logged');
    const viaDefault = await notifySafely({ type: 'PROGRESS_UNANSWERED_DIGEST', orders: [] });
    assertEq(viaDefault.delivered, 0, 'default notifier path works');
    console.log('  [PASS] Notifier failure does not propagate to the caller.');

    // ---------------------------------------------------------------
    // 4. GET /api/notifications — own notifications only
    // ---------------------------------------------------------------
    console.log('\n[Test 4] GET /api/notifications ...');
    const tech1 = await tokenFor(TECH1_ID);
    const tech2 = await tokenFor(TECH2_ID);
    const admin = await tokenFor(ADMIN_ID);
    const extraAdmin = await tokenFor(extraActiveAdmin.id);
    const recep = await tokenFor(RECEPTIONIST_ID);

    const tech1List = (await axios.get(`${API_BASE}/notifications`, { headers: tech1 })).data.data;
    const tech1DbIds = (await rowsFor(TECH1_ID)).map((n) => n.id).sort((a, b) => a - b);
    const tech1ApiIds = tech1List.notifications.map((n: any) => n.id).sort((a: number, b: number) => a - b);
    assertEq(JSON.stringify(tech1ApiIds), JSON.stringify(tech1DbIds), 'technician sees exactly their own notifications');
    assertEq(tech1List.total, 2, 'technician total = 2');
    assertEq(tech1List.unreadCount, 2, 'technician unreadCount = 2');
    assert(!('recipientId' in tech1List.notifications[0]), 'recipientId is not returned');
    assertEq(tech1List.notifications[0].type, 'PROGRESS_CHECK', 'newest first');

    const tech2List = (await axios.get(`${API_BASE}/notifications`, { headers: tech2 })).data.data;
    assertEq(tech2List.total, 0, 'other technician sees none of them');
    const recepList = (await axios.get(`${API_BASE}/notifications`, { headers: recep })).data.data;
    assertEq(recepList.total, 0, 'receptionist sees none');
    const adminList = (await axios.get(`${API_BASE}/notifications`, { headers: admin })).data.data;
    assertEq(adminList.total, 2, 'admin sees own two digests');
    const extraAdminList = (await axios.get(`${API_BASE}/notifications`, { headers: extraAdmin })).data.data;
    assertEq(extraAdminList.total, 2, 'second active admin sees own two digests');
    const adminIds = new Set(adminList.notifications.map((n: any) => n.id));
    assert(extraAdminList.notifications.every((n: any) => !adminIds.has(n.id)), 'admins do not see each other\'s rows');

    const page1 = (await axios.get(`${API_BASE}/notifications?limit=1&page=1`, { headers: tech1 })).data.data;
    const page2 = (await axios.get(`${API_BASE}/notifications?limit=1&page=2`, { headers: tech1 })).data.data;
    assertEq(page1.notifications.length, 1, 'pagination page 1');
    assertEq(page2.notifications.length, 1, 'pagination page 2');
    assert(page1.notifications[0].id !== page2.notifications[0].id, 'pages differ');
    assertEq(page1.totalPages, 2, 'totalPages');
    console.log('  [PASS] Own notifications only, newest first, paginated.');

    await expectStatus(400, 'unreadOnly=yes', () => axios.get(`${API_BASE}/notifications?unreadOnly=yes`, { headers: tech1 }));
    await expectStatus(400, 'limit=101', () => axios.get(`${API_BASE}/notifications?limit=101`, { headers: tech1 }));
    await expectStatus(401, 'unauthenticated GET', () => axios.get(`${API_BASE}/notifications`));

    // ---------------------------------------------------------------
    // 5. PATCH /api/notifications/:id/read
    // ---------------------------------------------------------------
    console.log('\n[Test 5] PATCH /api/notifications/:id/read ...');
    const targetId = tech1List.notifications[1].id; // JOB_RESERVED
    const read1 = (await axios.patch(`${API_BASE}/notifications/${targetId}/read`, {}, { headers: tech1 })).data.data;
    assert(read1.readAt, 'readAt set');
    await new Promise((r) => setTimeout(r, 20));
    const read2 = (await axios.patch(`${API_BASE}/notifications/${targetId}/read`, {}, { headers: tech1 })).data.data;
    assertEq(read2.readAt, read1.readAt, 'marking again keeps the first readAt (idempotent)');

    const unread = (await axios.get(`${API_BASE}/notifications?unreadOnly=true`, { headers: tech1 })).data.data;
    assertEq(unread.total, 1, 'unreadOnly excludes the read notification');
    assertEq(unread.unreadCount, 1, 'unreadCount decreased');
    assert(unread.notifications.every((n: any) => n.readAt === null), 'unreadOnly returns only unread');
    const all = (await axios.get(`${API_BASE}/notifications?unreadOnly=false`, { headers: tech1 })).data.data;
    assertEq(all.total, 2, 'unreadOnly=false returns all');
    console.log('  [PASS] Mark read is idempotent and reflected in unreadOnly / unreadCount.');

    await expectStatus(404, "TECHNICIAN marking another employee's notification", () =>
      axios.patch(`${API_BASE}/notifications/${adminList.notifications[0].id}/read`, {}, { headers: tech1 })
    );
    const adminRowAfter = await prisma.notification.findUniqueOrThrow({ where: { id: adminList.notifications[0].id } });
    assertEq(adminRowAfter.readAt, null, "other employee's notification stays unread");
    await expectStatus(404, "ADMIN marking a technician's notification", () =>
      axios.patch(`${API_BASE}/notifications/${targetId}/read`, {}, { headers: admin })
    );
    await expectStatus(404, 'unknown notification id', () =>
      axios.patch(`${API_BASE}/notifications/999999999/read`, {}, { headers: tech1 })
    );
    await expectStatus(400, 'non-numeric id', () =>
      axios.patch(`${API_BASE}/notifications/abc/read`, {}, { headers: tech1 })
    );
    await expectStatus(401, 'unauthenticated PATCH', () =>
      axios.patch(`${API_BASE}/notifications/${targetId}/read`, {})
    );

    console.log('\n==================================================================');
    console.log('PHASE 3 NOTIFIER / NOTIFICATIONS TESTS PASSED');
    console.log('==================================================================\n');
  } finally {
    await prisma.employee.update({ where: { id: TECH2_ID }, data: { isActive: true } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { recipientId: { in: [extraActiveAdmin.id, extraInactiveAdmin.id] } } });
    await prisma.employee.deleteMany({ where: { id: { in: [extraActiveAdmin.id, extraInactiveAdmin.id] } } });
    await prisma.$disconnect();
  }
}

main().catch(async (err) => {
  console.error('\nPhase 3 Notification Test Failed:', err.response?.data || err.message);
  await prisma.$disconnect();
  process.exit(1);
});
