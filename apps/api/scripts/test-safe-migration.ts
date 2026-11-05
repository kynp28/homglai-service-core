import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

// Load MYSQL_ROOT_PASSWORD from the repo-root .env (shell variables still take precedence).
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const testDbContainer = process.env.TEST_DB_CONTAINER || 'homglai-mysql-test';
const testDbUser = process.env.TEST_DB_USER || 'root';
const testDbPassword = process.env.TEST_DB_PASSWORD || process.env.MYSQL_ROOT_PASSWORD || 'root';

// Both temporary databases end with `_test` (test-safety rule) and are dropped in teardown.
const LEGACY_DB = 'homglai_migration_test';
const EMPTY_DB = 'homglai_migration_empty_test';

function runMysql(sql: string, dbName?: string): string {
  const dbArg = dbName ? `${dbName}` : '';
  const cmd = `docker exec -i -e MYSQL_PWD="${testDbPassword}" ${testDbContainer} mysql --default-character-set=utf8mb4 -u${testDbUser} ${dbArg}`;
  return execSync(cmd, { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

/** Runs SQL that is expected to fail; returns the error text (stderr) or null if it succeeded. */
function runMysqlExpectError(sql: string, dbName: string): string | null {
  try {
    runMysql(sql, dbName);
    return null;
  } catch (err: any) {
    return `${err?.stderr || ''}${err?.message || ''}`;
  }
}

function assertEq(actual: unknown, expected: unknown, msg: string): void {
  if (String(actual).trim() !== String(expected).trim()) {
    throw new Error(`ASSERTION FAILED: ${msg}\n  Expected: ${expected}\n  Actual:   ${actual}`);
  }
}

function assertGte(actual: number, expected: number, msg: string): void {
  if (actual < expected) {
    throw new Error(`ASSERTION FAILED: ${msg}\n  Expected >= ${expected}, got ${actual}`);
  }
}

function assertNotNull(actual: unknown, msg: string): void {
  if (actual === null || actual === undefined || String(actual).trim() === 'NULL' || String(actual).trim() === '') {
    throw new Error(`ASSERTION FAILED: ${msg}\n  Expected NOT NULL, got: ${actual}`);
  }
}

/** Parse a simple TSV result from mysql into rows of key-value objects. */
function parseTsv(raw: string): Record<string, string>[] {
  const lines = raw.trim().split('\n').filter(l => l.trim() !== '');
  if (lines.length < 2) return [];
  const headers = lines[0].split('\t');
  return lines.slice(1).map(line => {
    const values = line.split('\t');
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => { obj[h.trim()] = (values[i] || '').trim(); });
    return obj;
  });
}

/** Get a single scalar value from a one-row, one-column query. */
function queryScalar(sql: string, db: string): string {
  const raw = runMysql(sql, db);
  const lines = raw.trim().split('\n').filter(l => l.trim() !== '');
  return (lines[lines.length - 1] || '').trim();
}

function count(table: string, db: string): number {
  return parseInt(queryScalar(`SELECT COUNT(*) FROM \`${table}\``, db), 10);
}

function tableExists(tableName: string, db: string): boolean {
  return queryScalar(
    `SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = '${db}' AND TABLE_NAME = '${tableName}'`,
    db
  ) === '1';
}

function columnExists(table: string, column: string, db: string): boolean {
  return queryScalar(
    `SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = '${db}' AND TABLE_NAME = '${table}' AND COLUMN_NAME = '${column}'`,
    db
  ) === '1';
}

// ========================================================================
// Ordered migration list — every existing + new migration must be here.
// If a developer adds a migration and forgets to update this list, the
// script throws before touching any database.
// ========================================================================
const EXPECTED_MIGRATIONS: { dir: string; label: string }[] = [
  { dir: '20261104091124_init_line_and_queue',                label: 'Initial schema' },
  { dir: '20261104121100_add_auth_and_tracking_token',        label: 'Auth & trackingToken (3-step)' },
  { dir: '20261104130000_optional_status_log_changed_by',     label: 'Optional StatusLog.changedById' },
  { dir: '20261105140000_srs_v2_schema_additions',            label: 'SRS v2 schema additions (3-step)' },
  { dir: '20261105170000_repair_order_helpers',                label: 'RepairOrderHelper table (additive)' },
];

const migrationsRoot = path.resolve(__dirname, '../../../packages/db/prisma/migrations');

function readMigration(index: number): string {
  return fs.readFileSync(path.join(migrationsRoot, EXPECTED_MIGRATIONS[index].dir, 'migration.sql'), 'utf8');
}

function applyMigration(index: number, db: string): void {
  console.log(`  -> Applying migration ${index + 1} (${EXPECTED_MIGRATIONS[index].label}) on "${db}"...`);
  runMysql(readMigration(index), db);
}

/**
 * Snapshot of every pre-existing (legacy) column of every legacy table, taken right before the
 * SRS v2 migration. After the migration the same query must return byte-identical output,
 * proving that the migration did not alter any existing value (not just row counts).
 */
const LEGACY_SNAPSHOT_QUERIES: Record<string, string> = {
  Employee:
    'SELECT `id`, `username`, `passwordHash`, `name`, `role`, `status`, `isActive`, IFNULL(`lineUserId`, \'NULL\') AS lineUserId, `createdAt`, `updatedAt` FROM `Employee` ORDER BY `id`',
  Customer:
    'SELECT `id`, `name`, `phone`, IFNULL(`lineUserId`, \'NULL\') AS lineUserId, `createdAt`, `updatedAt` FROM `Customer` ORDER BY `id`',
  SymptomCategory: 'SELECT `id`, `name` FROM `SymptomCategory` ORDER BY `id`',
  Symptom: 'SELECT `id`, `name`, `categoryId` FROM `Symptom` ORDER BY `id`',
  Machine:
    'SELECT `id`, `brand`, `model`, IFNULL(`serialNumber`, \'NULL\') AS serialNumber, `customerId`, `createdAt`, `updatedAt` FROM `Machine` ORDER BY `id`',
  RepairOrder:
    'SELECT `id`, `jobNumber`, `trackingToken`, `status`, `customerId`, `machineId`, IFNULL(`technicianId`, \'NULL\') AS technicianId, IFNULL(`otherSymptom`, \'NULL\') AS otherSymptom, `createdAt`, `updatedAt` FROM `RepairOrder` ORDER BY `id`',
  RepairOrderSymptom: 'SELECT `repairOrderId`, `symptomId` FROM `RepairOrderSymptom` ORDER BY `repairOrderId`, `symptomId`',
  RepairItem:
    'SELECT `id`, `repairOrderId`, `name`, `price`, `status`, `createdAt`, `updatedAt` FROM `RepairItem` ORDER BY `id`',
  StatusLog:
    'SELECT `id`, `repairOrderId`, `status`, IFNULL(`changedById`, \'NULL\') AS changedById, IFNULL(`note`, \'NULL\') AS note, `createdAt` FROM `StatusLog` ORDER BY `id`',
};

function takeSnapshot(db: string): Record<string, string> {
  const snap: Record<string, string> = {};
  for (const [table, sql] of Object.entries(LEGACY_SNAPSHOT_QUERIES)) {
    snap[table] = runMysql(sql, db);
  }
  return snap;
}

// ========================================================================
// Scenario A: all migrations on an EMPTY database
// ========================================================================
function runEmptyDatabaseScenario(): void {
  console.log(`[Scenario A] Applying ALL migrations to an EMPTY database "${EMPTY_DB}"...`);
  runMysql(`DROP DATABASE IF EXISTS \`${EMPTY_DB}\`; CREATE DATABASE \`${EMPTY_DB}\`;`);

  for (let i = 0; i < EXPECTED_MIGRATIONS.length; i++) {
    applyMigration(i, EMPTY_DB);
  }

  for (const t of ['RepairOrderImage', 'OrderLineSubscription', 'Notification', 'RepairOrderHelper']) {
    if (!tableExists(t, EMPTY_DB)) throw new Error(`ASSERTION FAILED: [Empty DB] table ${t} must exist`);
  }
  const receivedDateNullable = queryScalar(
    `SELECT IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = '${EMPTY_DB}' AND TABLE_NAME = 'RepairOrder' AND COLUMN_NAME = 'receivedDate'`,
    EMPTY_DB
  );
  assertEq(receivedDateNullable, 'NO', '[Empty DB] RepairOrder.receivedDate must be NOT NULL');
  assertEq(count('RepairOrder', EMPTY_DB), 0, '[Empty DB] RepairOrder must be empty');
  console.log('  [PASS] All migrations apply cleanly on an empty database.\n');
}

// ========================================================================
// Scenario B: legacy data (>= 5 rows per table) then the SRS v2 migration
// ========================================================================
function runLegacyDataScenario(): void {
  console.log(`[Scenario B] Legacy data migration on "${LEGACY_DB}"...`);
  runMysql(`DROP DATABASE IF EXISTS \`${LEGACY_DB}\`; CREATE DATABASE \`${LEGACY_DB}\`;`);

  // -------------------------------------------------------------------
  // Step 1: Apply Migration 1 (initial schema)
  // -------------------------------------------------------------------
  console.log('[Step 1] Initial legacy schema');
  applyMigration(0, LEGACY_DB);

  // -------------------------------------------------------------------
  // Step 2: Insert >= 5 rows into EVERY legacy table (initial schema shape)
  //   - 6 Employees (5 AVAILABLE + 1 OFFLINE)
  //   - 5 Customers (all LINE-linked)
  //   - 5 SymptomCategory, 5 Symptom, 6 RepairOrderSymptom
  //   - 5 Machines
  //   - 9 RepairOrders: every status, plus UTC/Bangkok midnight edge cases
  //   - 7 RepairItems with known prices
  //   - StatusLog entries (changedById is NOT NULL in the initial schema)
  // -------------------------------------------------------------------
  console.log('[Step 2] Inserting legacy data into every table...');

  const seedSql = `
-- 6 Employees: 5 AVAILABLE + 1 OFFLINE
INSERT INTO \`Employee\` (\`id\`, \`name\`, \`role\`, \`status\`, \`createdAt\`, \`updatedAt\`)
VALUES
  (1, 'Tech Alpha',  'TECHNICIAN',  'AVAILABLE', '2026-10-01 10:00:00.000', '2026-10-15 08:00:00.000'),
  (2, 'Tech Beta',   'TECHNICIAN',  'AVAILABLE', '2026-10-01 10:00:00.000', '2026-10-20 09:30:00.000'),
  (3, 'Tech Gamma',  'TECHNICIAN',  'AVAILABLE', '2026-10-01 10:00:00.000', '2026-10-18 07:00:00.000'),
  (4, 'Tech Delta',  'TECHNICIAN',  'OFFLINE',   '2026-10-01 10:00:00.000', '2026-10-25 14:00:00.000'),
  (5, 'Admin One',   'ADMIN',       'AVAILABLE', '2026-10-01 10:00:00.000', '2026-10-28 12:00:00.000'),
  (6, 'Recep One',   'RECEPTIONIST','AVAILABLE', '2026-10-01 10:00:00.000', '2026-10-29 11:00:00.000');

-- 5 Customers, all already linked to LINE
INSERT INTO \`Customer\` (\`id\`, \`name\`, \`phone\`, \`lineUserId\`, \`createdAt\`, \`updatedAt\`)
VALUES
  (1, 'Cust A', '0891110001', 'U_line_a', '2026-10-01 01:00:00.000', '2026-10-01 01:00:00.000'),
  (2, 'Cust B', '0891110002', 'U_line_b', '2026-10-01 01:00:00.000', '2026-10-01 01:00:00.000'),
  (3, 'Cust C', '0891110003', 'U_line_c', '2026-10-01 01:00:00.000', '2026-10-01 01:00:00.000'),
  (4, 'Cust D', '0891110004', 'U_line_d', '2026-10-01 01:00:00.000', '2026-10-01 01:00:00.000'),
  (5, 'Cust E', '0891110005', 'U_line_e', '2026-10-01 01:00:00.000', '2026-10-01 01:00:00.000');

-- Master data: 5 categories, 5 symptoms
INSERT INTO \`SymptomCategory\` (\`id\`, \`name\`)
VALUES (1, 'Water'), (2, 'Heat'), (3, 'Electrical'), (4, 'Steam'), (5, 'Grinder');

INSERT INTO \`Symptom\` (\`id\`, \`name\`, \`categoryId\`)
VALUES (1, 'Leaking', 1), (2, 'Not heating', 2), (3, 'No power', 3), (4, 'Weak steam', 4), (5, 'Jammed', 5);

-- 5 Machines
INSERT INTO \`Machine\` (\`id\`, \`brand\`, \`model\`, \`serialNumber\`, \`customerId\`, \`createdAt\`, \`updatedAt\`)
VALUES
  (1, 'La Marzocco', 'Linea Mini',   'LM-001', 1, '2026-10-01 01:00:00.000', '2026-10-01 01:00:00.000'),
  (2, 'Breville',    'Barista Pro',  NULL,     2, '2026-10-01 01:00:00.000', '2026-10-01 01:00:00.000'),
  (3, 'Rocket',      'Appartamento', 'RK-003', 3, '2026-10-01 01:00:00.000', '2026-10-01 01:00:00.000'),
  (4, 'Lelit',       'Bianca',       NULL,     4, '2026-10-01 01:00:00.000', '2026-10-01 01:00:00.000'),
  (5, 'GEF',         'Aa+',          'GEF-05', 5, '2026-10-01 01:00:00.000', '2026-10-01 01:00:00.000');

-- 9 RepairOrders covering every status
-- Order 5: createdAt 2026-11-01 23:30:00 UTC  => Bangkok 2026-11-02 06:30 => receivedDate 2026-11-02
-- Order 8: createdAt 2026-10-31 16:59:59 UTC  => Bangkok 2026-10-31 23:59:59 => receivedDate 2026-10-31
-- Order 9: createdAt 2026-10-31 17:00:00 UTC  => Bangkok 2026-11-01 00:00:00 => receivedDate 2026-11-01
-- Order 7: CANCELLED without ever being inspected (no INSPECTING log) => assignedAt falls back to updatedAt
INSERT INTO \`RepairOrder\` (\`id\`, \`jobNumber\`, \`status\`, \`customerId\`, \`machineId\`, \`technicianId\`, \`otherSymptom\`, \`createdAt\`, \`updatedAt\`)
VALUES
  (1, 'REP-MIG-0001', 'NEW',              1, 1, NULL, NULL,          '2026-10-10 03:00:00.000', '2026-10-10 03:00:00.000'),
  (2, 'REP-MIG-0002', 'INSPECTING',       2, 2, 1,    'Odd noise',   '2026-10-11 05:00:00.000', '2026-10-12 08:00:00.000'),
  (3, 'REP-MIG-0003', 'WAITING_APPROVAL', 3, 3, 2,    NULL,          '2026-10-12 06:00:00.000', '2026-10-14 09:00:00.000'),
  (4, 'REP-MIG-0004', 'REPAIRING',        4, 4, 3,    NULL,          '2026-10-13 02:00:00.000', '2026-10-16 10:00:00.000'),
  (5, 'REP-MIG-0005', 'NEW',              5, 5, NULL, NULL,          '2026-11-01 23:30:00.000', '2026-11-01 23:30:00.000'),
  (6, 'REP-MIG-0006', 'DELIVERED',        1, 1, 1,    NULL,          '2026-10-05 04:00:00.000', '2026-10-20 13:00:00.000'),
  (7, 'REP-MIG-0007', 'CANCELLED',        2, 2, NULL, NULL,          '2026-10-06 01:00:00.000', '2026-10-08 07:00:00.000'),
  (8, 'REP-MIG-0008', 'COMPLETED',        3, 3, 2,    NULL,          '2026-10-31 16:59:59.000', '2026-11-03 09:00:00.000'),
  (9, 'REP-MIG-0009', 'NEW',              4, 4, NULL, 'Thai: น้ำรั่ว', '2026-10-31 17:00:00.000', '2026-10-31 17:00:00.000');

-- Symptom links (many-to-many)
INSERT INTO \`RepairOrderSymptom\` (\`repairOrderId\`, \`symptomId\`)
VALUES (1, 1), (2, 2), (3, 3), (4, 4), (5, 5), (5, 1);

-- 7 RepairItems with known prices
INSERT INTO \`RepairItem\` (\`id\`, \`repairOrderId\`, \`name\`, \`price\`, \`status\`, \`createdAt\`, \`updatedAt\`)
VALUES
  (1, 1, 'Group Head Gasket',    150.00, 'PENDING',   '2026-10-10 04:00:00.000', '2026-10-10 04:00:00.000'),
  (2, 1, 'Descale Service',      300.00, 'PENDING',   '2026-10-10 04:00:00.000', '2026-10-10 04:00:00.000'),
  (3, 2, 'Boiler Element',      1200.00, 'APPROVED',  '2026-10-11 07:00:00.000', '2026-10-11 07:00:00.000'),
  (4, 3, 'Solenoid Valve',       850.00, 'PENDING',   '2026-10-13 07:00:00.000', '2026-10-13 07:00:00.000'),
  (5, 4, 'Brew Thermostat',      650.00, 'COMPLETED', '2026-10-14 07:00:00.000', '2026-10-16 10:00:00.000'),
  (6, 6, 'Full Service Kit',    2500.00, 'COMPLETED', '2026-10-06 07:00:00.000', '2026-10-18 06:00:00.000'),
  (7, 8, 'Steam Valve',           99.99, 'REJECTED',  '2026-11-01 07:00:00.000', '2026-11-01 08:00:00.000');

-- StatusLog (changedById is NOT NULL in the initial schema, so every row has an actor)
INSERT INTO \`StatusLog\` (\`repairOrderId\`, \`status\`, \`changedById\`, \`note\`, \`createdAt\`)
VALUES
  (2, 'INSPECTING',       1, 'Starting inspection',   '2026-10-11 06:00:00.000'),
  (3, 'INSPECTING',       2, 'Starting inspection',   '2026-10-12 07:00:00.000'),
  (3, 'WAITING_APPROVAL', 2, 'Need approval',         '2026-10-13 08:00:00.000'),
  (4, 'INSPECTING',       3, 'Starting inspection',   '2026-10-13 03:00:00.000'),
  (4, 'REPAIRING',        3, 'Parts arrived',         '2026-10-15 04:00:00.000'),
  (6, 'INSPECTING',       1, 'Starting inspection',   '2026-10-05 05:00:00.000'),
  (6, 'COMPLETED',        1, 'Done',                  '2026-10-18 06:00:00.000'),
  (6, 'DELIVERED',        5, 'Delivered to customer', '2026-10-20 13:00:00.000'),
  (7, 'CANCELLED',        5, 'Customer cancelled',    '2026-10-08 07:00:00.000'),
  (8, 'INSPECTING',       2, 'Starting inspection',   '2026-11-01 02:00:00.000'),
  (8, 'INSPECTING',       2, 'Re-inspection',         '2026-11-02 02:00:00.000'),
  (8, 'COMPLETED',        2, 'Done',                  '2026-11-03 09:00:00.000');
`;
  runMysql(seedSql, LEGACY_DB);

  const legacyTables = Object.keys(LEGACY_SNAPSHOT_QUERIES);
  const preCounts: Record<string, number> = {};
  for (const t of legacyTables) {
    preCounts[t] = count(t, LEGACY_DB);
    // SymptomCategory/Symptom are master data; every table has >= 5 rows by construction.
    assertGte(preCounts[t], 5, `Pre-migration: ${t} >= 5 rows`);
  }
  console.log(`  Pre-migration counts: ${legacyTables.map(t => `${t}=${preCounts[t]}`).join(', ')}\n`);

  // -------------------------------------------------------------------
  // Step 3: Apply Migrations 2 and 3 (already in production before Phase 1)
  // -------------------------------------------------------------------
  console.log('[Step 3] Pre-Phase-1 migrations');
  applyMigration(1, LEGACY_DB);
  applyMigration(2, LEGACY_DB);

  // Snapshot every legacy value right before the migration under test.
  const before = takeSnapshot(LEGACY_DB);

  // -------------------------------------------------------------------
  // Step 4: Apply Migration 4 (SRS v2 — the target of this test)
  // -------------------------------------------------------------------
  console.log('[Step 4] SRS v2 migration (target of this test) + later additive migrations');
  applyMigration(3, LEGACY_DB);
  for (let i = 4; i < EXPECTED_MIGRATIONS.length; i++) {
    applyMigration(i, LEGACY_DB);
  }
  console.log('');

  // -------------------------------------------------------------------
  // Step 5: Assertions
  // -------------------------------------------------------------------
  console.log('[Step 5] Running assertions...\n');

  // --- 5a: Row counts did not decrease ---
  for (const t of legacyTables) {
    assertEq(count(t, LEGACY_DB), preCounts[t], `${t} row count unchanged after migration`);
  }
  console.log('  [PASS] Row counts unchanged for every legacy table.');

  // --- 5b: Every legacy value is byte-identical (nothing overwritten) ---
  const after = takeSnapshot(LEGACY_DB);
  for (const t of legacyTables) {
    if (before[t] !== after[t]) {
      throw new Error(
        `ASSERTION FAILED: legacy data in ${t} changed during the SRS v2 migration\n--- before ---\n${before[t]}\n--- after ---\n${after[t]}`
      );
    }
  }
  console.log('  [PASS] All legacy column values identical before/after (incl. updatedAt, trackingToken, passwords).');

  // --- 5c: LINE-linked customers stay linked (lineUserId kept until Phase 6) ---
  const linked = queryScalar("SELECT COUNT(*) FROM `Customer` WHERE `lineUserId` IS NOT NULL", LEGACY_DB);
  assertEq(linked, '5', 'All 5 LINE-linked customers keep their lineUserId');
  console.log('  [PASS] Customer.lineUserId preserved for all LINE-linked customers.');

  // --- 5d: unitPrice = legacy price (same column, mapped), quantity = 1 ---
  if (!columnExists('RepairItem', 'price', LEGACY_DB)) {
    throw new Error('ASSERTION FAILED: RepairItem.price column must still exist (unitPrice is @map("price"))');
  }
  if (columnExists('RepairItem', 'unitPrice', LEGACY_DB)) {
    throw new Error('ASSERTION FAILED: RepairItem.unitPrice column must NOT exist physically (drop/add is forbidden)');
  }
  const items = parseTsv(runMysql(
    'SELECT `id`, `price`, `quantity`, `itemType`, IFNULL(`resolvedById`, \'NULL\') AS resolvedById, IFNULL(`resolutionChannel`, \'NULL\') AS resolutionChannel FROM `RepairItem` ORDER BY `id`',
    LEGACY_DB
  ));
  const expectedPrices: Record<string, string> = {
    '1': '150.00', '2': '300.00', '3': '1200.00', '4': '850.00',
    '5': '650.00', '6': '2500.00', '7': '99.99',
  };
  assertEq(items.length, Object.keys(expectedPrices).length, 'RepairItem rows present');
  for (const item of items) {
    assertEq(item.price, expectedPrices[item.id], `RepairItem ${item.id}: unitPrice (column price) equals legacy price`);
    assertEq(item.quantity, '1', `RepairItem ${item.id}: quantity = 1`);
    assertEq(item.itemType, 'PART', `RepairItem ${item.id}: itemType defaults to PART`);
    assertEq(item.resolvedById, 'NULL', `RepairItem ${item.id}: resolvedById NULL for legacy rows`);
    assertEq(item.resolutionChannel, 'NULL', `RepairItem ${item.id}: resolutionChannel NULL for legacy rows`);
  }
  console.log('  [PASS] unitPrice = legacy price, quantity = 1, itemType = PART for every legacy item.');

  // --- 5e: receivedDate uses the Bangkok calendar date, incl. around UTC/Thai midnight ---
  const expectedReceived: Record<string, string> = {
    '1': '2026-10-10', // 03:00 UTC -> 10:00 Bangkok
    '5': '2026-11-02', // 23:30 UTC -> next day 06:30 Bangkok
    '8': '2026-10-31', // 16:59:59 UTC -> 23:59:59 Bangkok (same day)
    '9': '2026-11-01', // 17:00:00 UTC -> 00:00:00 Bangkok (next day)
  };
  for (const [id, date] of Object.entries(expectedReceived)) {
    assertEq(
      queryScalar(`SELECT \`receivedDate\` FROM \`RepairOrder\` WHERE \`id\` = ${id}`, LEGACY_DB),
      date,
      `Order ${id}: receivedDate (Bangkok date)`
    );
  }
  assertEq(
    queryScalar('SELECT COUNT(*) FROM `RepairOrder` WHERE `receivedDate` IS NULL', LEGACY_DB),
    '0',
    'No order has NULL receivedDate'
  );
  assertEq(
    queryScalar(
      `SELECT IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = '${LEGACY_DB}' AND TABLE_NAME = 'RepairOrder' AND COLUMN_NAME = 'receivedDate'`,
      LEGACY_DB
    ),
    'NO',
    'RepairOrder.receivedDate is NOT NULL (step 3 of safe migration)'
  );
  console.log('  [PASS] receivedDate = Bangkok date (incl. 23:30 UTC, 16:59:59 UTC, 17:00:00 UTC edge cases); NOT NULL enforced.');

  // --- 5f: Non-NEW orders have assignedAt = acknowledgedAt (first INSPECTING log, fallback updatedAt) ---
  const nonNew = parseTsv(runMysql(
    "SELECT `id`, `status`, IFNULL(`assignedAt`, 'NULL') AS assignedAt, IFNULL(`acknowledgedAt`, 'NULL') AS acknowledgedAt FROM `RepairOrder` WHERE `status` <> 'NEW' ORDER BY `id`",
    LEGACY_DB
  ));
  assertEq(nonNew.length, 6, 'Six non-NEW legacy orders');
  for (const o of nonNew) {
    assertNotNull(o.assignedAt, `Order ${o.id} (${o.status}): assignedAt`);
    assertNotNull(o.acknowledgedAt, `Order ${o.id} (${o.status}): acknowledgedAt`);
    assertEq(o.acknowledgedAt, o.assignedAt, `Order ${o.id}: acknowledgedAt = assignedAt`);
  }
  const expectedAssigned: Record<string, string> = {
    '2': '2026-10-11 06:00:00.000', // first INSPECTING log
    '4': '2026-10-13 03:00:00.000', // first INSPECTING log (ignores later REPAIRING)
    '7': '2026-10-08 07:00:00.000', // no INSPECTING log -> updatedAt
    '8': '2026-11-01 02:00:00.000', // earliest of two INSPECTING logs
  };
  for (const [id, ts] of Object.entries(expectedAssigned)) {
    assertEq(
      queryScalar(`SELECT \`assignedAt\` FROM \`RepairOrder\` WHERE \`id\` = ${id}`, LEGACY_DB),
      ts,
      `Order ${id}: assignedAt`
    );
  }
  const newOrders = parseTsv(runMysql(
    "SELECT `id`, IFNULL(`assignedAt`, 'NULL') AS assignedAt, IFNULL(`acknowledgedAt`, 'NULL') AS acknowledgedAt FROM `RepairOrder` WHERE `status` = 'NEW' ORDER BY `id`",
    LEGACY_DB
  ));
  for (const o of newOrders) {
    assertEq(o.assignedAt, 'NULL', `NEW Order ${o.id}: assignedAt stays NULL`);
    assertEq(o.acknowledgedAt, 'NULL', `NEW Order ${o.id}: acknowledgedAt stays NULL`);
  }
  console.log('  [PASS] Non-NEW orders: assignedAt = acknowledgedAt = first INSPECTING log (fallback updatedAt); NEW orders untouched.');

  // --- 5g: closedAt only for DELIVERED/CANCELLED, = updatedAt ---
  assertEq(
    queryScalar("SELECT COUNT(*) FROM `RepairOrder` WHERE `status` IN ('DELIVERED','CANCELLED') AND (`closedAt` IS NULL OR `closedAt` <> `updatedAt`)", LEGACY_DB),
    '0',
    'Closed orders: closedAt = updatedAt'
  );
  assertEq(
    queryScalar("SELECT COUNT(*) FROM `RepairOrder` WHERE `status` NOT IN ('DELIVERED','CANCELLED') AND `closedAt` IS NOT NULL", LEGACY_DB),
    '0',
    'Open orders (incl. COMPLETED) have NULL closedAt'
  );
  console.log('  [PASS] DELIVERED/CANCELLED have closedAt = updatedAt; open/COMPLETED orders do not.');

  // --- 5h: availableSince = updatedAt for AVAILABLE employees (queue order unchanged), NULL otherwise ---
  assertEq(
    queryScalar("SELECT COUNT(*) FROM `Employee` WHERE `status` = 'AVAILABLE' AND (`availableSince` IS NULL OR `availableSince` <> `updatedAt`)", LEGACY_DB),
    '0',
    'AVAILABLE employees: availableSince = updatedAt'
  );
  assertEq(
    queryScalar("SELECT IFNULL(`availableSince`, 'NULL') FROM `Employee` WHERE `id` = 4", LEGACY_DB),
    'NULL',
    'OFFLINE employee: availableSince stays NULL'
  );
  const queueOld = runMysql("SELECT `id` FROM `Employee` WHERE `status`='AVAILABLE' AND `role`='TECHNICIAN' ORDER BY `updatedAt`, `id`", LEGACY_DB);
  const queueNew = runMysql("SELECT `id` FROM `Employee` WHERE `status`='AVAILABLE' AND `role`='TECHNICIAN' ORDER BY `availableSince`, `id`", LEGACY_DB);
  assertEq(queueNew.replace(/^id\s*/, ''), queueOld.replace(/^id\s*/, ''), 'Technician queue order by availableSince equals legacy order by updatedAt');
  console.log('  [PASS] availableSince = updatedAt for AVAILABLE employees; technician queue order unchanged.');

  // --- 5i: lastActivityAt = updatedAt; counters/priority default ---
  assertEq(
    queryScalar('SELECT COUNT(*) FROM `RepairOrder` WHERE `lastActivityAt` IS NULL OR `lastActivityAt` <> `updatedAt`', LEGACY_DB),
    '0',
    'lastActivityAt = updatedAt for every order'
  );
  assertEq(
    queryScalar("SELECT COUNT(*) FROM `RepairOrder` WHERE `queuePriority` <> 0 OR `ackReminderCount` <> 0 OR `progressReminderCount` <> 0 OR `workType` <> 'REPAIR' OR `loanerMachine` <> 0", LEGACY_DB),
    '0',
    'queuePriority/ackReminderCount/progressReminderCount = 0, workType = REPAIR, loanerMachine = false'
  );
  console.log('  [PASS] lastActivityAt = updatedAt; queuePriority & reminder counters = 0; workType = REPAIR.');

  // --- 5j: New tables exist and are empty ---
  for (const t of ['RepairOrderImage', 'OrderLineSubscription', 'Notification', 'RepairOrderHelper']) {
    if (!tableExists(t, LEGACY_DB)) throw new Error(`ASSERTION FAILED: table ${t} must exist`);
    assertEq(count(t, LEGACY_DB), 0, `${t} starts empty`);
  }
  console.log('  [PASS] New tables exist and are empty: RepairOrderImage, OrderLineSubscription, Notification, RepairOrderHelper.');

  // --- 5k: New enum value RESERVED accepted ---
  runMysql("UPDATE `Employee` SET `status` = 'RESERVED' WHERE `id` = 3; UPDATE `Employee` SET `status` = 'AVAILABLE' WHERE `id` = 3;", LEGACY_DB);
  console.log('  [PASS] EmployeeStatus accepts RESERVED.');

  // --- 5l: Unique index on paperReceiptNo rejects duplicates (and only for that reason) ---
  runMysql(
    `INSERT INTO \`RepairOrder\` (\`jobNumber\`, \`trackingToken\`, \`status\`, \`customerId\`, \`machineId\`, \`receivedDate\`, \`paperReceiptNo\`, \`updatedAt\`)
     VALUES ('REP-UNIQ-01', 'tok_uniq_1', 'NEW', 1, 1, '2026-11-03', '5595', NOW(3)),
            ('REP-UNIQ-02', 'tok_uniq_2', 'NEW', 1, 1, '2026-11-03', NULL,   NOW(3)),
            ('REP-UNIQ-03', 'tok_uniq_3', 'NEW', 1, 1, '2026-11-03', NULL,   NOW(3));`,
    LEGACY_DB
  ); // multiple NULLs must be allowed
  const dupErr = runMysqlExpectError(
    `INSERT INTO \`RepairOrder\` (\`jobNumber\`, \`trackingToken\`, \`status\`, \`customerId\`, \`machineId\`, \`receivedDate\`, \`paperReceiptNo\`, \`updatedAt\`)
     VALUES ('REP-UNIQ-04', 'tok_uniq_4', 'NEW', 1, 1, '2026-11-03', '5595', NOW(3));`,
    LEGACY_DB
  );
  if (!dupErr || !/Duplicate entry/i.test(dupErr) || !/paperReceiptNo/.test(dupErr)) {
    throw new Error(`ASSERTION FAILED: duplicate paperReceiptNo must fail on RepairOrder_paperReceiptNo_key. Got: ${dupErr}`);
  }
  console.log('  [PASS] paperReceiptNo unique (duplicate rejected by RepairOrder_paperReceiptNo_key; multiple NULLs allowed).');

  // --- 5m: Required indexes exist ---
  const requiredIndexes = [
    'RepairOrder_status_technicianId_idx',
    'RepairOrder_status_acknowledgedAt_idx',
    'RepairOrder_closedAt_idx',
    'RepairOrder_lastActivityAt_idx',
    'RepairOrder_status_technicianId_queuePriority_createdAt_idx',
    'RepairOrderImage_repairOrderId_kind_idx',
    'OrderLineSubscription_lineUserId_idx',
    'Notification_recipientId_readAt_createdAt_idx',
    'RepairOrderHelper_repairOrderId_technicianId_key',
    'RepairOrderHelper_technicianId_idx',
  ];
  for (const idx of requiredIndexes) {
    const n = queryScalar(
      `SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = '${LEGACY_DB}' AND INDEX_NAME = '${idx}'`,
      LEGACY_DB
    );
    if (parseInt(n, 10) < 1) throw new Error(`ASSERTION FAILED: index ${idx} must exist`);
  }
  console.log(`  [PASS] All ${requiredIndexes.length} required indexes exist.`);

  console.log('\n[Step 5] All 13 assertion groups passed!\n');
}

function runSafeMigrationTest() {
  console.log('=================================================================');
  console.log('STARTING SAFE MIGRATION TEST (empty DB + legacy data >= 5 rows)');
  console.log('=================================================================\n');

  for (const mig of EXPECTED_MIGRATIONS) {
    const migPath = path.join(migrationsRoot, mig.dir, 'migration.sql');
    if (!fs.existsSync(migPath)) {
      throw new Error(`Migration file not found: ${migPath}`);
    }
  }
  const onDisk = fs.readdirSync(migrationsRoot, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort();
  const listed = EXPECTED_MIGRATIONS.map(m => m.dir).sort();
  if (JSON.stringify(onDisk) !== JSON.stringify(listed)) {
    throw new Error(
      `Migration list out of date. On disk: ${onDisk.join(', ')}\nListed in test: ${listed.join(', ')}`
    );
  }
  console.log(`[Pre-check] All ${EXPECTED_MIGRATIONS.length} migration files verified on disk (list matches exactly).\n`);

  try {
    runEmptyDatabaseScenario();
    runLegacyDataScenario();
  } finally {
    console.log('[Teardown] Dropping temporary databases...');
    runMysql(`DROP DATABASE IF EXISTS \`${LEGACY_DB}\`; DROP DATABASE IF EXISTS \`${EMPTY_DB}\`;`);
    console.log(`Cleaned up "${LEGACY_DB}" and "${EMPTY_DB}".`);
  }

  console.log('=================================================================');
  console.log('SAFE MIGRATION TEST COMPLETED SUCCESSFULLY! ALL CHECKS PASSED.');
  console.log('=================================================================\n');
}

runSafeMigrationTest();
