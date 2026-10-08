import { expect, test } from "bun:test";
import { startJobs } from "../../src/jobs/runner";

test("a job never overlaps itself, a failing job keeps running, and stop waits for running work", async () => {
  let running = 0;
  let maxConcurrent = 0;
  let slowRuns = 0;
  let failingRuns = 0;
  const lines: string[] = [];
  const jobs = startJobs(
    [
      {
        name: "slow",
        everyMs: 1,
        run: async () => {
          running += 1;
          maxConcurrent = Math.max(maxConcurrent, running);
          await Bun.sleep(30);
          running -= 1;
          slowRuns += 1;
        },
      },
      {
        name: "failing",
        everyMs: 5,
        run: async () => {
          failingRuns += 1;
          throw new Error("boom");
        },
      },
    ],
    (line) => lines.push(line),
  );
  await Bun.sleep(150);
  await jobs.stop();
  const runsAtStop = slowRuns;
  await Bun.sleep(50);

  expect(maxConcurrent).toBe(1);
  expect(slowRuns).toBeGreaterThan(1);
  expect(failingRuns).toBeGreaterThan(1);
  expect(lines[0]).toContain("job failing failed: Error: boom");
  expect(running).toBe(0);
  expect(slowRuns).toBe(runsAtStop);
});
