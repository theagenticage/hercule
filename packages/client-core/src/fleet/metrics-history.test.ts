import { describe, expect, it } from "vitest";
import type { RunnerMetricsPoint } from "@hercule/contract";
import {
  EMPTY_RUNNER_METRICS_HISTORY,
  findNewestPointStart,
  mergeRunnerMetricsHistory,
  type RunnerMetricsHistory,
} from "./metrics-history";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const T0 = Date.parse("2026-11-03T09:00:00.000Z");

const ATLAS = "01a06d02-0000-7000-8000-00000000000a";
const BOREAS = "01a06d02-0000-7000-8000-00000000000b";

/** A point of `runnerId` starting `minutes` after 09:00, with the free disk space telling points apart. */
const buildPoint = (
  runnerId: string,
  minutes: number,
  diskFreeBytes = 100,
): RunnerMetricsPoint => ({
  runnerId,
  at: new Date(T0 + minutes * MINUTE_MS).toISOString(),
  minutes: 5,
  diskFreeBytes,
  availableMemoryBytes: 1,
  availableMemoryLowestBytes: 1,
  cpuAveragePercent: null,
  cpuPeakPercent: null,
  sessionsRunning: 0,
  sessionsQueued: 0,
});

const buildHistory = (
  points: RunnerMetricsPoint[],
  readAt = T0 + 10 * MINUTE_MS,
): RunnerMetricsHistory => ({
  points,
  readAt,
});

const describePoints = (history: RunnerMetricsHistory): string[] =>
  history.points.map(
    (point) =>
      `${point.runnerId.slice(-1)}@${(Date.parse(point.at) - T0) / MINUTE_MS}:${point.diskFreeBytes}`,
  );

describe("findNewestPointStart", () => {
  it("returns undefined for a history with no point", () => {
    expect(findNewestPointStart(EMPTY_RUNNER_METRICS_HISTORY)).toBeUndefined();
  });

  it("returns the newest start across all runners", () => {
    const history = buildHistory([
      buildPoint(ATLAS, 0),
      buildPoint(ATLAS, 10),
      buildPoint(BOREAS, 0),
      buildPoint(BOREAS, 5),
    ]);

    expect(findNewestPointStart(history)).toBe(new Date(T0 + 10 * MINUTE_MS).toISOString());
  });
});

describe("mergeRunnerMetricsHistory", () => {
  const since = new Date(T0 + 5 * MINUTE_MS).toISOString();

  it("replaces the point that was still filling and appends the new ones", () => {
    const held = buildHistory([buildPoint(ATLAS, 0), buildPoint(ATLAS, 5, 100)]);
    const read = [buildPoint(ATLAS, 5, 90), buildPoint(ATLAS, 10, 80)];

    const merged = mergeRunnerMetricsHistory(held, read, since, T0 + 12 * MINUTE_MS, DAY_MS);

    expect(describePoints(merged)).toEqual(["a@0:100", "a@5:90", "a@10:80"]);
    expect(merged.readAt).toBe(T0 + 12 * MINUTE_MS);
  });

  it("keeps the sort by runner, then oldest first, with several runners", () => {
    const held = buildHistory([
      buildPoint(ATLAS, 0),
      buildPoint(ATLAS, 5, 100),
      buildPoint(BOREAS, 0),
      buildPoint(BOREAS, 5, 100),
    ]);
    const read = [
      buildPoint(ATLAS, 5, 90),
      buildPoint(ATLAS, 10, 80),
      buildPoint(BOREAS, 5, 90),
      buildPoint(BOREAS, 10, 80),
    ];

    const merged = mergeRunnerMetricsHistory(held, read, since, T0 + 12 * MINUTE_MS, DAY_MS);

    expect(describePoints(merged)).toEqual([
      "a@0:100",
      "a@5:90",
      "a@10:80",
      "b@0:100",
      "b@5:90",
      "b@10:80",
    ]);
  });

  it("adds the points of a runner that had none yet", () => {
    const held = buildHistory([buildPoint(BOREAS, 0), buildPoint(BOREAS, 5)]);
    const read = [buildPoint(ATLAS, 5), buildPoint(BOREAS, 5, 90)];

    const merged = mergeRunnerMetricsHistory(held, read, since, T0 + 6 * MINUTE_MS, DAY_MS);

    expect(describePoints(merged)).toEqual(["a@5:100", "b@0:100", "b@5:90"]);
  });

  it("drops points older than the range before the read", () => {
    const held = buildHistory([buildPoint(ATLAS, 0), buildPoint(ATLAS, 5)]);
    const read = [buildPoint(ATLAS, 5), buildPoint(ATLAS, 10)];

    // The range ends at 09:12 and reaches 10 minutes back, so 09:00 is out and 09:05 stays.
    const merged = mergeRunnerMetricsHistory(
      held,
      read,
      since,
      T0 + 12 * MINUTE_MS,
      10 * MINUTE_MS,
    );

    expect(describePoints(merged)).toEqual(["a@5:100", "a@10:100"]);
  });

  it("returns the held history itself when the read is empty and nothing falls out", () => {
    const held = buildHistory([buildPoint(ATLAS, 0)]);

    const merged = mergeRunnerMetricsHistory(held, [], since, T0 + 12 * MINUTE_MS, DAY_MS);

    expect(merged).toBe(held);
  });

  it("returns a new history when an empty read still drops a point", () => {
    const held = buildHistory([buildPoint(ATLAS, 0), buildPoint(ATLAS, 5)]);

    const merged = mergeRunnerMetricsHistory(held, [], since, T0 + 12 * MINUTE_MS, DAY_MS);

    expect(describePoints(merged)).toEqual(["a@0:100"]);
  });

  it("builds a first history from an empty one", () => {
    const read = [buildPoint(ATLAS, 0), buildPoint(ATLAS, 5)];
    const start = new Date(T0 - 10 * MINUTE_MS).toISOString();

    const merged = mergeRunnerMetricsHistory(
      EMPTY_RUNNER_METRICS_HISTORY,
      read,
      start,
      T0 + HOUR_MS,
      2 * HOUR_MS,
    );

    expect(describePoints(merged)).toEqual(["a@0:100", "a@5:100"]);
  });
});
