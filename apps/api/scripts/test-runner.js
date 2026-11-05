const { spawn, execSync } = require('child_process');
const path = require('path');
const axios = require('axios');

// Load MYSQL_ROOT_PASSWORD (and friends) from the repo-root .env used by docker-compose.
// Variables already set in the shell always win (dotenv never overrides them).
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });

const pnpmCmd = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

const testDbContainer = process.env.TEST_DB_CONTAINER || 'homglai-mysql-test';
const testDbUser = process.env.TEST_DB_USER || 'root';
const testDbPassword = process.env.TEST_DB_PASSWORD || process.env.MYSQL_ROOT_PASSWORD || 'root';
const testDbHost = process.env.TEST_DB_HOST || '127.0.0.1';
const testDbPort = process.env.TEST_DB_PORT || '3307';

const defaultTestDbUrl = `mysql://${encodeURIComponent(testDbUser)}:${encodeURIComponent(testDbPassword)}@${testDbHost}:${testDbPort}/homglai_db_test`;
const testDatabaseUrl = process.env.DATABASE_URL || defaultTestDbUrl;

function assertSafeDatabaseUrl(url) {
  let dbName = '';
  try {
    const parsed = new URL(url.replace('mysql://', 'http://'));
    dbName = parsed.pathname.replace(/^\//, '').split('?')[0];
  } catch (_) {
    const match = url.match(/\/([^/?]+)(\?|$)/);
    if (match) dbName = match[1];
  }

  const isTestDb = dbName.endsWith('_test');
  const allowDestructive = process.env.ALLOW_DESTRUCTIVE_TESTS === 'true';

  if (!isTestDb && !allowDestructive) {
    throw new Error(
      `FATAL: Refusing to run destructive tests on database "${dbName}". ` +
      `The database name must end with "_test" (e.g. homglai_db_test) or ALLOW_DESTRUCTIVE_TESTS=true must be set.`
    );
  }
}

// 1. Guard check test database name
assertSafeDatabaseUrl(testDatabaseUrl);

const testEnv = {
  ...process.env,
  DATABASE_URL: testDatabaseUrl,
  TEST_DB_CONTAINER: testDbContainer,
  TEST_DB_USER: testDbUser,
  TEST_DB_PASSWORD: testDbPassword,
  TEST_DB_HOST: testDbHost,
  TEST_DB_PORT: testDbPort,
  JWT_SECRET: process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-characters-long',
  LINE_CHANNEL_SECRET: process.env.LINE_CHANNEL_SECRET || 'test-line-secret',
  LINE_CHANNEL_ACCESS_TOKEN: process.env.LINE_CHANNEL_ACCESS_TOKEN || 'test-channel-access-token',
  SEED_DEFAULT_PASSWORD: process.env.SEED_DEFAULT_PASSWORD || 'SecretPassword123!',
  // Phase 6: the API under test accepts mock LIFF tokens ("mock:<userId>"); refused unless NODE_ENV=test
  NODE_ENV: 'test',
  LINE_IDENTITY_VERIFIER: 'mock',
  LINE_LOGIN_CHANNEL_ID: process.env.LINE_LOGIN_CHANNEL_ID || 'test-login-channel',
};

async function waitForHealth(timeoutMs = 20000) {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    try {
      const res = await axios.get('http://127.0.0.1:4000/api/health', { timeout: 1000 });
      if (res.status === 200 && res.data.database === 'connected') {
        return;
      }
    } catch (e) {
      // Retry
    }
    await new Promise((r) => setTimeout(r, 600));
  }
  throw new Error(`Server health check timed out after ${timeoutMs}ms`);
}

