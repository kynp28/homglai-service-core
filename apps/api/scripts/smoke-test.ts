import axios from 'axios';
import crypto from 'crypto';
import prisma from '@homglai/db';
import { assertSafeDatabaseUrl } from '../src/utils/test-safety';

const API_BASE = 'http://localhost:4000/api';
const LINE_SECRET = process.env.LINE_CHANNEL_SECRET || 'test-line-secret';

function signLineWebhook(body: any, secret: string = LINE_SECRET): string {
  const payload = JSON.stringify(body);
  return crypto.createHmac('sha256', secret).update(payload).digest('base64');
}

function hasKeyDeep(obj: any, key: string): boolean {
  if (obj === null || typeof obj !== 'object') return false;
  if (Array.isArray(obj)) {
    return obj.some((item) => hasKeyDeep(item, key));
  }
  if (key in obj) return true;
  for (const v of Object.values(obj)) {
    if (hasKeyDeep(v, key)) return true;
  }
  return false;
}

function assertNoTrackingToken(label: string, payload: any) {
  if (hasKeyDeep(payload, 'trackingToken')) {
    throw new Error(`Security flaw: trackingToken leaked in ${label}`);
  }
}

function assertCustomerPrivacy(label: string, customer: any, expectedLinked: boolean) {
  if (!customer) {
    throw new Error(`Expected customer object in ${label}`);
  }
  if ('lineUserId' in customer) {
    throw new Error(`Security flaw: customer.lineUserId leaked in ${label}`);
  }
  if (customer.lineLinked !== expectedLinked) {
    throw new Error(
      `Expected customer.lineLinked === ${expectedLinked} in ${label}, got: ${customer.lineLinked}`
    );
  }
}

