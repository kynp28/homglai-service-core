import prisma from '@homglai/db';
import { getAppConfig } from '../config/env';
import { AssignmentService, ACCEPTED_WORK_STATUSES } from '../services/assignment.service';
import { notifySafely } from '../notifications';
import { bangkokDateKey, businessMinutesBetween, isWithinBusinessHours } from '../utils/business-hours';
import { ShopCalendarService } from '../services/shop-calendar.service';
import { purgeExpiredImages } from '../services/image.service';

/**
 * Background jobs (SRS 3.3, 3.6, 6.3). Everything takes `now` as a parameter so tests can run a
 * round at any simulated time. Every reminder is "reserved" with a compare-and-set update before it
 * is sent, so several API instances running the same round never send it twice.
 */

const MINUTE = 60_000;

export interface JobRunReport {
  /** Orders returned to the pool because their technician is inactive / no longer a technician */
  requeued: number;
  /** Reserved-but-not-accepted orders included in this round's ADMIN digest */
  ackReminded: number;
  /** Orders reserved for a technician by the queue in this round */
  queueAssigned: number;
  /** Idle jobs included in this round's "still repairing?" messages to technicians */
  progressReminded: number;
  /** Jobs that reached PROGRESS_UNANSWERED_ADMIN_THRESHOLD in this round (sent to ADMINs once) */
  progressEscalated: number;
  /** Images removed by the nightly purge; null when the purge did not run this round */
  imagesPurged: number | null;
  /** Jobs whose step threw (the other steps still ran) */
  failedJobs: string[];
}

/** Job 1 — safety net: orders still held by a deactivated technician or a former technician. */
export async function requeueOrphanedOrders(): Promise<number> {
  const held = await prisma.repairOrder.findMany({
    where: {
      status: { in: ['NEW', ...ACCEPTED_WORK_STATUSES] },
      technicianId: { not: null },
      technician: { OR: [{ isActive: false }, { role: { not: 'TECHNICIAN' } }] },
    },
    select: { technicianId: true, technician: { select: { name: true, isActive: true } } },
    distinct: ['technicianId'],
  });

  // Return every affected order first, then run the side effects (summary + queue), so the queue
  // sees all of them at once and jobs in progress (priority 1) are served first.
  const batches = [];
  for (const row of held) {
    const technicianId = row.technicianId!;
    const reason = row.technician?.isActive === false ? ('DEACTIVATED' as const) : ('ROLE_CHANGED' as const);
    // Same service method as the employee update (Phase 4): no duplicated requeue logic
    const requeued = await prisma.$transaction((tx) =>
      AssignmentService.requeueOrdersOfTechnician(tx, technicianId, null, reason)
    );
    batches.push({ requeued, name: row.technician?.name ?? `#${technicianId}`, reason });
  }
  let total = 0;
  for (const batch of batches) {
    await AssignmentService.afterRequeue(batch.requeued, batch.name, batch.reason);
    total += batch.requeued.length;
  }
  return total;
}

/**
 * Job 2 — reserved jobs not accepted within ACK_TIMEOUT_MINUTES (wall-clock time, assumption C):
 * one digest per ADMIN per round, repeated every ACK_REMINDER_INTERVAL_MINUTES. The job is never
 * moved to another technician.
 */
