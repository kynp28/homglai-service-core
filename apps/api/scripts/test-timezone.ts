import { getBangkokYearMonth } from '../src/utils/date';

function runTimezoneTests() {
  console.log('--- Testing Asia/Bangkok Timezone YYMM Generation ---');

  // Test 1: Last second of November 2026 UTC vs Bangkok
  // 2026-11-30 16:59:59 UTC = 2026-11-30 23:59:59 Bangkok (UTC+7) -> Month 11
  const beforeRollover = new Date('2026-11-30T16:59:59.000Z');
  const yymmBefore = getBangkokYearMonth(beforeRollover);
  console.log(`Before rollover (23:59:59 UTC+7): ${yymmBefore} (Expected: 2611)`);
  if (yymmBefore !== '2611') {
    throw new Error(`Failed: expected 2611, got ${yymmBefore}`);
  }

  // Test 2: One second later -> Month rollover
  // 2026-11-30 17:00:01 UTC = 2026-12-01 00:00:01 Bangkok (UTC+7) -> Month 12
  const afterRollover = new Date('2026-11-30T17:00:01.000Z');
  const yymmAfter = getBangkokYearMonth(afterRollover);
  console.log(`After rollover (00:00:01 UTC+7): ${yymmAfter} (Expected: 2612)`);
  if (yymmAfter !== '2612') {
    throw new Error(`Failed: expected 2612, got ${yymmAfter}`);
  }

  // Test 3: Year rollover
  // 2026-12-31 17:00:01 UTC = 2027-01-01 00:00:01 Bangkok (UTC+7) -> Year 27, Month 01
  const yearRollover = new Date('2026-12-31T17:00:01.000Z');
  const yymmYear = getBangkokYearMonth(yearRollover);
  console.log(`New Year rollover (00:00:01 UTC+7): ${yymmYear} (Expected: 2701)`);
  if (yymmYear !== '2701') {
    throw new Error(`Failed: expected 2701, got ${yymmYear}`);
  }

  console.log('All timezone tests passed successfully!\n');
}

runTimezoneTests();
