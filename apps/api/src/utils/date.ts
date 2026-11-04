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