export async function remindUnacceptedJobs(now: Date): Promise<number> {
  const config = getAppConfig();
  const overdueBefore = new Date(now.getTime() - config.ackTimeoutMinutes * MINUTE);
  const remindBefore = new Date(now.getTime() - config.ackReminderIntervalMinutes * MINUTE);

  const candidates = await prisma.repairOrder.findMany({
    where: {
      status: 'NEW',
      technicianId: { not: null },
      acknowledgedAt: null,
      assignedAt: { not: null, lte: overdueBefore },
      OR: [{ lastAckReminderAt: null }, { lastAckReminderAt: { lte: remindBefore } }],
    },
    select: {
      id: true,
      jobNumber: true,
      technicianId: true,
      assignedAt: true,
      lastAckReminderAt: true,
      technician: { select: { name: true } },
    },
    orderBy: [{ assignedAt: 'asc' }, { id: 'asc' }],
  });

  const digest: Array<{ repairOrderId: number; jobNumber: string; technicianName: string; waitingMinutes: number }> = [];
  for (const order of candidates) {
    // Compare-and-set: only the instance that moves lastAckReminderAt from the value it read sends it
    const claimed = await prisma.repairOrder.updateMany({
      where: {
        id: order.id,
        status: 'NEW',
        technicianId: order.technicianId,
        acknowledgedAt: null,
        lastAckReminderAt: order.lastAckReminderAt,
      },
      data: { lastAckReminderAt: now, ackReminderCount: { increment: 1 } },
    });
    if (claimed.count === 0) continue;
    digest.push({
      repairOrderId: order.id,
      jobNumber: order.jobNumber,
      technicianName: order.technician?.name ?? `#${order.technicianId}`,
      waitingMinutes: Math.max(0, Math.floor((now.getTime() - order.assignedAt!.getTime()) / MINUTE)),
    });
  }

  if (digest.length > 0) {
    await notifySafely({ type: 'ACK_OVERDUE_DIGEST', orders: digest });
  }
  return digest.length;
}

const BANGKOK_OFFSET_MS = 7 * 60 * MINUTE;

/**
 * Job 4 — "are you still repairing?" (SRS 3.6). Only inside business hours, never on a shop holiday
 * or on the technician's weekly day off. A job is due when PROGRESS_REMINDER_INTERVAL_MINUTES business
 * minutes passed since max(last activity, last reminder). One message per technician per round.
 * A job reaching PROGRESS_UNANSWERED_ADMIN_THRESHOLD unanswered reminders is reported to ADMINs once.
 */
export async function remindIdleJobs(now: Date): Promise<{ reminded: number; escalated: number }> {
  if (!isWithinBusinessHours(now)) return { reminded: 0, escalated: 0 };
  const config = getAppConfig();
  const todayKey = bangkokDateKey(now);
  const todayWeekday = new Date(Date.parse(`${todayKey}T00:00:00.000Z`)).getUTCDay();

  const candidates = await prisma.repairOrder.findMany({
    where: { status: { in: ACCEPTED_WORK_STATUSES }, technicianId: { not: null } },
    select: {
      id: true,
      jobNumber: true,
      status: true,
      technicianId: true,
      lastActivityAt: true,
      updatedAt: true,
      lastProgressReminderAt: true,
      progressReminderCount: true,
      machine: { select: { brand: true, model: true } },
      technician: { select: { name: true, weeklyDayOff: true, isActive: true, role: true } },
    },
    orderBy: { id: 'asc' },
  });
  if (candidates.length === 0) return { reminded: 0, escalated: 0 };

  const oldest = candidates.reduce<Date>((min, c) => {
    const at = c.lastActivityAt ?? c.updatedAt;
    return at < min ? at : min;
  }, now);
  const holidays = await ShopCalendarService.holidayDatesSince(oldest);
  if (holidays.has(todayKey)) return { reminded: 0, escalated: 0 }; // shop closed today

  const perTechnician = new Map<number, Array<{ repairOrderId: number; jobNumber: string; machine: { brand: string; model: string } }>>();
  const escalations: Array<{ repairOrderId: number; jobNumber: string; technicianName: string; unansweredCount: number }> = [];
  let reminded = 0;

  for (const c of candidates) {
    const tech = c.technician;
    if (!tech || !tech.isActive || tech.role !== 'TECHNICIAN') continue; // job 1 returns these to the pool
    if (tech.weeklyDayOff === todayWeekday) continue; // technician's day off: timer paused

    const activity = c.lastActivityAt ?? c.updatedAt;
    const since = c.lastProgressReminderAt && c.lastProgressReminderAt > activity ? c.lastProgressReminderAt : activity;
    const idle = businessMinutesBetween(since, now, undefined, ShopCalendarService.closedDaysFor(holidays, tech.weeklyDayOff));
    if (idle < config.progressReminderIntervalMinutes) continue;

    // Compare-and-set: unchanged since we read it (no activity, no other instance reminded it)
    const claimed = await prisma.repairOrder.updateMany({
      where: {
        id: c.id,
        status: c.status,
        technicianId: c.technicianId,
        lastActivityAt: c.lastActivityAt,
        lastProgressReminderAt: c.lastProgressReminderAt,
        progressReminderCount: c.progressReminderCount,
      },
      data: { lastProgressReminderAt: now, progressReminderCount: { increment: 1 } },
    });
    if (claimed.count === 0) continue;
    reminded++;

    const list = perTechnician.get(c.technicianId!) ?? [];
    list.push({ repairOrderId: c.id, jobNumber: c.jobNumber, machine: c.machine });
    perTechnician.set(c.technicianId!, list);

    // Reported once: only in the round where the counter reaches the threshold exactly (assumption H)
    if (c.progressReminderCount + 1 === config.progressUnansweredAdminThreshold) {
      escalations.push({
        repairOrderId: c.id,
        jobNumber: c.jobNumber,
        technicianName: tech.name,
        unansweredCount: c.progressReminderCount + 1,
      });
    }
  }

  for (const [technicianId, orders] of perTechnician) {
    await notifySafely({ type: 'PROGRESS_CHECK', technicianId, orders });
  }
  if (escalations.length > 0) {
    await notifySafely({ type: 'PROGRESS_UNANSWERED_DIGEST', orders: escalations });
  }
  return { reminded, escalated: escalations.length };
}