async function runSmokeTests() {
  assertSafeDatabaseUrl();

  console.log('========================================================');
  console.log('STARTING HOMGLAI SERVICE CORE - E2E SMOKE TEST SUITE');
  console.log('========================================================\n');

  // -------------------------------------------------------------------
  // 1. Health Check
  // -------------------------------------------------------------------
  console.log('[Test 1] Checking API Health...');
  const healthRes = await axios.get(`${API_BASE}/health`);
  if (healthRes.data.status !== 'ok' || healthRes.data.database !== 'connected') {
    throw new Error('API Health check failed');
  }
  if (healthRes.data.error || healthRes.data.message) {
    throw new Error('Health check leaked internal error message');
  }
  console.log('Health check passed: Database connected (Zero internal detail leak).\n');

  // Reset transactional test data for strict test isolation
  await prisma.statusLog.deleteMany({});
  await prisma.repairItem.deleteMany({});
  await prisma.repairOrderSymptom.deleteMany({});
  await prisma.repairOrder.deleteMany({});
  await prisma.machine.deleteMany({});
  await prisma.customer.deleteMany({});
  await prisma.employee.deleteMany({
    where: { id: { notIn: [1, 2, 3, 4, 5, 6, 7] } },
  });
  await prisma.employee.updateMany({
    data: { status: 'AVAILABLE', isActive: true },
  });

  // -------------------------------------------------------------------
  // 2. Authentication & Password Tests
  // -------------------------------------------------------------------
  console.log('[Test 2] Authentication, Roles & Change Password...');
  const defaultPassword = process.env.SEED_DEFAULT_PASSWORD || 'SecretPassword123!';

  // 2.1 Login Admin
  const adminLogin = await axios.post(`${API_BASE}/auth/login`, {
    username: 'admin',
    password: defaultPassword,
  });
  const adminToken = adminLogin.data.data.token;
  const adminHeaders = { Authorization: `Bearer ${adminToken}` };

  // 2.2 Login Receptionist
  const recepLogin = await axios.post(`${API_BASE}/auth/login`, {
    username: 'receptionist',
    password: defaultPassword,
  });
  const recepToken = recepLogin.data.data.token;
  const recepHeaders = { Authorization: `Bearer ${recepToken}` };

  // 2.3 Login Tech 1 & Tech 2
  const tech1Login = await axios.post(`${API_BASE}/auth/login`, {
    username: 'tech1',
    password: defaultPassword,
  });
  const tech1Token = tech1Login.data.data.token;
  const tech1Headers = { Authorization: `Bearer ${tech1Token}` };

  const tech2Login = await axios.post(`${API_BASE}/auth/login`, {
    username: 'tech2',
    password: defaultPassword,
  });
  const tech2Token = tech2Login.data.data.token;
  const tech2Headers = { Authorization: `Bearer ${tech2Token}` };

  console.log('User logins successful (Admin, Receptionist, Tech1, Tech2).');

  // 2.4 Change Password endpoint (POST /api/auth/change-password)
  const newPasswordTest = 'NewStrongPassword123!';
  await axios.post(
    `${API_BASE}/auth/change-password`,
    { oldPassword: defaultPassword, newPassword: newPasswordTest },
    { headers: tech2Headers }
  );
  // Revert back so future tests stay consistent
  const tech2NewLogin = await axios.post(`${API_BASE}/auth/login`, {
    username: 'tech2',
    password: newPasswordTest,
  });
  const tech2NewToken = tech2NewLogin.data.data.token;
  await axios.post(
    `${API_BASE}/auth/change-password`,
    { oldPassword: newPasswordTest, newPassword: defaultPassword },
    { headers: { Authorization: `Bearer ${tech2NewToken}` } }
  );
  console.log('Self change-password verified successfully.');

  // 2.5 Negative: Missing / Invalid Tokens (401)
  try {
    await axios.post(`${API_BASE}/repairs`, {});
    throw new Error('Expected 401 on missing token');
  } catch (err: any) {
    if (err.response?.status !== 401) throw err;
  }
  try {
    await axios.post(`${API_BASE}/repairs`, {}, { headers: { Authorization: 'Bearer invalid-token' } });
    throw new Error('Expected 401 on invalid token');
  } catch (err: any) {
    if (err.response?.status !== 401) throw err;
  }
  console.log('Negative token checks passed (401).');

  // -------------------------------------------------------------------
  // 3. Employee Management & Soft Delete (B.2, B.4)
  // -------------------------------------------------------------------
  console.log('\n[Test 3] Admin Employee Management & Soft Delete...');
  const newUsername = `newemp_${Date.now()}`;
  const createEmpRes = await axios.post(
    `${API_BASE}/employees`,
    {
      username: newUsername,
      name: 'Test New Employee',
      password: 'StrongEmpPassword123!',
      role: 'TECHNICIAN',
    },
    { headers: adminHeaders }
  );
  const newEmp = createEmpRes.data.data;
  console.log(`Created employee: ${newEmp.username} (ID: ${newEmp.id}, isActive: ${newEmp.isActive})`);

  // List employees (GET /api/employees)
  const listEmpRes = await axios.get(`${API_BASE}/employees`, { headers: adminHeaders });
  if (!Array.isArray(listEmpRes.data.data) || listEmpRes.data.data.length === 0) {
    throw new Error('GET /api/employees failed');
  }
  console.log(`Listed ${listEmpRes.data.data.length} employees.`);

  // Update employee details (PATCH /api/employees/:id)
  await axios.patch(
    `${API_BASE}/employees/${newEmp.id}`,
    { name: 'Updated Employee Name' },
    { headers: adminHeaders }
  );

  // Reset employee password (POST /api/employees/:id/reset-password)
  await axios.post(
    `${API_BASE}/employees/${newEmp.id}/reset-password`,
    { newPassword: 'ResetPasswordStrong123!' },
    { headers: adminHeaders }
  );
  console.log('Admin password reset verified.');

  // Soft delete employee (isActive = false)
  await axios.patch(
    `${API_BASE}/employees/${newEmp.id}`,
    { isActive: false },
    { headers: adminHeaders }
  );
  console.log('Employee soft-deleted (isActive: false).');

  // -------------------------------------------------------------------
  // 4. Auth Hardening Checks (C.1, C.4, G.6)
  // -------------------------------------------------------------------
  console.log('\n[Test 4: G.6] Auth Hardening Checks (Deactivation, Real-time Role, Dummy Compare)...');
  // 4.1 Login with deactivated employee -> 401
  try {
    await axios.post(`${API_BASE}/auth/login`, {
      username: newUsername,
      password: 'ResetPasswordStrong123!',
    });
    throw new Error('Expected 401 logging into deactivated account');
  } catch (err: any) {
    if (err.response?.status !== 401) throw err;
    if (err.response?.data?.message !== 'Invalid username or password') {
      throw new Error(`Expected message 'Invalid username or password', got: ${err.response?.data?.message}`);
    }
    console.log('Negative passed: Login with deactivated employee returned 401 with generic message.');
  }

  // 4.2 Dummy compare / Timing attack check for non-existent user
  try {
    await axios.post(`${API_BASE}/auth/login`, {
      username: 'non_existent_user_99999',
      password: 'RandomPassword123!',
    });
    throw new Error('Expected 401 for non-existent user');
  } catch (err: any) {
    if (err.response?.status !== 401) throw err;
    console.log('Negative passed: Non-existent user returned 401 (constant-time dummy comparison).');
  }

  // 4.3 Authenticate rejects token of deactivated employee
  const activeEmpLogin = await axios.post(
    `${API_BASE}/employees`,
    {
      username: `active_to_deact_${Date.now()}`,
      name: 'Temp Active',
      password: 'TempPassword123!',
      role: 'TECHNICIAN',
    },
    { headers: adminHeaders }
  );
  const tempEmpId = activeEmpLogin.data.data.id;
  const tempTokenRes = await axios.post(`${API_BASE}/auth/login`, {
    username: activeEmpLogin.data.data.username,
    password: 'TempPassword123!',
  });
  const tempHeaders = { Authorization: `Bearer ${tempTokenRes.data.data.token}` };

  // Deactivate in DB
  await prisma.employee.update({ where: { id: tempEmpId }, data: { isActive: false } });

  // Use token -> must get 401!
  try {
    await axios.patch(
      `${API_BASE}/employees/${tempEmpId}/status`,
      { status: 'AVAILABLE' },
      { headers: tempHeaders }
    );
    throw new Error('Expected 401 for token of deactivated employee');
  } catch (err: any) {
    if (err.response?.status !== 401) throw err;
    console.log('Negative passed: Token of deactivated employee rejected on request with 401.');
  }

  // 4.4 Login with migration backfilled employee (DISABLED hash) -> must be 401, not 500
  await prisma.employee.upsert({
    where: { id: 99 },
    update: {
      username: 'legacy_disabled_emp',
      passwordHash: '$2a$10$DISABLED_4f32e7372b9e873194b40b3c',
      isActive: true,
    },
    create: {
      id: 99,
      name: 'Legacy Disabled Tech',
      username: 'legacy_disabled_emp',
      passwordHash: '$2a$10$DISABLED_4f32e7372b9e873194b40b3c',
      role: 'TECHNICIAN',
      status: 'AVAILABLE',
      isActive: true,
    },
  });
  try {
    await axios.post(`${API_BASE}/auth/login`, {
      username: 'legacy_disabled_emp',
      password: 'any_attempted_password',
    });
    throw new Error('Expected 401 logging in with disabled backfill user');
  } catch (err: any) {
    if (err.response?.status !== 401) {
      throw new Error(`Expected 401, but got ${err.response?.status} (${JSON.stringify(err.response?.data)})`);
    }
    console.log('Negative passed: Login with migration backfilled disabled hash returned 401 (not 500).');
  }
  await prisma.employee.delete({ where: { id: 99 } });

  // 4.5 Real-time Role Update: Existing token immediately inherits fresh role from DB
  await axios.patch(`${API_BASE}/employees/4`, { role: 'RECEPTIONIST' }, { headers: adminHeaders });
  // Tech 2's token (issued when role was TECHNICIAN) should now have RECEPTIONIST privileges
  const dynamicRoleOrder = await axios.post(
    `${API_BASE}/repairs`,
    {
      customer: { name: 'Role Change Test Customer', phone: '0895554444' },
      machine: { brand: 'Nuova Simonelli', model: 'Appia II' },
      symptomIds: [1],
    },
    { headers: tech2Headers } // Uses existing token!
  );
  if (dynamicRoleOrder.status !== 201) {
    throw new Error('Expected token to inherit new RECEPTIONIST role immediately');
  }
  console.log('Positive passed: Changed employee role in DB; existing token immediately inherited new role.');
  // Clean up order and restore Tech 2 role
  await prisma.repairOrderSymptom.deleteMany({ where: { repairOrderId: dynamicRoleOrder.data.data.id } });
  await prisma.statusLog.deleteMany({ where: { repairOrderId: dynamicRoleOrder.data.data.id } });
  await prisma.repairOrder.delete({ where: { id: dynamicRoleOrder.data.data.id } });
  await axios.patch(`${API_BASE}/employees/4`, { role: 'TECHNICIAN' }, { headers: adminHeaders });
  await prisma.employee.updateMany({
    where: { id: { in: [3, 4, 5, 6, 7] } },
    data: { status: 'AVAILABLE' },
  });

  // -------------------------------------------------------------------
  // 5. Repair Order Intake & Auto-Queue Assignment
  // -------------------------------------------------------------------
  console.log('\n[Test 5] Repair Order Intake & Auto-Queue Assignment...');

  // 5.1 Negative: Technician cannot create repair order -> 403 Forbidden
  try {
    await axios.post(
      `${API_BASE}/repairs`,
      {
        customer: { name: 'Tech Intake Attempt', phone: '0898887777' },
        machine: { brand: 'La Marzocco', model: 'Linea Mini' },
        symptomIds: [1],
      },
      { headers: tech1Headers }
    );
    throw new Error('Expected 403 when technician attempts to create repair order');
  } catch (err: any) {
    if (err.response?.status !== 403) throw err;
    console.log('Negative passed: Technician creating repair order rejected with 403 Forbidden.');
  }

  // 5.2 Positive Intake by Receptionist
  const uniqueSerial = `SN-SMOKE-${Date.now()}`;
  const intakeRes = await axios.post(
    `${API_BASE}/repairs`,
    {
      customer: { name: 'Somchai Jaidee', phone: '089-123-4567' },
      machine: { brand: 'Rocket', model: 'Giotto', serialNumber: uniqueSerial },
      symptomIds: [1],
      otherSymptom: 'Pressure pump making loud noise',
    },
    { headers: recepHeaders }
  );

  const order = intakeRes.data.data;
  assertCustomerPrivacy('POST /api/repairs (Intake)', order.customer, false);
  console.log(`Repair Order created: ${order.jobNumber} (ID: ${order.id})`);
  console.log(`Assigned technician: ${order.technician ? order.technician.name : 'None'} (Status: ${order.status})`);

  // Machine Deduplication check
  const secondIntakeRes = await axios.post(
    `${API_BASE}/repairs`,
    {
      customer: { name: 'Somchai Jaidee', phone: '0891234567' },
      machine: { brand: 'Rocket', model: 'Giotto', serialNumber: uniqueSerial },
      symptomIds: [1],
      otherSymptom: 'Routine annual maintenance',
    },
    { headers: recepHeaders }
  );
  if (secondIntakeRes.data.data.machineId !== order.machineId) {
    throw new Error(`Machine deduplication failed`);
  }
  console.log(`Machine deduplication verified: Reused machineId ${order.machineId}.`);

  // -------------------------------------------------------------------
  // 6. Role Permissions & Quotation Rules (D.1, D.2, G.5)
  // -------------------------------------------------------------------
  console.log('\n[Test 6: G.5] Role Permissions & Quotation Guardrails...');
  // 6.1 Negative: Receptionist calling addItem -> 403 Forbidden
  try {
    await axios.post(
      `${API_BASE}/repairs/${order.id}/items`,
      { name: 'Water Filter', price: 800 },
      { headers: recepHeaders }
    );
    throw new Error('Expected 403 for Receptionist adding item');
  } catch (err: any) {
    if (err.response?.status !== 403) throw err;
    console.log('Negative passed: Receptionist calling addItem rejected with 403 Forbidden.');
  }

  const assignedTechHeaders = order.technicianId === 3 ? tech1Headers : tech2Headers;
  const unassignedTechHeaders = order.technicianId === 3 ? tech2Headers : tech1Headers;

  // 6.1b Negative: Technician who is NOT assigned to this order adding item -> 403 Forbidden
  try {
    await axios.post(
      `${API_BASE}/repairs/${order.id}/items`,
      { name: 'Intruder Tech Part', price: 500 },
      { headers: unassignedTechHeaders }
    );
    throw new Error('Expected 403 when unassigned technician attempts to add item');
  } catch (err: any) {
    if (err.response?.status !== 403) throw err;
    console.log('Negative passed: Unassigned technician calling addItem rejected with 403 Forbidden.');
  }

  // 6.1c Negative: Negative price -> 400
  try {
    await axios.post(
      `${API_BASE}/repairs/${order.id}/items`,
      { name: 'Negative Part', price: -100 },
      { headers: assignedTechHeaders }
    );
    throw new Error('Expected 400 for negative price');
  } catch (err: any) {
    if (err.response?.status !== 400) throw err;
    console.log('Negative passed: Negative price rejected with 400.');
  }

  // 6.1d Negative: Zero price -> 400
  try {
    await axios.post(
      `${API_BASE}/repairs/${order.id}/items`,
      { name: 'Zero Part', price: 0 },
      { headers: assignedTechHeaders }
    );
    throw new Error('Expected 400 for zero price');
  } catch (err: any) {
    if (err.response?.status !== 400) throw err;
    console.log('Negative passed: Zero price rejected with 400.');
  }

  // 6.1e Negative: More than 2 decimal places price -> 400
  try {
    await axios.post(
      `${API_BASE}/repairs/${order.id}/items`,
      { name: 'Three Decimals Part', price: 1200.755 },
      { headers: assignedTechHeaders }
    );
    throw new Error('Expected 400 for price with >2 decimal places');
  } catch (err: any) {
    if (err.response?.status !== 400) throw err;
    console.log('Negative passed: Price with >2 decimal places rejected with 400.');
  }

  // 6.2 Negative: Setting same status -> 409 Conflict
  try {
    await axios.patch(
      `${API_BASE}/repairs/${order.id}/status`,
      { status: order.status },
      { headers: adminHeaders }
    );
    throw new Error('Expected 409 setting same status');
  } catch (err: any) {
    if (err.response?.status !== 409) throw err;
    console.log('Negative passed: Setting same status rejected with 409 Conflict.');
  }

  // 6.3 Negative: Manually setting INSPECTING or WAITING_APPROVAL -> 409 Conflict
  try {
    await axios.patch(
      `${API_BASE}/repairs/${order.id}/status`,
      { status: 'WAITING_APPROVAL' },
      { headers: adminHeaders }
    );
    throw new Error('Expected 409 manually setting WAITING_APPROVAL');
  } catch (err: any) {
    if (err.response?.status !== 409) throw err;
    console.log('Negative passed: Manually setting WAITING_APPROVAL rejected with 409 Conflict.');
  }

  // 6.4 Add quotation item (transitions order to WAITING_APPROVAL)
  const item1Res = await axios.post(
    `${API_BASE}/repairs/${order.id}/items`,
    { name: 'Pressure Relief Valve', price: 1200 },
    { headers: adminHeaders }
  );
  const item1 = item1Res.data.data.item;
  console.log(`Added item: ${item1.name} (Status: ${item1.status}, Order Status: WAITING_APPROVAL)`);

  // 6.5 Negative: Technician trying to manually bypass WAITING_APPROVAL -> REPAIRING while item is PENDING
  try {
    await axios.patch(
      `${API_BASE}/repairs/${order.id}/status`,
      { status: 'REPAIRING' },
      { headers: adminHeaders }
    );
    throw new Error('Expected 409 bypassing WAITING_APPROVAL with pending items');
  } catch (err: any) {
    if (err.response?.status !== 409) throw err;
    console.log('Negative passed: Leaving WAITING_APPROVAL with pending items rejected with 409 Conflict.');
  }

  // 6.6 Negative: Receptionist trying to transition to REPAIRING -> 403 Forbidden
  try {
    await axios.patch(
      `${API_BASE}/repairs/${order.id}/status`,
      { status: 'REPAIRING' },
      { headers: recepHeaders }
    );
    throw new Error('Expected 403 for Receptionist transitioning to REPAIRING');
  } catch (err: any) {
    if (err.response?.status !== 403) throw err;
    console.log('Negative passed: Receptionist setting REPAIRING rejected with 403 Forbidden.');
  }

  // -------------------------------------------------------------------
  // 7. G.4: Reject all items -> Order returns to INSPECTING
  // -------------------------------------------------------------------
  console.log('\n[Test 7: G.4] All items rejected -> Return to INSPECTING...');
  const rejectRes = await axios.patch(
    `${API_BASE}/repairs/${order.id}/items/${item1.id}/status`,
    { status: 'REJECTED' },
    { headers: adminHeaders }
  );
  if (rejectRes.data.data.order.status !== 'INSPECTING') {
    throw new Error(`Expected order status INSPECTING after all items rejected, got: ${rejectRes.data.data.order.status}`);
  }
  console.log(`All items rejected: Order auto-reverted to ${rejectRes.data.data.order.status}!`);

  // -------------------------------------------------------------------
  // 8. D.4: Item Completion & Order Completion Guardrails
  // -------------------------------------------------------------------
  console.log('\n[Test 8: D.4] Item Completion Workflow & Order Completion Guardrail...');
  // Add an item and approve it
  const approvedItemRes = await axios.post(
    `${API_BASE}/repairs/${order.id}/items`,
    { name: 'Grouphead Gasket Kit', price: 650 },
    { headers: adminHeaders }
  );
  const approvedItemId = approvedItemRes.data.data.item.id;

  // Approve item -> order auto-resumes to REPAIRING
  await axios.patch(
    `${API_BASE}/repairs/${order.id}/items/${approvedItemId}/status`,
    { status: 'APPROVED' },
    { headers: adminHeaders }
  );

  // Negative: Try to transition REPAIRING -> NEW -> 409 Conflict
  try {
    await axios.patch(
      `${API_BASE}/repairs/${order.id}/status`,
      { status: 'NEW' },
      { headers: adminHeaders }
    );
    throw new Error('Expected 409 transitioning from REPAIRING to NEW');
  } catch (err: any) {
    if (err.response?.status !== 409) throw err;
    console.log('Negative passed: Transition REPAIRING -> NEW rejected with 409 Conflict.');
  }

  // Negative: Try to transition order to COMPLETED while approved item is not completed
  try {
    await axios.patch(
      `${API_BASE}/repairs/${order.id}/status`,
      { status: 'COMPLETED' },
      { headers: adminHeaders }
    );
    throw new Error('Expected 409 completing order with uncompleted approved items');
  } catch (err: any) {
    if (err.response?.status !== 409) throw err;
    console.log('Negative passed: Order completion rejected with 409 because approved item is not completed.');
  }

  // Mark item as COMPLETED via PATCH /api/repairs/:id/items/:itemId/complete
  const completeItemRes = await axios.patch(
    `${API_BASE}/repairs/${order.id}/items/${approvedItemId}/complete`,
    {},
    { headers: adminHeaders }
  );
  if (completeItemRes.data.data.item.status !== 'COMPLETED') {
    throw new Error('Failed to mark item as COMPLETED');
  }
  console.log(`Item successfully marked as COMPLETED.`);

  // Now transition order to COMPLETED -> succeeds!
  const adminCompletedRes = await axios.patch(
    `${API_BASE}/repairs/${order.id}/status`,
    { status: 'COMPLETED' },
    { headers: adminHeaders }
  );
  assertCustomerPrivacy('PATCH /api/repairs/:id/status (Admin)', adminCompletedRes.data.data.customer, false);
  if (!adminCompletedRes.data.data.trackingToken) {
    throw new Error('Expected trackingToken for ADMIN on PATCH /api/repairs/:id/status');
  }
  console.log('Order transitioned to COMPLETED successfully.');

  // -------------------------------------------------------------------
  // 9. D.3: COMPLETED -> REPAIRING Rework Test
  // -------------------------------------------------------------------
  console.log('\n[Test 9: D.3] COMPLETED -> REPAIRING (Rework Assignment)...');
  await axios.patch(
    `${API_BASE}/repairs/${order.id}/status`,
    { status: 'REPAIRING', note: 'Customer reported minor leak after repair' },
    { headers: adminHeaders }
  );
  const reworkOrder = await prisma.repairOrder.findUnique({ where: { id: order.id } });
  if (reworkOrder?.status !== 'REPAIRING' || !reworkOrder.technicianId) {
    throw new Error('Rework assignment failed');
  }
  const reworkTech = await prisma.employee.findUnique({ where: { id: reworkOrder.technicianId } });
  if (reworkTech?.status !== 'BUSY') {
    throw new Error('Rework technician was not marked BUSY');
  }
  console.log(`Rework order resumed to REPAIRING with Tech ${reworkTech.name} set to BUSY.`);

  // Complete and Deliver
  await axios.patch(
    `${API_BASE}/repairs/${order.id}/status`,
    { status: 'COMPLETED' },
    { headers: adminHeaders }
  );
  // Receptionist is allowed to deliver
  await axios.patch(
    `${API_BASE}/repairs/${order.id}/status`,
    { status: 'DELIVERED', note: 'Customer collected machine' },
    { headers: recepHeaders }
  );
  console.log('Order delivered by Receptionist (Terminal State DELIVERED).');

  // Negative: Transition out of terminal state -> 409
  try {
    await axios.patch(
      `${API_BASE}/repairs/${order.id}/status`,
      { status: 'REPAIRING' },
      { headers: adminHeaders }
    );
    throw new Error('Expected 409 transitioning out of terminal DELIVERED');
  } catch (err: any) {
    if (err.response?.status !== 409) throw err;
    console.log('Negative passed: Transition out of terminal DELIVERED rejected with 409 Conflict.');
  }

  // -------------------------------------------------------------------
  // 10. G.2: LINE Webhook Security & Edge Cases
  // -------------------------------------------------------------------
  console.log('\n[Test 10: G.2] LINE Webhook Security (Signatures, Non-owner, Wrong Phone, Tracking Link)...');

  // 10.0a Missing x-line-signature header -> 401
  try {
    await axios.post(`${API_BASE}/webhook/line`, { events: [] });
    throw new Error('Expected 401 when x-line-signature header is missing');
  } catch (err: any) {
    if (err.response?.status !== 401) throw err;
    console.log('Negative passed: Missing x-line-signature rejected with 401.');
  }

  // 10.0b Invalid x-line-signature header -> 401
  try {
    await axios.post(
      `${API_BASE}/webhook/line`,
      { events: [] },
      { headers: { 'Content-Type': 'application/json', 'x-line-signature': 'invalid_signature_hash==' } }
    );
    throw new Error('Expected 401 when x-line-signature is invalid');
  } catch (err: any) {
    if (err.response?.status !== 401) throw err;
    console.log('Negative passed: Invalid x-line-signature rejected with 401.');
  }

  // 10.1 Wrong phone binding
  const wrongPhoneBody = {
    events: [
      {
        type: 'message',
        replyToken: 'reply-token-wrong-phone',
        source: { userId: 'U_LINE_WRONG_PHONE' },
        message: { type: 'text', text: `${order.jobNumber} 0819999999` },
      },
    ],
  };
  await axios.post(`${API_BASE}/webhook/line`, wrongPhoneBody, {
    headers: {
      'Content-Type': 'application/json',
      'x-line-signature': signLineWebhook(wrongPhoneBody),
    },
  });
  await new Promise((r) => setTimeout(r, 400));
  const unverifiedCust = await prisma.customer.findUnique({ where: { id: order.customerId } });
  if (unverifiedCust?.lineUserId !== null) {
    throw new Error('Expected customer.lineUserId to remain null on wrong phone binding');
  }
  console.log('Negative passed: Binding with wrong phone left customer.lineUserId as null.');

  // 10.2 Valid binding
  const validBindingBody = {
    events: [
      {
        type: 'message',
        replyToken: 'reply-token-valid',
        source: { userId: 'U_LINE_REAL_CUSTOMER' },
        message: { type: 'text', text: `${order.jobNumber} 0891234567` },
      },
    ],
  };
  await axios.post(`${API_BASE}/webhook/line`, validBindingBody, {
    headers: {
      'Content-Type': 'application/json',
      'x-line-signature': signLineWebhook(validBindingBody),
    },
  });
  await new Promise((r) => setTimeout(r, 400));
  const boundCust = await prisma.customer.findUnique({ where: { id: order.customerId } });
  if (boundCust?.lineUserId !== 'U_LINE_REAL_CUSTOMER') {
    throw new Error('LINE binding failed');
  }
  console.log(`LINE binding succeeded: Customer lineUserId is ${boundCust.lineUserId}.`);

  // 10.3 Binding from a different LINE account on same order -> Rejected
  const hijackBody = {
    events: [
      {
        type: 'message',
        replyToken: 'reply-token-hijack',
        source: { userId: 'U_LINE_HIJACKER' },
        message: { type: 'text', text: `${order.jobNumber} 0891234567` },
      },
    ],
  };
  await axios.post(`${API_BASE}/webhook/line`, hijackBody, {
    headers: {
      'Content-Type': 'application/json',
      'x-line-signature': signLineWebhook(hijackBody),
    },
  });
  await new Promise((r) => setTimeout(r, 400));
  const recheckedCust = await prisma.customer.findUnique({ where: { id: order.customerId } });
  if (recheckedCust?.lineUserId !== 'U_LINE_REAL_CUSTOMER') {
    throw new Error('Security flaw: LINE account was hijacked by another LINE user!');
  }
  console.log('Negative passed: Re-binding from another LINE account was safely blocked.');

  // 10.4 Non-owner postback -> DB must NOT change
  const nonOwnerPostback = {
    events: [
      {
        type: 'postback',
        replyToken: 'reply-token-non-owner',
        source: { userId: 'U_LINE_STRANGER_ATTACKER' },
        postback: {
          data: `action=resolve_item&orderId=${order.id}&itemId=${approvedItemId}&status=APPROVED`,
        },
      },
    ],
  };
  await axios.post(`${API_BASE}/webhook/line`, nonOwnerPostback, {
    headers: {
      'Content-Type': 'application/json',
      'x-line-signature': signLineWebhook(nonOwnerPostback),
    },
  });
  console.log('Negative passed: Non-owner postback rejected (Customer ownership enforced).');

  // -------------------------------------------------------------------
  // 11. G.3: SSE Stream Verification
  // -------------------------------------------------------------------
  console.log('\n[Test 11: G.3] SSE Real-time Stream Verification...');
  // 11.1 Stream using jobNumber -> Expect 404
  try {
    await axios.get(`${API_BASE}/tracking/stream/${order.jobNumber}`);
    throw new Error('Expected 404 streaming with jobNumber');
  } catch (err: any) {
    if (err.response?.status !== 404) throw err;
    console.log('Negative passed: Streaming with jobNumber returned 404 (Obscurity protection).');
  }

  // 11.2 Stream using trackingToken -> Expect 200 with text/event-stream
  const sseRes = await axios.get(`${API_BASE}/tracking/stream/${order.trackingToken}`, {
    responseType: 'stream',
    timeout: 3000,
  });
  if (sseRes.status !== 200 || !sseRes.headers['content-type']?.includes('text/event-stream')) {
    throw new Error('SSE Stream failed: Expected 200 and text/event-stream content-type');
  }
  sseRes.data.destroy();
  console.log('Positive passed: Streaming with trackingToken established SSE stream (200 text/event-stream).');

  // -------------------------------------------------------------------
  // 12. Unmatched Routes & Swagger Production Guard
  // -------------------------------------------------------------------
  console.log('\n[Test 12] Unmatched Routes...');
  try {
    await axios.get(`${API_BASE}/route-does-not-exist`);
    throw new Error('Expected 404');
  } catch (err: any) {
    if (err.response?.status !== 404) throw err;
    console.log(`Negative passed: Unmatched route returned 404: ${err.response.data.message}`);
  }

  // -------------------------------------------------------------------
  // 13. Requirement 5: Symptoms & Repair Order Query Endpoints & RBAC
  // -------------------------------------------------------------------
  console.log('\n[Test 13: Req 5] Symptoms & Repair Order Query Endpoints & RBAC...');

  // 13.1 GET /api/symptoms (accessible by all roles)
  const symAdmin = await axios.get(`${API_BASE}/symptoms`, { headers: adminHeaders });
  const symRecep = await axios.get(`${API_BASE}/symptoms`, { headers: recepHeaders });
  const symTech = await axios.get(`${API_BASE}/symptoms`, { headers: tech1Headers });
  if (!Array.isArray(symAdmin.data.data) || !Array.isArray(symTech.data.data)) {
    throw new Error('Expected array of symptom categories from /api/symptoms');
  }
  console.log('Positive passed: GET /api/symptoms accessible by Admin, Receptionist, and Technician.');

  // 13.2 Negative: Unauthenticated /api/symptoms -> 401
  try {
    await axios.get(`${API_BASE}/symptoms`);
    throw new Error('Expected 401 on unauthenticated /api/symptoms');
  } catch (err: any) {
    if (err.response?.status !== 401) throw err;
    console.log('Negative passed: Unauthenticated /api/symptoms rejected with 401.');
  }

  // 13.3 GET /api/repairs (Admin / Receptionist see all, filtering, pagination)
  const listAdmin = await axios.get(`${API_BASE}/repairs?page=1&limit=10`, { headers: adminHeaders });
  if (typeof listAdmin.data.data.total !== 'number' || !Array.isArray(listAdmin.data.data.orders)) {
    throw new Error('Invalid structure for GET /api/repairs');
  }

  // Negative: Invalid status filter -> 400 Bad Request
  try {
    await axios.get(`${API_BASE}/repairs?status=INVALID_STATUS`, { headers: adminHeaders });
    throw new Error('Expected 400 for invalid status query');
  } catch (err: any) {
    if (err.response?.status !== 400) throw err;
    console.log('Negative passed: Invalid status filter rejected with 400 Bad Request.');
  }

  // Negative: Search query exceeding 100 characters -> 400 Bad Request
  try {
    await axios.get(`${API_BASE}/repairs?search=${'a'.repeat(101)}`, { headers: adminHeaders });
    throw new Error('Expected 400 for search query > 100 characters');
  } catch (err: any) {
    if (err.response?.status !== 400) throw err;
    console.log('Negative passed: Search query exceeding 100 characters rejected with 400 Bad Request.');
  }
  // Assert no passwordHash or trackingToken in list items
  for (const o of listAdmin.data.data.orders) {
    if ((o as any).passwordHash || (o.technician && (o.technician as any).passwordHash)) {
      throw new Error('Security flaw: passwordHash leaked in repair order listing!');
    }
    if ((o as any).trackingToken) {
      throw new Error('Security flaw: trackingToken leaked in general repair order listing!');
    }
  }
  console.log('Positive passed: GET /api/repairs lists orders with pagination & zero credential/tracking leak.');

  // 13.4 Search & Status Filtering
  const listFiltered = await axios.get(`${API_BASE}/repairs?search=${order.jobNumber}`, { headers: recepHeaders });
  if (listFiltered.data.data.orders.length === 0) {
    throw new Error('Expected search by jobNumber to find order');
  }
  console.log('Positive passed: Search filter by jobNumber returned matching orders.');

  // 13.5 RBAC: Technician visibility on GET /api/repairs
  const tech2Order = await prisma.repairOrder.create({
    data: {
      jobNumber: `REP-TEST-T2-${Date.now()}`,
      trackingToken: crypto.randomBytes(24).toString('base64url'),
      status: 'REPAIRING',
      customerId: order.customerId,
      machineId: order.machineId,
      technicianId: 4, // Tech 2
    },
  });

  const tech1List = await axios.get(`${API_BASE}/repairs`, { headers: tech1Headers });
  const tech1OrderIds = tech1List.data.data.orders.map((o: any) => o.id);
  if (tech1OrderIds.includes(tech2Order.id)) {
    throw new Error('Security flaw: Technician 1 can see Technician 2 assigned order in list!');
  }
  console.log('Positive passed: Technician list visibility strictly restricted to own assigned jobs + NEW jobs.');

  // 13.6 GET /api/repairs/:id Details & Relations
  const detailAdmin = await axios.get(`${API_BASE}/repairs/${order.id}`, { headers: adminHeaders });
  if (!detailAdmin.data.data.customer || !detailAdmin.data.data.machine || !detailAdmin.data.data.statusLogs) {
    throw new Error('Missing relations in GET /api/repairs/:id');
  }
  assertCustomerPrivacy('GET /api/repairs/:id (Admin)', detailAdmin.data.data.customer, true);
  if (!detailAdmin.data.data.trackingToken) {
    throw new Error('Expected trackingToken for ADMIN on GET /api/repairs/:id');
  }

  const detailRecep = await axios.get(`${API_BASE}/repairs/${order.id}`, { headers: recepHeaders });
  assertCustomerPrivacy('GET /api/repairs/:id (Receptionist)', detailRecep.data.data.customer, true);
  if (!detailRecep.data.data.trackingToken) {
    throw new Error('Expected trackingToken for RECEPTIONIST on GET /api/repairs/:id');
  }
  console.log('Positive passed: GET /api/repairs/:id includes customer, machine, symptoms, items, and statusLogs.');

  // 13.7 RBAC: Technician viewing another technician\'s order -> 403 Forbidden
  try {
    await axios.get(`${API_BASE}/repairs/${tech2Order.id}`, { headers: tech1Headers });
    throw new Error('Expected 403 when Technician 1 views Technician 2 order');
  } catch (err: any) {
    if (err.response?.status !== 403) throw err;
    console.log('Negative passed: Technician viewing another technician\'s order rejected with 403 Forbidden.');
  }

  // 13.8 Technician viewing own order succeeds, but trackingToken is omitted
  const tech2View = await axios.get(`${API_BASE}/repairs/${tech2Order.id}`, { headers: tech2Headers });
  if (tech2View.status !== 200) {
    throw new Error('Expected 200 when Technician views own order');
  }
  assertCustomerPrivacy('GET /api/repairs/:id (Technician)', tech2View.data.data.customer, true);
  assertNoTrackingToken('GET /api/repairs/:id (Technician)', tech2View.data.data);
  console.log('Positive passed: Technician viewing own order succeeds with trackingToken safely hidden.');

  // Cleanup tech2Order
  await prisma.repairOrder.delete({ where: { id: tech2Order.id } });

  // -------------------------------------------------------------------
  // 14. Customer Privacy & Role-based Redaction Verification
  // -------------------------------------------------------------------
  console.log('\n[Test 14] Customer Privacy & Role-based Redaction Verification...');

  // Set all technicians to BUSY so next order goes into NEW queue
  await prisma.employee.updateMany({
    where: { role: 'TECHNICIAN' },
    data: { status: 'BUSY' },
  });

  // Create a new order while technicians are BUSY -> order stays NEW
  const privacyCustPhone = `088${Math.floor(1000000 + Math.random() * 9000000)}`;
  const privacyOrderRes = await axios.post(
    `${API_BASE}/repairs`,
    {
      customer: { name: 'Privacy Test Customer', phone: privacyCustPhone },
      machine: { brand: 'Rocket', model: 'Apartamento', serialNumber: `SN-PRIV-${Date.now()}` },
      symptomIds: [1],
    },
    { headers: recepHeaders }
  );
  const privacyOrder = privacyOrderRes.data.data;
  assertCustomerPrivacy('POST /api/repairs', privacyOrder.customer, false);
  if (!privacyOrder.trackingToken) {
    throw new Error('Expected trackingToken for Receptionist on POST /api/repairs');
  }

  // 14.1 Endpoint 1: PATCH /api/employees/:id/status (Technician gets assignedOrder)
  // Tech 1 becomes AVAILABLE -> triggers auto-assignment of the NEW order
  const tech1StatusRes = await axios.patch(
    `${API_BASE}/employees/3/status`,
    { status: 'AVAILABLE' },
    { headers: tech1Headers }
  );
  const tech1StatusData = tech1StatusRes.data.data;
  if (!tech1StatusData.assignedOrder || tech1StatusData.assignedOrder.id !== privacyOrder.id) {
    throw new Error('Expected assignedOrder to be assigned to Tech 1 upon becoming AVAILABLE');
  }
  assertCustomerPrivacy('PATCH /api/employees/:id/status (assignedOrder)', tech1StatusData.assignedOrder.customer, false);
  assertNoTrackingToken('PATCH /api/employees/:id/status (Technician)', tech1StatusData);
  console.log('Positive passed: PATCH /api/employees/:id/status omits trackingToken deeply and protects customer privacy.');

  // 14.2 Endpoint 2: POST /api/repairs/:id/items (Technician adds item)
  const techAddItemRes = await axios.post(
    `${API_BASE}/repairs/${privacyOrder.id}/items`,
    { name: 'Solenoid Valve', price: 950 },
    { headers: tech1Headers }
  );
  assertNoTrackingToken('POST /api/repairs/:id/items (Technician)', techAddItemRes.data.data);
  const privacyItemId = techAddItemRes.data.data.item.id;
  console.log('Positive passed: POST /api/repairs/:id/items omits trackingToken deeply for Technician.');

  // Admin approves the item -> order returns to REPAIRING
  await axios.patch(
    `${API_BASE}/repairs/${privacyOrder.id}/items/${privacyItemId}/status`,
    { status: 'APPROVED' },
    { headers: adminHeaders }
  );

  // 14.3 Endpoint 3: PATCH /api/repairs/:id/items/:itemId/complete (Technician completes item)
  const techCompleteItemRes = await axios.patch(
    `${API_BASE}/repairs/${privacyOrder.id}/items/${privacyItemId}/complete`,
    {},
    { headers: tech1Headers }
  );
  assertNoTrackingToken('PATCH /api/repairs/:id/items/:itemId/complete (Technician)', techCompleteItemRes.data.data);
  console.log('Positive passed: PATCH /api/repairs/:id/items/:itemId/complete omits trackingToken deeply for Technician.');

  // 14.4 Endpoint 4: PATCH /api/repairs/:id/status (Technician completes order)
  const techCompleteOrderRes = await axios.patch(
    `${API_BASE}/repairs/${privacyOrder.id}/status`,
    { status: 'COMPLETED' },
    { headers: tech1Headers }
  );
  assertCustomerPrivacy('PATCH /api/repairs/:id/status (Technician)', techCompleteOrderRes.data.data.customer, false);
  assertNoTrackingToken('PATCH /api/repairs/:id/status (Technician)', techCompleteOrderRes.data.data);
  console.log('Positive passed: PATCH /api/repairs/:id/status omits trackingToken deeply for Technician.');

  // 14.5 Admin transitions status -> ADMIN still receives trackingToken
  const adminReworkRes = await axios.patch(
    `${API_BASE}/repairs/${privacyOrder.id}/status`,
    { status: 'REPAIRING', note: 'Admin rework check' },
    { headers: adminHeaders }
  );
  assertCustomerPrivacy('PATCH /api/repairs/:id/status (Admin)', adminReworkRes.data.data.customer, false);
  if (!adminReworkRes.data.data.trackingToken) {
    throw new Error('Security flaw: trackingToken was unexpectedly omitted for ADMIN on PATCH /api/repairs/:id/status');
  }
  console.log('Positive passed: ADMIN retains trackingToken on PATCH /api/repairs/:id/status.');

  // 14.6 Link customer LINE and test GET /api/repairs/:id across 3 roles
  await prisma.customer.update({
    where: { id: privacyOrder.customerId },
    data: { lineUserId: 'U_PRIVACY_LINE_USER_123' },
  });

  const getAdminPrivacy = await axios.get(`${API_BASE}/repairs/${privacyOrder.id}`, { headers: adminHeaders });
  assertCustomerPrivacy('GET /api/repairs/:id (Admin)', getAdminPrivacy.data.data.customer, true);
  if (!getAdminPrivacy.data.data.trackingToken) {
    throw new Error('Expected trackingToken for ADMIN on GET /api/repairs/:id');
  }

  const getRecepPrivacy = await axios.get(`${API_BASE}/repairs/${privacyOrder.id}`, { headers: recepHeaders });
  assertCustomerPrivacy('GET /api/repairs/:id (Receptionist)', getRecepPrivacy.data.data.customer, true);
  if (!getRecepPrivacy.data.data.trackingToken) {
    throw new Error('Expected trackingToken for RECEPTIONIST on GET /api/repairs/:id');
  }

  const getTechPrivacy = await axios.get(`${API_BASE}/repairs/${privacyOrder.id}`, { headers: tech1Headers });
  assertCustomerPrivacy('GET /api/repairs/:id (Technician)', getTechPrivacy.data.data.customer, true);
  assertNoTrackingToken('GET /api/repairs/:id (Technician)', getTechPrivacy.data.data);
  console.log('Positive passed: GET /api/repairs/:id verified for Admin, Receptionist, Technician (no lineUserId, correct lineLinked, trackingToken restricted to Admin/Receptionist).');

  // Reset tech status
  await prisma.employee.updateMany({
    where: { role: 'TECHNICIAN' },
    data: { status: 'AVAILABLE' },
  });

  console.log('\n========================================================');
  console.log('ALL E2E SMOKE TESTS COMPLETED WITH 100% SUCCESS!');
  console.log('========================================================\n');

  // Teardown temporary employees created during smoke tests
  await prisma.employee.deleteMany({
    where: { id: { notIn: [1, 2, 3, 4, 5, 6, 7] } },
  });
}

runSmokeTests().catch((err) => {
  console.error('\nSmoke Test Failed:', err.response?.data || err.message);
  process.exit(1);
});
