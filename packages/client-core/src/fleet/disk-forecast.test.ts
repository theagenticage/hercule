import { describe, expect, it } from "vitest";
import type { Runner, RunnerFacts, RunnerMetricsPoint } from "@hercule/contract";
import { forecastDiskLimit } from "./disk-forecast";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const NOW = Date.parse("2026-11-03T12:00:00.000Z");
const GB = 1e9;

/** The facts of a runner that does not report its disk's total size. */
const FACTS_WITHOUT_DISK_TOTAL: RunnerFacts = {
  os: "linux",
  arch: "x64",
  totalMemoryBytes: 16 * 1024 ** 3,
  docker: false,
  toolchains: [],
  harnesses: [],
  adapters: [],
  identityPort: 7000,
};

/** A runner with a 1,000 GB disk and a disk limit of 100 GB. */
const buildRunner = (overrides: Partial<Runner> = {}): Runner => ({
  id: "01a06d02-beff-7037-9f5b-042822015952",
  name: "atlas",
  connectivity: "online",
  lifecycle: "active",
  reserved: false,
  version: "0.9.3",
  labels: [],
  facts: { ...FACTS_WITHOUT_DISK_TOTAL, diskTotalBytes: 1000 * GB },
  metrics: { diskFreeBytes: 300 * GB, availableMemoryBytes: 8 * 1024 ** 3 },
  maxConcurrentSessions: 16,
  diskWatermarkBytes: 100 * GB,
  lastSeenAt: "2026-11-03T11:59:00.000Z",
  ...overrides,
});

const RUNNER = buildRunner();

/** Returns the hour point of `runnerId` that starts at `at` (Unix ms) with `diskFreeBytes` free. */
const buildPoint = (
  at: number,
  diskFreeBytes: number,
  runnerId = RUNNER.id,
): RunnerMetricsPoint => ({
  runnerId,
  at: new Date(at).toISOString(),
  minutes: 60,
  diskFreeBytes,
  availableMemoryBytes: 8 * 1024 ** 3,
  availableMemoryLowestBytes: 6 * 1024 ** 3,
  cpuAveragePercent: null,
  cpuPeakPercent: null,
  sessionsRunning: 0,
  sessionsQueued: 0,
});

/**
 * Returns one hour point per hour from `hoursAgo` hours before `NOW` up to and
 * including `NOW`, with free space that starts at `startFreeBytes` and falls
 * `fallPerDayBytes` a day. A negative fall is a rise.
 */
const buildFallingPoints = (
  hoursAgo: number,
  startFreeBytes: number,
  fallPerDayBytes: number,
  runnerId = RUNNER.id,
): RunnerMetricsPoint[] =>
  Array.from({ length: hoursAgo + 1 }, (_, hour) =>
    buildPoint(
      NOW - (hoursAgo - hour) * HOUR_MS,
      startFreeBytes - (hour / 24) * fallPerDayBytes,
      runnerId,
    ),
  );

