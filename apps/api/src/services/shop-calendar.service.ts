import prisma from '@homglai/db';
import { AppError } from '../utils/app-error';
import { bangkokDateKey, ClosedDays } from '../utils/business-hours';
import { dateOnlyToDate } from '../utils/date';

/**
 * Shop holidays (special closures) and technicians' weekly days off, used by business-minute timers.
 * The shop is open every day; a technician's weekly day off only pauses the timers of that
 * technician's own jobs (owner decision 2026-11-05). Queue assignment is not affected: a technician
 * on a day off is expected to be OFFLINE.
 */
export class ShopCalendarService {
  /** Holiday dates ('YYYY-MM-DD', Bangkok) from the Bangkok date of `from` onwards. */
  static async holidayDatesSince(from: Date): Promise<Set<string>> {
    const rows = await prisma.shopHoliday.findMany({
      where: { date: { gte: dateOnlyToDate(bangkokDateKey(from)) } },
      select: { date: true },
    });
    return new Set(rows.map((r) => r.date.toISOString().slice(0, 10)));
  }

  /** Closed days for one job's timer: shop holidays + the assigned technician's weekly day off. */
  static closedDaysFor(holidays: ReadonlySet<string>, weeklyDayOff: number | null | undefined): ClosedDays {
    return {
      dates: holidays,
      weekdays: weeklyDayOff === null || weeklyDayOff === undefined ? new Set() : new Set([weeklyDayOff]),
    };
  }

  static async list(params: { from?: string; to?: string }) {
    return prisma.shopHoliday.findMany({
      where: {
        date: {
          ...(params.from ? { gte: dateOnlyToDate(params.from) } : {}),
          ...(params.to ? { lte: dateOnlyToDate(params.to) } : {}),
        },
      },
      orderBy: { date: 'asc' },
      select: { id: true, date: true, name: true, createdAt: true, createdBy: { select: { id: true, name: true } } },
    });
  }

  /** Adds one or more consecutive closed days (from..to inclusive, max 31). Existing dates -> 409. */
  static async create(data: { date: string; toDate?: string; name: string }, actorId: number) {
    const start = dateOnlyToDate(data.date);
    const end = dateOnlyToDate(data.toDate ?? data.date);
    const days = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
    if (days < 1) throw new AppError(400, 'toDate must not be before date');
    if (days > 31) throw new AppError(400, 'A holiday range can cover at most 31 days');

    const dates = Array.from({ length: days }, (_, i) => new Date(start.getTime() + i * 86_400_000));
    const existing = await prisma.shopHoliday.findMany({ where: { date: { in: dates } }, select: { date: true } });
    if (existing.length > 0) {
      throw new AppError(409, 'Some dates are already holidays', {
        existingDates: existing.map((e) => e.date.toISOString().slice(0, 10)),
      });
    }
    try {
      await prisma.shopHoliday.createMany({
        data: dates.map((date) => ({ date, name: data.name, createdById: actorId })),
      });
    } catch (err: any) {
      if (err?.code === 'P2002') throw new AppError(409, 'Some dates are already holidays');
      throw err;
    }
    return ShopCalendarService.list({ from: data.date, to: data.toDate ?? data.date });
  }

  static async remove(id: number) {
    const deleted = await prisma.shopHoliday.deleteMany({ where: { id } });
    if (deleted.count === 0) throw new AppError(404, 'Holiday not found');
  }
}