/** Bangkok hour in which the nightly image purge runs (02:00-02:59). */
export const PURGE_HOUR_BANGKOK = 2;
let lastPurgeDay: string | null = null;

/** Test helper: forget that the purge already ran today. */
export function resetJobState(): void {
  lastPurgeDay = null;
}

/**
 * Job 5 — expired photos (SRS 2.3), once per Bangkok day during 02:xx. purgeExpiredImages is
 * idempotent, so running it again after a restart (or on a second instance) does no harm.
 */
export async function purgeImagesNightly(now: Date): Promise<number | null> {
  const bangkokHour = new Date(now.getTime() + BANGKOK_OFFSET_MS).getUTCHours();
  const day = bangkokDateKey(now);
  if (bangkokHour !== PURGE_HOUR_BANGKOK || lastPurgeDay === day) return null;
  lastPurgeDay = day;
  return purgeExpiredImages(now);
}

/**
 * One round of every background job, in order. A failing job is logged and the next one still runs.
 */
export async function runJobsOnce(now: Date = new Date()): Promise<JobRunReport> {
  const report: JobRunReport = {
    requeued: 0,
    ackReminded: 0,
    queueAssigned: 0,
    progressReminded: 0,
    progressEscalated: 0,
    imagesPurged: null,
    failedJobs: [],
  };
  const step = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err: any) {
      report.failedJobs.push(name);
      console.error(`[Jobs] ${name} failed:`, err?.message || err);
    }
  };

  await step('requeueOrphanedOrders', async () => {
    report.requeued = await requeueOrphanedOrders();
  });
  await step('remindUnacceptedJobs', async () => {
    report.ackReminded = await remindUnacceptedJobs(now);
  });
  await step('processQueue', async () => {
    report.queueAssigned = await AssignmentService.processQueue();
  });
  await step('remindIdleJobs', async () => {
    const result = await remindIdleJobs(now);
    report.progressReminded = result.reminded;
    report.progressEscalated = result.escalated;
  });
  await step('purgeImagesNightly', async () => {
    report.imagesPurged = await purgeImagesNightly(now);
  });
  return report;
}

