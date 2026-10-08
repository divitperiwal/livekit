export type Job = { name: string; everyMs: number; run: () => Promise<void> };

/**
 * Runs each job on its own interval, never overlapping itself. A failing job logs and
 * tries again next tick; it never stops the others. `stop` waits for running jobs.
 */
export function startJobs(jobs: Job[], log: (line: string) => void = console.log) {
  let stopping = false;
  const running = new Set<Promise<void>>();
  const timers: ReturnType<typeof setTimeout>[] = [];

  async function runOnce(job: Job) {
    try {
      await job.run();
    } catch (error) {
      const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
      log(`job ${job.name} failed: ${detail}`);
    }
  }

  /** The next run is scheduled only once this one ends, so a job never overlaps itself. */
  function schedule(job: Job, delayMs: number) {
    if (stopping) return;
    const timer = setTimeout(() => {
      const run = runOnce(job).finally(() => {
        running.delete(run);
        schedule(job, job.everyMs);
      });
      running.add(run);
    }, delayMs);
    timers.push(timer);
  }

  for (const job of jobs) schedule(job, 0);
  return {
    async stop() {
      stopping = true;
      for (const timer of timers) clearTimeout(timer);
      await Promise.all(running);
    },
  };
}
