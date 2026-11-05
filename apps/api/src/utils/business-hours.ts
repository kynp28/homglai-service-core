/**
 * Business-hours arithmetic (SRS 3.6).
 *
 * Pure functions: no database access and no `new Date()` / `Date.now()` inside — every instant is
 * passed in, so callers and tests control time. The shop is open every day (no holidays) inside a
 * daily window in Asia/Bangkok local time. Thailand has no DST, so local time = UTC + 7h exactly.
 *
 * The window is half-open: [start, end). With 08:00-17:30, 08:00:00 is inside and 17:30:00 is outside.
 */
import { getAppConfig } from '../config/env';

export interface BusinessWindow {
  /** Minutes after local midnight (Asia/Bangkok), inclusive */
  startMinute: number;
  /** Minutes after local midnight (Asia/Bangkok), exclusive */
  endMinute: number;
}

const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/** The configured window (BUSINESS_HOURS_START / BUSINESS_HOURS_END, default 08:00-17:30). */
export function getBusinessWindow(): BusinessWindow {
  const config = getAppConfig();
  return { startMinute: config.businessHoursStartMinute, endMinute: config.businessHoursEndMinute };
}

function assertValidDate(value: Date, label: string): void {
  if (!(value instanceof Date) || isNaN(value.getTime())) {
    throw new TypeError(`${label} must be a valid Date`);
  }
}

function assertValidWindow(window: BusinessWindow): void {
  const { startMinute, endMinute } = window;
  if (
    !Number.isInteger(startMinute) ||
    !Number.isInteger(endMinute) ||
    startMinute < 0 ||
    endMinute > 24 * 60 ||
    startMinute >= endMinute
  ) {
    throw new RangeError(`Invalid business window ${startMinute}-${endMinute}`);
  }
}

/** True when `date` falls inside the business window of its Bangkok calendar day. */
export function isWithinBusinessHours(date: Date, window: BusinessWindow = getBusinessWindow()): boolean {
  assertValidDate(date, 'date');
  assertValidWindow(window);
  const localMs = date.getTime() + BANGKOK_OFFSET_MS;
  const msIntoDay = ((localMs % DAY_MS) + DAY_MS) % DAY_MS;
  return msIntoDay >= window.startMinute * MINUTE_MS && msIntoDay < window.endMinute * MINUTE_MS;
}

/**
 * Whole minutes between `from` and `to` that fall inside the business window, across any number
 * of days (nights are skipped). Returns 0 when `to` is not after `from`.
 * Seconds are summed exactly and floored once at the end.
 */
export function businessMinutesBetween(
  from: Date,
  to: Date,
  window: BusinessWindow = getBusinessWindow()
): number {
  assertValidDate(from, 'from');
  assertValidDate(to, 'to');
  assertValidWindow(window);
  if (to.getTime() <= from.getTime()) return 0;

  // Work in "Bangkok-local epoch" milliseconds so day boundaries are local midnights.
  const fromLocal = from.getTime() + BANGKOK_OFFSET_MS;
  const toLocal = to.getTime() + BANGKOK_OFFSET_MS;
  const windowStartMs = window.startMinute * MINUTE_MS;
  const windowEndMs = window.endMinute * MINUTE_MS;
  const windowLengthMs = windowEndMs - windowStartMs;

  const firstDay = Math.floor(fromLocal / DAY_MS);
  const lastDay = Math.floor(toLocal / DAY_MS);

  const overlapOnDay = (day: number): number => {
    const open = day * DAY_MS + windowStartMs;
    const close = day * DAY_MS + windowEndMs;
    return Math.max(0, Math.min(close, toLocal) - Math.max(open, fromLocal));
  };

  let totalMs: number;
  if (firstDay === lastDay) {
    totalMs = overlapOnDay(firstDay);
  } else {
    const fullDaysBetween = lastDay - firstDay - 1;
    totalMs = overlapOnDay(firstDay) + fullDaysBetween * windowLengthMs + overlapOnDay(lastDay);
  }
  return Math.floor(totalMs / MINUTE_MS);
}
