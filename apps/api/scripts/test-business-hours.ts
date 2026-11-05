/**
 * Unit tests for src/utils/business-hours.ts (pure functions, no server / DB needed).
 * All instants are written in Asia/Bangkok local time via bkk('YYYY-MM-DDTHH:MM[:SS]').
 */
import {
  type BusinessWindow,
  businessMinutesBetween,
  getBusinessWindow,
  isWithinBusinessHours,
} from '../src/utils/business-hours';

const SHOP: BusinessWindow = { startMinute: 8 * 60, endMinute: 17 * 60 + 30 }; // 08:00-17:30

let passed = 0;

function bkk(local: string): Date {
  const withSeconds = local.length === 16 ? `${local}:00` : local;
  const d = new Date(`${withSeconds}+07:00`);
  if (isNaN(d.getTime())) throw new Error(`Bad test date ${local}`);
  return d;
}

function eq(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(`ASSERTION FAILED: ${label}\n  Expected: ${expected}\n  Actual:   ${actual}`);
  }
  passed++;
  console.log(`  [PASS] ${label} = ${actual}`);
}

function throws(fn: () => unknown, label: string): void {
  try {
    fn();
  } catch {
    passed++;
    console.log(`  [PASS] ${label} throws`);
    return;
  }
  throw new Error(`ASSERTION FAILED: ${label} should throw`);
}