describe("forecastDiskLimit", () => {
  it("fits a line through a steady fill and counts the days until the limit", () => {
    // 3 days of 10 GB a day, ending at 370 GB: 270 GB above the limit, so 27 days.
    const points = buildFallingPoints(72, 400 * GB, 10 * GB);

    const forecast = forecastDiskLimit(points, RUNNER, NOW);

    expect(forecast?.days).toBe(27);
    expect(forecast?.reachesAt).toBeCloseTo(NOW + 27 * DAY_MS, -3);
    expect(forecast?.from.at).toBe(NOW);
    expect(forecast?.from.freeBytes).toBeCloseTo(370 * GB, -3);
  });

  it("rounds the days to the nearest whole day", () => {
    expect(forecastDiskLimit(buildFallingPoints(72, 406 * GB, 10 * GB), RUNNER, NOW)?.days).toBe(
      28,
    );
    expect(forecastDiskLimit(buildFallingPoints(72, 404 * GB, 10 * GB), RUNNER, NOW)?.days).toBe(
      27,
    );
  });

  it("says at least 1 day when the line reaches the limit within hours", () => {
    const points = buildFallingPoints(72, 131 * GB, 10 * GB);

    expect(forecastDiskLimit(points, RUNNER, NOW)?.days).toBe(1);
  });

  it("reads only the points of the runner, from a list that holds other runners' points", () => {
    const other = buildFallingPoints(72, 150 * GB, 40 * GB, "01a06d02-0002-7000-8000-000000000001");
    const points = [...other, ...buildFallingPoints(72, 400 * GB, 10 * GB)];

    expect(forecastDiskLimit(points, RUNNER, NOW)?.days).toBe(27);
  });

  it("reads only the 7 days before now", () => {
    // Older points sit at 900 GB, so a line through them too would reach the limit much later.
    const older = buildFallingPoints(240, 900 * GB, 0).filter(
      (point) => Date.parse(point.at) < NOW - 7 * DAY_MS,
    );
    const points = [...older, ...buildFallingPoints(72, 400 * GB, 10 * GB)];

    expect(forecastDiskLimit(points, RUNNER, NOW)?.days).toBe(27);
  });

  describe("needs 2 days of points", () => {
    it("gives nothing for 47 hours", () => {
      expect(forecastDiskLimit(buildFallingPoints(47, 400 * GB, 10 * GB), RUNNER, NOW)).toBeNull();
    });

    it("gives a forecast for 48 hours", () => {
      expect(
        forecastDiskLimit(buildFallingPoints(48, 400 * GB, 10 * GB), RUNNER, NOW),
      ).not.toBeNull();
    });

    it("gives a forecast for two lone points 48 hours apart, with nothing between", () => {
      const points = [buildPoint(NOW - 48 * HOUR_MS, 400 * GB), buildPoint(NOW, 380 * GB)];

      // 10 GB a day, 280 GB above the limit.
      expect(forecastDiskLimit(points, RUNNER, NOW)?.days).toBe(28);
    });

    it("gives nothing without points, or with a single point", () => {
      expect(forecastDiskLimit([], RUNNER, NOW)).toBeNull();
      expect(forecastDiskLimit([buildPoint(NOW, 380 * GB)], RUNNER, NOW)).toBeNull();
    });
  });

  describe("after a jump in free space", () => {
    it("uses only the points after the jump", () => {
      // 5 days at 10 GB a day, a cleanup of 300 GB, then 2 days at 20 GB a day from 600 GB.
      const before = buildFallingPoints(7 * 24, 500 * GB, 10 * GB).filter(
        (point) => Date.parse(point.at) < NOW - 48 * HOUR_MS,
      );
      const after = buildFallingPoints(48, 600 * GB, 20 * GB);

      // The line through the 2 days after ends at 560 GB: 460 GB above the limit, at 20 GB a day.
      expect(forecastDiskLimit([...before, ...after], RUNNER, NOW)?.days).toBe(23);
    });

    it("gives nothing until 2 days have passed after the jump", () => {
      const before = buildFallingPoints(7 * 24, 500 * GB, 10 * GB).filter(
        (point) => Date.parse(point.at) < NOW - 24 * HOUR_MS,
      );
      const after = buildFallingPoints(24, 600 * GB, 20 * GB);

      expect(forecastDiskLimit([...before, ...after], RUNNER, NOW)).toBeNull();
    });

    it("sees a jump across a gap in the points", () => {
      const before = [buildPoint(NOW - 100 * HOUR_MS, 200 * GB)];
      const after = buildFallingPoints(48, 600 * GB, 20 * GB);

      expect(forecastDiskLimit([...before, ...after], RUNNER, NOW)?.days).toBe(23);
    });
  });

  it("gives nothing for a line that reaches the limit in more than 60 days", () => {
    // 3 GB a day from 400 GB: 300 GB above the limit is 100 days.
    expect(forecastDiskLimit(buildFallingPoints(72, 400 * GB, 3 * GB), RUNNER, NOW)).toBeNull();
  });

  it("gives a forecast for a line that reaches the limit in 60 days, and none for 61", () => {
    // 270 GB above the limit at 4.5 GB a day is 60 days; at 4.4 GB a day it is 61.4, which rounds to 61.
    expect(forecastDiskLimit(buildFallingPoints(72, 383.5 * GB, 4.5 * GB), RUNNER, NOW)?.days).toBe(
      60,
    );
    expect(forecastDiskLimit(buildFallingPoints(72, 383.2 * GB, 4.4 * GB), RUNNER, NOW)).toBeNull();
  });

  it("gives nothing while the free space rises or stays the same", () => {
    expect(forecastDiskLimit(buildFallingPoints(72, 300 * GB, -5 * GB), RUNNER, NOW)).toBeNull();
    expect(forecastDiskLimit(buildFallingPoints(72, 300 * GB, 0), RUNNER, NOW)).toBeNull();
  });

  it("gives nothing when the newest point is already below the limit", () => {
    // Falls from 150 GB to 90 GB, under the 100 GB limit: the machine needs the user already.
    expect(forecastDiskLimit(buildFallingPoints(72, 150 * GB, 20 * GB), RUNNER, NOW)).toBeNull();
  });

  it("gives nothing for a runner that does not report its disk's total size", () => {
    const runner = buildRunner({ facts: FACTS_WITHOUT_DISK_TOTAL });

    expect(forecastDiskLimit(buildFallingPoints(72, 400 * GB, 10 * GB), runner, NOW)).toBeNull();
  });
});
