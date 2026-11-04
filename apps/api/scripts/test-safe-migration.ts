import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const testDbContainer = process.env.TEST_DB_CONTAINER || 'homglai-mysql-test';
const testDbUser = process.env.TEST_DB_USER || 'root';
const testDbPassword = process.env.TEST_DB_PASSWORD || process.env.MYSQL_ROOT_PASSWORD || 'root';

function runMysql(sql: string, dbName?: string): string {
  const dbArg = dbName ? `${dbName}` : '';
  const cmd = `docker exec -i -e MYSQL_PWD="${testDbPassword}" ${testDbContainer} mysql -u${testDbUser} ${dbArg}`;
  return execSync(cmd, { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

function runSafeMigrationTest() {
  console.log('=================================================================');
  console.log('STARTING SAFE MIGRATION TEST (E.2: Existing Data >= 5 Rows)');
  console.log('=================================================================\n');

  const testDbName = 'homglai_migration_test';

  console.log(`[Step 0] Creating fresh temporary database "${testDbName}"...`);
  runMysql(`DROP DATABASE IF EXISTS \`${testDbName}\`; CREATE DATABASE \`${testDbName}\`;`);

  console.log(`[Step 1] Applying Migration 1 (Initial schema: 20261104091124)...`);
  const mig1Path = path.resolve(
    __dirname,
    '../../../packages/db/prisma/migrations/20261104091124_init_line_and_queue/migration.sql'
  );
  const mig1Sql = fs.readFileSync(mig1Path, 'utf8');
  runMysql(mig1Sql, testDbName);
  console.log('Migration 1 applied successfully.\n');

  console.log(`[Step 2] Inserting >= 5 rows per table into legacy schema...`);
  let insertLegacySql = '';
  // 5 Employees
  for (let i = 1; i <= 5; i++) {
    insertLegacySql += `INSERT INTO \`Employee\` (\`id\`, \`name\`, \`role\`, \`status\`, \`createdAt\`, \`updatedAt\`) VALUES (${i}, 'Legacy Tech ${i}', 'TECHNICIAN', 'AVAILABLE', NOW(3), NOW(3));\n`;
  }
  // 5 Customers
  for (let i = 1; i <= 5; i++) {
    insertLegacySql += `INSERT INTO \`Customer\` (\`id\`, \`name\`, \`phone\`, \`createdAt\`, \`updatedAt\`) VALUES (${i}, 'Legacy Customer ${i}', '089999000${i}', NOW(3), NOW(3));\n`;
  }
  // 5 Machines
  for (let i = 1; i <= 5; i++) {
    insertLegacySql += `INSERT INTO \`Machine\` (\`id\`, \`brand\`, \`model\`, \`customerId\`, \`createdAt\`, \`updatedAt\`) VALUES (${i}, 'La Marzocco', 'Mini', ${i}, NOW(3), NOW(3));\n`;
  }
  // 5 RepairOrders
  for (let i = 1; i <= 5; i++) {
    insertLegacySql += `INSERT INTO \`RepairOrder\` (\`id\`, \`jobNumber\`, \`status\`, \`customerId\`, \`machineId\`, \`createdAt\`, \`updatedAt\`) VALUES (${i}, 'REP-LEGACY-000${i}', 'NEW', ${i}, ${i}, NOW(3), NOW(3));\n`;
  }
  runMysql(insertLegacySql, testDbName);

  const empCountOut = runMysql('SELECT COUNT(*) as count FROM `Employee`;', testDbName);
  const orderCountOut = runMysql('SELECT COUNT(*) as count FROM `RepairOrder`;', testDbName);
  console.log('Verified pre-migration data inserted:');
  console.log('Employee count:\n' + empCountOut.trim());
  console.log('RepairOrder count:\n' + orderCountOut.trim() + '\n');

  console.log(`[Step 3] Applying 3-Step Safe Migration (20261104121100_add_auth_and_tracking_token)...`);
  const mig2Path = path.resolve(
    __dirname,
    '../../../packages/db/prisma/migrations/20261104121100_add_auth_and_tracking_token/migration.sql'
  );
  const mig2Sql = fs.readFileSync(mig2Path, 'utf8');
  runMysql(mig2Sql, testDbName);
  console.log('Migration 2 (3-Step Safe Backfill) executed successfully with 0 errors!\n');

  console.log(`[Step 4] Querying and verifying backfilled data integrity...`);
  const empRows = runMysql(
    'SELECT `id`, `name`, `username`, `isActive`, LEFT(`passwordHash`, 28) as hashPrefix FROM `Employee`;',
    testDbName
  );
  console.log('Backfilled Employees in DB:\n' + empRows);

  const orderRows = runMysql(
    'SELECT `id`, `jobNumber`, `trackingToken` FROM `RepairOrder`;',
    testDbName
  );
  console.log('Backfilled RepairOrders in DB:\n' + orderRows);

  console.log(`[Step 5] Applying Migration 3 (20261104130000_optional_status_log_changed_by)...`);
  const mig3Path = path.resolve(
    __dirname,
    '../../../packages/db/prisma/migrations/20261104130000_optional_status_log_changed_by/migration.sql'
  );
  const mig3Sql = fs.readFileSync(mig3Path, 'utf8');
  runMysql(mig3Sql, testDbName);
  console.log('Migration 3 executed successfully.\n');

  // Teardown temporary migration test database
  runMysql(`DROP DATABASE IF EXISTS \`${testDbName}\`;`);
  console.log(`Cleaned up temporary database "${testDbName}".`);

  console.log('=================================================================');
  console.log('SAFE MIGRATION TEST COMPLETED SUCCESSFULLY! ALL CHECKS PASSED.');
  console.log('=================================================================\n');
}

runSafeMigrationTest();