function main() {
  console.log('==================================================================');
  console.log('BUSINESS HOURS UNIT TESTS (Asia/Bangkok, 08:00-17:30 every day)');
  console.log('==================================================================\n');

  console.log('[isWithinBusinessHours]');
  eq(isWithinBusinessHours(bkk('2026-11-05T07:59:59'), SHOP), false, 'before 08:00 (07:59:59)');
  eq(isWithinBusinessHours(bkk('2026-11-05T08:00'), SHOP), true, 'exactly 08:00 (inclusive)');
  eq(isWithinBusinessHours(bkk('2026-11-05T12:15'), SHOP), true, 'during the day (12:15)');
  eq(isWithinBusinessHours(bkk('2026-11-05T17:29:59'), SHOP), true, '17:29:59');
  eq(isWithinBusinessHours(bkk('2026-11-05T17:30'), SHOP), false, 'exactly 17:30 (exclusive)');
  eq(isWithinBusinessHours(bkk('2026-11-05T21:00'), SHOP), false, 'after 17:30 (21:00)');
  eq(isWithinBusinessHours(bkk('2026-11-05T00:00'), SHOP), false, 'local midnight');
  eq(isWithinBusinessHours(bkk('2026-11-08T10:00'), SHOP), true, 'Sunday 10:00 (no holidays)');
  eq(isWithinBusinessHours(new Date('2026-11-05T01:00:00Z'), SHOP), true, '01:00 UTC = 08:00 Bangkok');
  eq(isWithinBusinessHours(new Date('2026-11-04T23:30:00Z'), SHOP), false, '23:30 UTC = 06:30 Bangkok');
  eq(
    isWithinBusinessHours(bkk('2026-11-05T08:30'), { startMinute: 9 * 60, endMinute: 18 * 60 }),
    false,
    'custom window 09:00-18:00 at 08:30'
  );

  console.log('\n[businessMinutesBetween — same day]');
  eq(businessMinutesBetween(bkk('2026-11-05T06:00'), bkk('2026-11-05T07:30'), SHOP), 0, 'entirely before 08:00');
  eq(businessMinutesBetween(bkk('2026-11-05T07:00'), bkk('2026-11-05T09:00'), SHOP), 60, 'starts before 08:00 (07:00->09:00)');
  eq(businessMinutesBetween(bkk('2026-11-05T10:00'), bkk('2026-11-05T11:30'), SHOP), 90, 'during the day (10:00->11:30)');
  eq(businessMinutesBetween(bkk('2026-11-05T17:00'), bkk('2026-11-05T20:00'), SHOP), 30, 'runs past 17:30 (17:00->20:00)');
  eq(businessMinutesBetween(bkk('2026-11-05T18:00'), bkk('2026-11-05T22:00'), SHOP), 0, 'entirely after 17:30');
  eq(businessMinutesBetween(bkk('2026-11-05T08:00'), bkk('2026-11-05T17:30'), SHOP), 570, 'exactly the window 08:00->17:30');
  eq(businessMinutesBetween(bkk('2026-11-05T06:00'), bkk('2026-11-05T08:30'), SHOP), 30, 'crosses UTC midnight (06:00->08:30 Bangkok)');

  console.log('\n[businessMinutesBetween — overnight / multi-day]');
  eq(businessMinutesBetween(bkk('2026-11-05T17:00'), bkk('2026-11-06T09:00'), SHOP), 90, 'overnight 17:00->09:00 next day = 30+60');
  eq(businessMinutesBetween(bkk('2026-11-05T17:30'), bkk('2026-11-06T08:00'), SHOP), 0, 'closing 17:30 -> opening 08:00 = 0');
  eq(businessMinutesBetween(bkk('2026-11-05T08:00'), bkk('2026-11-06T08:00'), SHOP), 570, 'exactly 24 hours from opening');
  eq(
    businessMinutesBetween(bkk('2026-11-05T10:00'), bkk('2026-11-08T10:00'), SHOP),
    450 + 2 * 570 + 120,
    'three days 10:00 -> 10:00 (450 + 2x570 + 120)'
  );
  eq(businessMinutesBetween(bkk('2026-12-31T17:00'), bkk('2027-01-01T08:30'), SHOP), 60, 'across new year (30+30)');
  eq(businessMinutesBetween(bkk('2027-01-01T08:00'), bkk('2028-01-01T08:00'), SHOP), 365 * 570, 'one full year (365 x 570)');
  eq(businessMinutesBetween(bkk('2026-11-05T20:00'), bkk('2026-11-07T07:00'), SHOP), 570, 'night -> early morning two days later = one full day');

  console.log('\n[businessMinutesBetween — ordering and rounding]');
  eq(businessMinutesBetween(bkk('2026-11-06T09:00'), bkk('2026-11-05T17:00'), SHOP), 0, 'from > to returns 0');
  eq(businessMinutesBetween(bkk('2026-11-05T10:00'), bkk('2026-11-05T10:00'), SHOP), 0, 'from == to returns 0');
  eq(businessMinutesBetween(bkk('2026-11-05T08:00:00'), bkk('2026-11-05T08:00:59'), SHOP), 0, '59 seconds floors to 0');
  eq(businessMinutesBetween(bkk('2026-11-05T08:00:30'), bkk('2026-11-05T08:02:00'), SHOP), 1, '90 seconds floors to 1');
  eq(businessMinutesBetween(bkk('2026-11-05T17:29:30'), bkk('2026-11-06T08:00:30'), SHOP), 1, '30s before close + 30s after open = 1 minute');

  console.log('\n[input validation and defaults]');
  throws(() => businessMinutesBetween(new Date('invalid'), bkk('2026-11-05T10:00'), SHOP), 'invalid from date');
  throws(() => isWithinBusinessHours(bkk('2026-11-05T10:00'), { startMinute: 600, endMinute: 600 }), 'empty window');
  const configured = getBusinessWindow();
  eq(
    businessMinutesBetween(bkk('2026-11-05T07:00'), bkk('2026-11-06T09:00')),
    businessMinutesBetween(bkk('2026-11-05T07:00'), bkk('2026-11-06T09:00'), configured),
    'default window = configured window'
  );
  if (!process.env.BUSINESS_HOURS_START && !process.env.BUSINESS_HOURS_END) {
    eq(`${configured.startMinute}-${configured.endMinute}`, '480-1050', 'configured default window is 08:00-17:30');
  }

  console.log(`\nBUSINESS HOURS TESTS PASSED (${passed} assertions)\n`);
}

try {
  main();
} catch (err: any) {
  console.error('\nBusiness Hours Test Failed:', err.message);
  process.exit(1);
}
