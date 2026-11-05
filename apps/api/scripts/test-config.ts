/**
 * Unit tests for loadAppConfig() (src/config/env.ts): defaults, overrides and fail-fast validation.
 */
import { loadAppConfig } from '../src/config/env';

let passed = 0;

function eq(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(`ASSERTION FAILED: ${label}\n  Expected: ${expected}\n  Actual:   ${actual}`);
  }
  passed++;
  console.log(`  [PASS] ${label}`);
}

function rejects(env: Record<string, string>, mustMention: string[], label: string): void {
  try {
    loadAppConfig(env);
  } catch (err: any) {
    for (const name of mustMention) {
      if (!String(err.message).includes(name)) {
        throw new Error(`ASSERTION FAILED: ${label} — error does not mention ${name}:\n${err.message}`);
      }
    }
    passed++;
    console.log(`  [PASS] ${label} -> rejected (${mustMention.join(', ')})`);
    return;
  }
  throw new Error(`ASSERTION FAILED: ${label} should be rejected`);
}

function main() {
  console.log('==================================================================');
  console.log('CONFIG (ENV) VALIDATION UNIT TESTS');
  console.log('==================================================================\n');

  console.log('[defaults]');
  const d = loadAppConfig({});
  eq(d.ackTimeoutMinutes, 60, 'ACK_TIMEOUT_MINUTES default 60');
  eq(d.ackReminderIntervalMinutes, 60, 'ACK_REMINDER_INTERVAL_MINUTES default 60');
  eq(d.progressReminderIntervalMinutes, 60, 'PROGRESS_REMINDER_INTERVAL_MINUTES default 60');
  eq(d.progressUnansweredAdminThreshold, 3, 'PROGRESS_UNANSWERED_ADMIN_THRESHOLD default 3');
  eq(d.businessHoursStart, '08:00', 'BUSINESS_HOURS_START default 08:00');
  eq(d.businessHoursEnd, '17:30', 'BUSINESS_HOURS_END default 17:30');
  eq(d.businessHoursStartMinute, 480, 'start minute 480');
  eq(d.businessHoursEndMinute, 1050, 'end minute 1050');
  eq(d.imageRetentionDays, 30, 'IMAGE_RETENTION_DAYS default 30');
  eq(d.jobWorkerIntervalSeconds, 60, 'JOB_WORKER_INTERVAL_SECONDS default 60');
  eq(d.jobsEnabled, true, 'JOBS_ENABLED default true');
  eq(d.customerLineApprovalEnabled, false, 'CUSTOMER_LINE_APPROVAL_ENABLED default false');
  eq(d.publicSearchRateLimitMax, 30, 'PUBLIC_SEARCH_RATE_LIMIT_MAX default 30');
  eq(d.imageStorageDir, './data/uploads', 'IMAGE_STORAGE_DIR default');
  eq(d.imageMaxBytes, 5242880, 'IMAGE_MAX_BYTES default 5 MB');
  eq(d.imageMaxPerKind, 10, 'IMAGE_MAX_PER_KIND default 10');
  eq(d.imageMaxLongEdge, 1600, 'IMAGE_MAX_LONG_EDGE default 1600');
  eq(d.notifierDriver, 'db', 'NOTIFIER_DRIVER default db');
  eq(Object.isFrozen(d), true, 'config object is frozen');

  console.log('\n[overrides]');
  const o = loadAppConfig({
    ACK_TIMEOUT_MINUTES: '45',
    BUSINESS_HOURS_START: '09:15',
    BUSINESS_HOURS_END: '18:00',
    JOBS_ENABLED: 'FALSE',
    CUSTOMER_LINE_APPROVAL_ENABLED: 'true',
    IMAGE_STORAGE_DIR: ' /var/homglai/uploads ',
    PROGRESS_UNANSWERED_ADMIN_THRESHOLD: '  ',
  });
  eq(o.ackTimeoutMinutes, 45, 'integer override');
  eq(o.businessHoursStartMinute, 555, 'time override 09:15 -> 555');
  eq(o.businessHoursEndMinute, 1080, 'time override 18:00 -> 1080');
  eq(o.jobsEnabled, false, 'boolean override is case-insensitive');
  eq(o.customerLineApprovalEnabled, true, 'boolean true');
  eq(o.imageStorageDir, '/var/homglai/uploads', 'text override trimmed');
  eq(o.progressUnansweredAdminThreshold, 3, 'blank value falls back to default');

  console.log('\n[fail fast on malformed values]');
  rejects({ ACK_TIMEOUT_MINUTES: 'abc' }, ['ACK_TIMEOUT_MINUTES'], 'non-numeric minutes');
  rejects({ ACK_REMINDER_INTERVAL_MINUTES: '0' }, ['ACK_REMINDER_INTERVAL_MINUTES'], 'zero interval');
  rejects({ PROGRESS_REMINDER_INTERVAL_MINUTES: '-5' }, ['PROGRESS_REMINDER_INTERVAL_MINUTES'], 'negative interval');
  rejects({ IMAGE_RETENTION_DAYS: '1.5' }, ['IMAGE_RETENTION_DAYS'], 'fractional days');
  rejects({ JOB_WORKER_INTERVAL_SECONDS: '1' }, ['JOB_WORKER_INTERVAL_SECONDS'], 'worker interval below 5 s');
  rejects({ JOBS_ENABLED: 'yes' }, ['JOBS_ENABLED'], 'boolean other than true/false');
  rejects({ BUSINESS_HOURS_START: '8:00' }, ['BUSINESS_HOURS_START'], 'time without leading zero');
  rejects({ BUSINESS_HOURS_END: '24:00' }, ['BUSINESS_HOURS_END'], 'time 24:00');
  rejects({ BUSINESS_HOURS_START: '18:00', BUSINESS_HOURS_END: '08:00' }, ['BUSINESS_HOURS_START', 'BUSINESS_HOURS_END'], 'start after end');
  rejects({ BUSINESS_HOURS_START: '08:00', BUSINESS_HOURS_END: '08:00' }, ['BUSINESS_HOURS_START'], 'start equals end');
  rejects({ NOTIFIER_DRIVER: 'line' }, ['NOTIFIER_DRIVER'], 'unsupported notifier driver');
  rejects(
    { ACK_TIMEOUT_MINUTES: 'x', JOBS_ENABLED: 'maybe', IMAGE_MAX_BYTES: '10' },
    ['ACK_TIMEOUT_MINUTES', 'JOBS_ENABLED', 'IMAGE_MAX_BYTES'],
    'all invalid variables listed in one error'
  );

  console.log(`\nCONFIG TESTS PASSED (${passed} assertions)\n`);
}

try {
  main();
} catch (err: any) {
  console.error('\nConfig Test Failed:', err.message);
  process.exit(1);
}
