import axios from 'axios';
import crypto from 'crypto';
import prisma from '@homglai/db';
import { assertSafeDatabaseUrl } from '../src/utils/test-safety';
import { getBangkokDateOnly } from '../src/utils/date';

const API_BASE = 'http://localhost:4000/api';

async function main() {
  assertSafeDatabaseUrl();

  console.log('==================================================================');
  console.log('STARTING CONCURRENCY, QUEUE CONTENTION & RACE TEST SUITE');
  console.log('==================================================================\n');

  // Step 0: Login as Admin to get auth tokens
  console.log('[Step 0] Logging in as Admin...');
  const loginRes = await axios.post(`${API_BASE}/auth/login`, {
    username: 'admin',
    password: process.env.SEED_DEFAULT_PASSWORD || 'SecretPassword123!',
  });
  const adminToken = loginRes.data.data.token;
  const authHeaders = { Authorization: `Bearer ${adminToken}` };
  console.log('Admin login successful.\n');

  // Reset transactional test data for strict test isolation
  await prisma.statusLog.deleteMany({});
  await prisma.repairItem.deleteMany({});
  await prisma.repairOrderSymptom.deleteMany({});
  await prisma.repairOrder.deleteMany({});
  await prisma.machine.deleteMany({});
  await prisma.customer.deleteMany({});
  // Phase 3+: notifications reference employees
  await prisma.notification.deleteMany({});

  // Clean up any extra employees created during other tests
  await prisma.employee.deleteMany({
    where: { id: { notIn: [1, 2, 3, 4, 5, 6, 7] } },
  });

  // Ensure all 5 technicians (id 3 to 7) are reset to AVAILABLE and active
  await prisma.employee.updateMany({
    where: { id: { in: [3, 4, 5, 6, 7] } },
    data: { status: 'AVAILABLE', isActive: true },
  });

  // -------------------------------------------------------------------------
  // Test 1: High-Concurrency Intake (20 simultaneous repair orders)
  // -------------------------------------------------------------------------
  console.log('[Test 1] Executing 20 simultaneous repair order intake requests...');
  const intakePromises = Array.from({ length: 20 }).map((_, i) => {
    return axios
      .post(
        `${API_BASE}/repairs`,
        {
          customer: { name: `Customer Concurrent ${i}`, phone: `081000${String(i).padStart(4, '0')}` },
          machine: { brand: 'La Marzocco', model: 'Linea Mini', serialNumber: `SN-CONCUR-${i}` },
          symptomIds: [1],
          otherSymptom: `Concurrent stress test batch ${i}`,
        },
        { headers: authHeaders }
      )
      .then((res) => ({ success: true, jobNumber: res.data.data.jobNumber, id: res.data.data.id }))
      .catch((err) => ({ success: false, error: err.response?.data?.message || err.message }));
  });

  const intakeResults = await Promise.all(intakePromises);
  const intakeSuccesses = intakeResults.filter((r) => r.success);
  const intakeFailures = intakeResults.filter((r) => !r.success);

  console.log(`Intake Results: ${intakeSuccesses.length}/20 succeeded, ${intakeFailures.length} failed.`);
  if (intakeFailures.length > 0) {
    console.error('Intake failures detail:', intakeFailures);
  }

  // Verify unique job numbers
  const jobNumbers = intakeSuccesses.map((r: any) => r.jobNumber);
  const uniqueJobNumbers = new Set(jobNumbers);
  if (uniqueJobNumbers.size !== jobNumbers.length) {
    throw new Error(`Duplicate job numbers detected! Set size: ${uniqueJobNumbers.size}, total: ${jobNumbers.length}`);
  }
  console.log(`All ${uniqueJobNumbers.size} generated job numbers are strictly unique.`);

  const createdOrderIds = intakeSuccesses.map((r: any) => r.id);
  // Phase 4 (SRS 3.3): assignment reserves the job (status stays NEW, technicianId set) until accepted
  const inspectingOrders = await prisma.repairOrder.findMany({
    where: { id: { in: createdOrderIds }, status: 'NEW', technicianId: { not: null } },
    select: { id: true, technicianId: true },
  });

  console.log(`Initial reserved orders (NEW + technician): ${inspectingOrders.length} (Expected: 5)`);
  if (inspectingOrders.length !== 5) {
    throw new Error(`Expected exactly 5 orders assigned to 5 available technicians, got: ${inspectingOrders.length}`);
  }

  const assignedTechIds = inspectingOrders.map((o) => o.technicianId).filter(Boolean);
  const uniqueAssignedTechIds = new Set(assignedTechIds);

  if (assignedTechIds.length !== uniqueAssignedTechIds.size) {
    throw new Error(`Collision detected: multiple orders assigned to the same technician! IDs: ${assignedTechIds.join(', ')}`);
  }
  console.log(`No duplicate technician assignments: Exactly 5 unique technicians assigned to 5 orders.`);

  // -------------------------------------------------------------------------
  // Test 2: G.1 20-Round Queue Contention Test (N Techs AVAILABLE simultaneously vs M Orders)
  // -------------------------------------------------------------------------
  console.log('\n[Test 2: G.1] Running 20 Rounds of N Technicians vs M Orders Queue Contention...');
  const techIds = [3, 4, 5, 6, 7]; // N = 5 technicians
  const N = techIds.length;

  const contentionCustomer = await prisma.customer.create({
    data: { name: 'Contention Test Customer', phone: `089999${Date.now().toString().slice(-4)}` },
  });
  const contentionMachine = await prisma.machine.create({
    data: {
      brand: 'La Marzocco',
      model: 'Linea Mini',
      customerId: contentionCustomer.id,
    },
  });

  for (let round = 1; round <= 20; round++) {
    // Alternate M between less than N (3) and greater than N (7)
    const M = round % 2 === 1 ? 3 : 7;
    const expected = Math.min(N, M);

    // 1. Cleanup all orders
    await prisma.statusLog.deleteMany({});
    await prisma.repairItem.deleteMany({});
    await prisma.repairOrderSymptom.deleteMany({});
    await prisma.repairOrder.deleteMany({});

    // 2. Temporarily set all technicians to BUSY so no orders are auto-assigned during creation
    await prisma.employee.updateMany({
      where: { id: { in: techIds } },
      data: { status: 'BUSY' },
    });

    // 3. Create M unassigned NEW orders
    const roundOrderIds: number[] = [];
    for (let m = 0; m < M; m++) {
      const order = await prisma.repairOrder.create({
        data: {
          jobNumber: `REP-RND${round}-${m + 1}`,
          trackingToken: crypto.randomBytes(24).toString('base64url'),
          status: 'NEW',
          receivedDate: getBangkokDateOnly(),
          customerId: contentionCustomer.id,
          machineId: contentionMachine.id,
          technicianId: null,
        },
      });
      roundOrderIds.push(order.id);
    }

    // 4. Simulate all N technicians hitting PATCH /api/employees/:id/status -> AVAILABLE simultaneously
    const statusPromises = techIds.map((id) => {
      return axios.patch(
        `${API_BASE}/employees/${id}/status`,
        { status: 'AVAILABLE' },
        { headers: authHeaders }
      );
    });

    await Promise.all(statusPromises);

    // 5. Query assigned orders
    const roundAssignedOrders = await prisma.repairOrder.findMany({
      where: { id: { in: roundOrderIds }, status: 'NEW', technicianId: { not: null } },
      select: { id: true, technicianId: true },
    });

    const roundAssignedTechs = roundAssignedOrders.map((o) => o.technicianId).filter(Boolean);
    const roundUniqueTechs = new Set(roundAssignedTechs);

    if (roundAssignedOrders.length !== expected) {
      throw new Error(
        `Round ${round} Failed: Expected ${expected} assigned orders, got ${roundAssignedOrders.length}`
      );
    }

    if (roundAssignedTechs.length !== roundUniqueTechs.size) {
      throw new Error(
        `Round ${round} Failed: Collision detected! Duplicate technician assigned: ${roundAssignedTechs.join(', ')}`
      );
    }

    process.stdout.write(
      `  Round ${round.toString().padStart(2, ' ')}/20 (N=${N}, M=${M}): Expected=${expected}, Assigned=${roundAssignedOrders.length}, UniqueTechs=${roundUniqueTechs.size} -> PASS\n`
    );
  }
  console.log('All 20 Queue Contention Rounds Passed with 100% accuracy and zero collisions!\n');

  // -------------------------------------------------------------------------
  // Test 3: Race condition on simultaneous item resolution (10 concurrent calls)
  // -------------------------------------------------------------------------
  console.log('[Test 3] Testing race condition on simultaneous item resolution...');
  const orderWithTech = await prisma.repairOrder.findFirst({
    where: { status: 'NEW', technicianId: { not: null }, acknowledgedAt: null },
  });

  if (!orderWithTech) {
    throw new Error('No reserved order found for Test 3');
  }
  // Phase 4: accept the reserved job (ADMIN on behalf of the technician) before adding items
  await axios.post(`${API_BASE}/repairs/${orderWithTech.id}/accept`, {}, { headers: authHeaders });

  const addItemRes = await axios.post(
    `${API_BASE}/repairs/${orderWithTech.id}/items`,
    { name: 'Heating Element', price: 1850 },
    { headers: authHeaders }
  );
  const itemId = addItemRes.data.data.item.id;
  console.log(`Added repair item ID: ${itemId} to order ID: ${orderWithTech.id} (status WAITING_APPROVAL)`);

  console.log('Sending 10 simultaneous approval requests on the same item ID...');
  const resolvePromises = Array.from({ length: 10 }).map((_, i) => {
    return axios
      .patch(
        `${API_BASE}/repairs/${orderWithTech.id}/items/${itemId}/status`,
        { status: i % 2 === 0 ? 'APPROVED' : 'REJECTED' },
        { headers: authHeaders }
      )
      .then((res) => ({ status: res.status, data: res.data }))
      .catch((err) => ({ status: err.response?.status, error: err.response?.data?.message || err.message }));
  });

  const resolveResults = await Promise.all(resolvePromises);
  const resolveSuccesses = resolveResults.filter((r) => r.status === 200);
  const resolveConflicts = resolveResults.filter((r) => r.status === 409);

  console.log(`Resolution Results: ${resolveSuccesses.length} succeeded (200 OK), ${resolveConflicts.length} safely rejected with 409 Conflict.`);

  if (resolveSuccesses.length !== 1) {
    throw new Error(`Race condition bug! Exactly 1 resolution should succeed, got: ${resolveSuccesses.length}`);
  }
  console.log('Concurrency test passed: Exactly one resolution won the race with zero double-approvals!');

  console.log('\n==================================================================');
  console.log('ALL CONCURRENCY & CONTENTION TESTS COMPLETED SUCCESSFULLY!');
  console.log('==================================================================');
}

main().catch((err) => {
  console.error('\nConcurrency Test Failed:', err.message);
  process.exit(1);
});
