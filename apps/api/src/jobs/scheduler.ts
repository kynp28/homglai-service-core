import { getAppConfig } from '../config/env';
import { runJobsOnce } from './run-jobs';

/**
 * Runs runJobsOnce every JOB_WORKER_INTERVAL_SECONDS. Disabled with JOBS_ENABLED=false (tests call
 * runJobsOnce directly). A round still running when the next tick fires is skipped, never overlapped.
 */
export interface JobScheduler {
  /** Stops the timer and waits for a round in progress to finish. */
  stop(): Promise<void>;
}

export function startJobScheduler(): JobScheduler | null {
  const config = getAppConfig();
  if (!config.jobsEnabled) {
    console.log('[Jobs] Background jobs disabled (JOBS_ENABLED=false)');
    return null;
  }

  let running: Promise<void> | null = null;
  const tick = () => {
    if (running) {
      console.warn('[Jobs] Previous round still running; skipping this tick');
      return;
    }
    running = runJobsOnce(new Date())
      .then((report) => {
        if (report.failedJobs.length > 0) console.warn('[Jobs] Round finished with failed jobs:', report.failedJobs.join(', '));
      })
      .catch((err) => console.error('[Jobs] Round failed:', err?.message || err))
      .finally(() => {
        running = null;
      });
  };

  const timer = setInterval(tick, config.jobWorkerIntervalSeconds * 1000);
  console.log(`[Jobs] Background jobs every ${config.jobWorkerIntervalSeconds}s`);

  return {
    async stop() {
      clearInterval(timer);
      if (running) await running;
    },
  };
}
