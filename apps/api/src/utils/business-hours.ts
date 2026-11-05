/**
 * Business-hours arithmetic (SRS 3.6).
 *
 * Pure functions: no database access and no `new Date()` / `Date.now()` inside — every instant is
 * passed in, so callers and tests control time. The shop is open every day inside a daily window in
 * Asia/Bangkok local time, except closed days passed in by the caller (shop holidays and, for one
 * technician's timers, their weekly day off). Thailand has no DST, so local time = UTC + 7h exactly.
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

/** Days on which no business minute is counted. */
export interface ClosedDays {
  /** Bangkok calendar dates 'YYYY-MM-DD' (shop holidays) */
  dates?: ReadonlySet<string>;
  /** Bangkok weekdays, 0 = Sunday ... 6 = Saturday (a technician's weekly day off) */
  weekdays?: ReadonlySet<number>;
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

/** Bangkok calendar date 'YYYY-MM-DD' of a Bangkok-local day number. */
function localDayKey(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** Bangkok weekday (0 = Sunday) of a Bangkok-local day number. */
function localWeekday(day: number): number {
  return new Date(day * DAY_MS).getUTCDay();
}

/** Bangkok calendar date 'YYYY-MM-DD' of an instant. */
export function bangkokDateKey(date: Date): string {
  assertValidDate(date, 'date');
  return localDayKey(Math.floor((date.getTime() + BANGKOK_OFFSET_MS) / DAY_MS));
}

/**
 * Whole minutes between `from` and `to` that fall inside the business window, across any number
 * of days (nights are skipped). Days listed in `closed` count as 0. Returns 0 when `to` is not
 * after `from`. Seconds are summed exactly and floored once at the end.
 */
export function businessMinutesBetween(
  from: Date,
  to: Date,
  window: BusinessWindow = getBusinessWindow(),
  closed?: ClosedDays
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

  const hasClosedDays = !!closed && ((closed.dates?.size ?? 0) > 0 || (closed.weekdays?.size ?? 0) > 0);
  if (hasClosedDays) {
    for (const wd of closed!.weekdays ?? []) {
      if (!Number.isInteger(wd) || wd < 0 || wd > 6) throw new RangeError(`Invalid weekday ${wd}`);
    }
    const isClosed = (day: number) =>
      (closed!.weekdays?.has(localWeekday(day)) ?? false) || (closed!.dates?.has(localDayKey(day)) ?? false);
    let ms = 0;
    for (let day = firstDay; day <= lastDay; day++) {
      if (!isClosed(day)) ms += overlapOnDay(day);
    }
    return Math.floor(ms / MINUTE_MS);
  }

  let totalMs: number;
  if (firstDay === lastDay) {
    totalMs = overlapOnDay(firstDay);
  } else {
    const fullDaysBetween = lastDay - firstDay - 1;
    totalMs = overlapOnDay(firstDay) + fullDaysBetween * windowLengthMs + overlapOnDay(lastDay);
  }
  return Math.floor(totalMs / MINUTE_MS);
}
