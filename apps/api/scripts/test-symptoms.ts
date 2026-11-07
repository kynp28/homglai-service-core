/**
 * Symptom list maintenance (ADMIN): categories and symptoms shown on the intake form.
 * Runs against the API started by test-runner.js on a *_test database.
 */
import jwt from 'jsonwebtoken';
import prisma from '@homglai/db';
import { assertSafeDatabaseUrl } from '../src/utils/test-safety';
import { getJwtSecret } from '../src/config/env';

type Headers = Record<string, string>;
const API = 'http://localhost:4000/api';

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
async function call(method: string, url: string, headers: Headers, body?: unknown) {
  const res = await fetch(`${API}${url}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
}
async function expectStatus(expected: number, label: string, p: Promise<{ status: number; json: any }>) {
  const r = await p;
  if (r.status !== expected) throw new Error(`ASSERTION FAILED: ${label} — expected HTTP ${expected}, got ${r.status}: ${JSON.stringify(r.json)}`);
  console.log(`  [PASS] ${label} -> ${expected}`);
  return r.json;
}

async function main() {
  assertSafeDatabaseUrl();
  console.log('==================================================================');
  console.log('SYMPTOM LIST MAINTENANCE (ADMIN)');
  console.log('==================================================================\n');
  const [admin, recep, tech] = await Promise.all([tokenFor(1), tokenFor(2), tokenFor(3)]);
  const run = String(Date.now()).slice(-6);
  const createdCategories: number[] = [];
  const createdOrders: number[] = [];

  try {
    console.log('[Test 1] Categories...');
    const water = (await expectStatus(201, 'ADMIN adds a category', call('POST', '/symptoms/categories', admin, { name: `  ระบบน้ำ ${run}  ` }))).data;
    createdCategories.push(water.id);
    eq(water.name, `ระบบน้ำ ${run}`, 'name trimmed');
    await expectStatus(409, 'same category name again', call('POST', '/symptoms/categories', admin, { name: `ระบบน้ำ ${run}` }));
    await expectStatus(403, 'RECEPTIONIST adds a category', call('POST', '/symptoms/categories', recep, { name: `x ${run}` }));
    await expectStatus(403, 'TECHNICIAN adds a category', call('POST', '/symptoms/categories', tech, { name: `x ${run}` }));
    await expectStatus(401, 'not logged in adds a category', call('POST', '/symptoms/categories', {}, { name: `x ${run}` }));
    await expectStatus(400, 'empty name', call('POST', '/symptoms/categories', admin, { name: '   ' }));
    await expectStatus(400, 'name over 100 characters', call('POST', '/symptoms/categories', admin, { name: 'ก'.repeat(101) }));
    await expectStatus(400, 'unknown field', call('POST', '/symptoms/categories', admin, { name: `y ${run}`, color: 'red' }));
    const power = (await expectStatus(201, 'second category', call('POST', '/symptoms/categories', admin, { name: `ระบบไฟ ${run}` }))).data;
    createdCategories.push(power.id);
    await expectStatus(200, 'rename a category', call('PATCH', `/symptoms/categories/${power.id}`, admin, { name: `ระบบไฟฟ้า ${run}` }));
    await expectStatus(409, 'rename to an existing name', call('PATCH', `/symptoms/categories/${power.id}`, admin, { name: `ระบบน้ำ ${run}` }));
    await expectStatus(404, 'rename unknown category', call('PATCH', '/symptoms/categories/999999', admin, { name: `z ${run}` }));
    pass('ADMIN only; trimmed; duplicates refused');

    console.log('\n[Test 2] Symptoms...');
    const noWater = (await expectStatus(201, 'ADMIN adds a symptom', call('POST', '/symptoms', admin, { name: 'ไม่มีน้ำออกจากหัวชง', categoryId: water.id }))).data;
    eq(noWater.categoryId, water.id, 'symptom in the category');
    await expectStatus(409, 'same symptom name in the same category', call('POST', '/symptoms', admin, { name: 'ไม่มีน้ำออกจากหัวชง', categoryId: water.id }));
    await expectStatus(201, 'same name in another category is allowed', call('POST', '/symptoms', admin, { name: 'ไม่มีน้ำออกจากหัวชง', categoryId: power.id }));
    await expectStatus(404, 'unknown category', call('POST', '/symptoms', admin, { name: 'x', categoryId: 999999 }));
    await expectStatus(400, 'missing categoryId', call('POST', '/symptoms', admin, { name: 'x' }));
    await expectStatus(403, 'RECEPTIONIST adds a symptom', call('POST', '/symptoms', recep, { name: 'x', categoryId: water.id }));
    const leak = (await expectStatus(201, 'another symptom', call('POST', '/symptoms', admin, { name: 'น้ำรั่ว', categoryId: water.id }))).data;
    await expectStatus(400, 'update with empty body', call('PATCH', `/symptoms/${leak.id}`, admin, {}));
    await expectStatus(409, 'rename into an existing name', call('PATCH', `/symptoms/${leak.id}`, admin, { name: 'ไม่มีน้ำออกจากหัวชง' }));
    const moved = (await expectStatus(200, 'move to another category', call('PATCH', `/symptoms/${leak.id}`, admin, { categoryId: power.id }))).data;
    eq(moved.categoryId, power.id, 'moved');
    const listed = (await call('GET', '/symptoms', tech)).json.data;
    const w = listed.find((c: any) => c.id === water.id);
    assert(w && w.symptoms.some((s: any) => s.id === noWater.id), 'GET /symptoms (any role) shows the new symptom');
    pass('Add, rename, move; listed for every role');

    console.log('\n[Test 3] Symptoms used on orders keep history...');
    const intake = await call('POST', '/repairs', recep, {
      customer: { name: 'Symptom Test', phone: `0877${run}` },
      machine: { brand: 'GEF', model: 'Aa+' },
      symptomIds: [noWater.id],
    });
    eq(intake.status, 201, 'intake with the new symptom');
    createdOrders.push(intake.json.data.id);
    await expectStatus(409, 'delete a symptom used on an order', call('DELETE', `/symptoms/${noWater.id}`, admin));
    await expectStatus(200, 'rename it instead', call('PATCH', `/symptoms/${noWater.id}`, admin, { name: 'ไม่มีน้ำไหลออกจากหัวชง' }));
    const order = (await call('GET', `/repairs/${intake.json.data.id}`, admin)).json.data;
    assert(order.symptoms.some((s: any) => s.symptom.name === 'ไม่มีน้ำไหลออกจากหัวชง'), 'order shows the new name');
    await expectStatus(409, 'delete a category that still has symptoms', call('DELETE', `/symptoms/categories/${water.id}`, admin));
    await expectStatus(200, 'delete an unused symptom', call('DELETE', `/symptoms/${leak.id}`, admin));
    await expectStatus(404, 'delete it again', call('DELETE', `/symptoms/${leak.id}`, admin));
    await expectStatus(403, 'TECHNICIAN deletes a symptom', call('DELETE', `/symptoms/${noWater.id}`, tech));
    const empty = (await expectStatus(201, 'empty category', call('POST', '/symptoms/categories', admin, { name: `ว่าง ${run}` }))).data;
    await expectStatus(200, 'delete an empty category', call('DELETE', `/symptoms/categories/${empty.id}`, admin));
    pass('Used symptoms cannot be deleted (rename instead); categories with symptoms cannot be deleted');

    console.log('\n==================================================================');
    console.log('SYMPTOM TESTS PASSED');
    console.log('==================================================================\n');
  } finally {
    // Remove what this run created (orders first: they reference the symptoms)
    for (const id of createdOrders) {
      await prisma.notification.deleteMany({ where: { repairOrderId: id } });
      await prisma.statusLog.deleteMany({ where: { repairOrderId: id } });
      await prisma.repairOrderSymptom.deleteMany({ where: { repairOrderId: id } });
      await prisma.repairOrder.deleteMany({ where: { id } });
    }
    await prisma.employee.updateMany({ where: { id: { in: [3, 4, 5, 6, 7] }, status: 'RESERVED' }, data: { status: 'AVAILABLE' } });
    await prisma.symptom.deleteMany({ where: { categoryId: { in: createdCategories } } });
    await prisma.symptomCategory.deleteMany({ where: { id: { in: createdCategories } } });
    await prisma.$disconnect();
  }
}

main().catch(async (err) => {
  console.error('\nSymptom Test Failed:', err.message);
  await prisma.$disconnect();
  process.exit(1);
});