async function run() {
  const apiDir = path.resolve(__dirname, '..');
  const rootDir = path.resolve(apiDir, '../..');

  console.log(`>>> [Test Runner] Ensuring test database exists on service "${testDbContainer}" (port ${testDbPort})...`);
  try {
    execSync(
      `docker exec -i -e MYSQL_PWD="${testDbPassword}" ${testDbContainer} mysql -u${testDbUser} -e "CREATE DATABASE IF NOT EXISTS homglai_db_test;"`,
      { stdio: 'ignore' }
    );
  } catch (_) {}

  console.log('>>> [Test Runner] Deploying Prisma migrations to test database...');
  execSync(`${pnpmCmd} --filter @homglai/db run db:deploy`, { cwd: rootDir, stdio: 'inherit', env: testEnv });

  console.log('>>> [Test Runner] Building Database package...');
  execSync(`${pnpmCmd} --filter @homglai/db build`, { cwd: rootDir, stdio: 'inherit', env: testEnv });

  console.log('>>> [Test Runner] Building API TypeScript...');
  execSync(`${pnpmCmd} build`, { cwd: apiDir, stdio: 'inherit', env: testEnv });

  console.log('>>> [Test Runner] Seeding test database with required master data...');
  execSync(`${pnpmCmd} seed:test`, { cwd: apiDir, stdio: 'inherit', env: testEnv });

  console.log('>>> [Test Runner] Starting API Server on Port 4000...');
  const server = spawn('node', ['dist/index.js'], {
    cwd: apiDir,
    stdio: 'inherit',
    env: testEnv,
  });

  try {
    console.log('>>> [Test Runner] Waiting for API server to become ready...');
    await waitForHealth();
    console.log('>>> [Test Runner] API Server is READY!\n');

    console.log('>>> [Test Runner] 1/12 Running Timezone Rollover Tests...');
    execSync(`${pnpmCmd} test:timezone`, { cwd: apiDir, stdio: 'inherit', env: testEnv });

    console.log('\n>>> [Test Runner] 2/12 Running Business Hours Unit Tests...');
    execSync(`${pnpmCmd} test:business-hours`, { cwd: apiDir, stdio: 'inherit', env: testEnv });

    console.log('\n>>> [Test Runner] 3/12 Running Config Validation Unit Tests...');
    execSync(`${pnpmCmd} test:config`, { cwd: apiDir, stdio: 'inherit', env: testEnv });

    console.log('\n>>> [Test Runner] 4/12 Running Safe 3-Step Migration Test (>= 5 Rows Legacy Data)...');
    execSync(`${pnpmCmd} test:migration`, { cwd: apiDir, stdio: 'inherit', env: testEnv });

    console.log('\n>>> [Test Runner] 5/12 Running Comprehensive Smoke Tests (Positive & Negative)...');
    execSync(`${pnpmCmd} test:smoke`, { cwd: apiDir, stdio: 'inherit', env: testEnv });

    console.log('\n>>> [Test Runner] 6/12 Running High-Concurrency & Contention Tests (20 Rounds & Race Tests)...');
    execSync(`${pnpmCmd} test:concurrency`, { cwd: apiDir, stdio: 'inherit', env: testEnv });

    console.log('\n>>> [Test Runner] 7/12 Running Phase 2 Intake / RepairItem v2 / Visibility Tests...');
    execSync(`${pnpmCmd} test:intake`, { cwd: apiDir, stdio: 'inherit', env: testEnv });

    console.log('\n>>> [Test Runner] 8/12 Running Phase 3 Notifier / Notifications Tests...');
    execSync(`${pnpmCmd} test:notifications`, { cwd: apiDir, stdio: 'inherit', env: testEnv });

    console.log('\n>>> [Test Runner] 9/12 Running Phase 4 Technician Queue Tests...');
    execSync(`${pnpmCmd} test:queue`, { cwd: apiDir, stdio: 'inherit', env: testEnv });

    console.log('\n>>> [Test Runner] 10/12 Running Phase 5 Pricing / Complete / Still-Working Tests...');
    execSync(`${pnpmCmd} test:pricing`, { cwd: apiDir, stdio: 'inherit', env: testEnv });

    console.log('\n>>> [Test Runner] 11/12 Running Phase 5b Job Numbers / Holidays / Day Off / Not Repaired / Payment Tests...');
    execSync(`${pnpmCmd} test:shop-rules`, { cwd: apiDir, stdio: 'inherit', env: testEnv });

    console.log('\n>>> [Test Runner] 12/12 Running Phase 6 Public Search / PDPA / LINE Link Tests...');
    execSync(`${pnpmCmd} test:privacy`, { cwd: apiDir, stdio: 'inherit', env: testEnv });

    console.log('\n=============================================================');
    console.log('>>> [Test Runner] ALL TEST SUITES PASSED WITH 100% SUCCESS! <<<');
    console.log('=============================================================\n');
  } catch (error) {
    console.error('>>> [Test Runner] Test failure:', error.message);
    process.exitCode = 1;
  } finally {
    console.log('>>> [Test Runner] Shutting down API Server...');
    try {
      if (process.platform === 'win32') {
        execSync(`taskkill /pid ${server.pid} /T /F`, { stdio: 'ignore' });
      } else {
        server.kill('SIGTERM');
      }
    } catch (_) {}
  }
}

run();
