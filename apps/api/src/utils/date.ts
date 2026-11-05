/**
 * Helper to compute Bangkok-local YYMM representation
 * Prevents UTC server skew during month transitions.
 */
export function getBangkokYearMonth(date: Date = new Date()): string {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Bangkok',
    year: '2-digit',
    month: '2-digit',
  });

  const parts = formatter.formatToParts(date);
  const year = parts.find((p) => p.type === 'year')?.value || '00';
  const month = parts.find((p) => p.type === 'month')?.value || '01';

  return `${year}${month}`;
}

/**
 * Returns today's calendar date in Asia/Bangkok (UTC+7) as a Date at 00:00:00 UTC of that date,
 * which is the representation Prisma expects for `@db.Date` columns.
 * Never uses MySQL CURRENT_DATE (server time zone is UTC, which would be wrong between 00:00 and 07:00 Thai time).
 */
export function getBangkokDateOnly(date: Date = new Date()): Date {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  const parts = formatter.formatToParts(date);
  const year = parts.find((p) => p.type === 'year')!.value;
  const month = parts.find((p) => p.type === 'month')!.value;
  const day = parts.find((p) => p.type === 'day')!.value;

  return new Date(`${year}-${month}-${day}T00:00:00.000Z`);
}

/** True when `value` is a real calendar date written as YYYY-MM-DD (rejects 2026-02-30 etc.). */
export function isDateOnlyString(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Converts a validated YYYY-MM-DD string to the Date representation Prisma expects for `@db.Date`. */
export function dateOnlyToDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

/** Whole days from `a` to `b` for `@db.Date` values (b - a). */
export function diffDateOnlyDays(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}
