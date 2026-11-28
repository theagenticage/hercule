/**
 * The counts mode of the speed tests (`*.speed.test.ts`), which the desktop
 * counts check runs (apps/desktop/scripts/perf-counts.ts, spec 17
 * §Performance › The counts check).
 *
 * The check judges counts, not times, and runs on a machine that may be busy.
 * So when `PERF_COUNTS_FILE` names a file, a speed test that supports the
 * mode:
 *
 * - runs even without `RUN_SPEED_TESTS=1`;
 * - times each read once, with no warm-up, and asserts no time;
 * - appends each count it records to that file, one JSON object per line.
 *
 * Without the variable, the speed tests behave as before.
 */
import { appendFileSync } from "node:fs";

const countsFile = process.env["PERF_COUNTS_FILE"];

/** Whether the speed tests run for their counts only. */
export const isCountingOnly = countsFile !== undefined;

/**
 * Appends the count `value` under `key` to the counts file. Does nothing
 * when the speed tests are not counting only.
 */
export const recordSpeedCount = (key: string, value: number): void => {
  if (countsFile === undefined) return;
  appendFileSync(countsFile, `${JSON.stringify({ key, value })}\n`);
};
