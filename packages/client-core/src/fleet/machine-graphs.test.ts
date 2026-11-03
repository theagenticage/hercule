import { describe, expect, it } from "vitest";
import type { Runner, RunnerMetricsPoint } from "@hercule/contract";
import { BARE } from "../providers.testing";
import type { DiskForecast } from "./disk-forecast";
import {
  FIVE_MINUTE_HISTORY_MS,
  HOUR_HISTORY_MS,
  describeMachineGraphs,
  type CpuGraph,
  type DiskGraph,
  type MachineGraphs,
  type MemoryGraph,
} from "./machine-graphs";
import type { RunnerMetricsHistory } from "./metrics-history";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const READ_AT = Date.parse("2026-11-03T12:00:00.000Z");
const MEMORY = 1000;
const DISK = 1000;

const OTHER_RUNNER = "01a06d02-0000-7000-8000-0000000000ff";

const buildRunner = (overrides: Partial<Runner> = {}): Runner => ({
  ...BARE,
  facts: { ...BARE.facts!, totalMemoryBytes: MEMORY, diskTotalBytes: DISK },
  metrics: { diskFreeBytes: 500, availableMemoryBytes: 500, cpu: null },
  maxConcurrentSessions: 4,
  diskWatermarkBytes: 100,
  ...overrides,
});

/** A point of `runnerId` starting `minutesBeforeRead` before the read. */
const buildPoint = (
  minutesBeforeRead: number,
  overrides: Partial<RunnerMetricsPoint> = {},
): RunnerMetricsPoint => ({
  runnerId: BARE.id,
  at: new Date(READ_AT - minutesBeforeRead * MINUTE_MS).toISOString(),
  minutes: 5,
  diskFreeBytes: 500,
  availableMemoryBytes: 500,
  availableMemoryLowestBytes: 400,
  cpuAveragePercent: 20,
  cpuPeakPercent: 60,
  sessionsRunning: 0,
  sessionsQueued: 0,
  ...overrides,
});

/** An hour point starting `hoursBeforeRead` before the read. */
const buildHourPoint = (
  hoursBeforeRead: number,
  overrides: Partial<RunnerMetricsPoint> = {},
): RunnerMetricsPoint => buildPoint(hoursBeforeRead * 60, { minutes: 60, ...overrides });

const toHistory = (points: RunnerMetricsPoint[]): RunnerMetricsHistory => ({
  points,
  readAt: READ_AT,
});

const describeGraphs = (
  fiveMinutePoints: RunnerMetricsPoint[],
  runner: Runner = buildRunner(),
  hourPoints: RunnerMetricsPoint[] = [],
  forecast: DiskForecast | null = null,
): MachineGraphs =>
  describeMachineGraphs(runner, toHistory(fiveMinutePoints), toHistory(hourPoints), forecast);

const drawnCpu = (graphs: MachineGraphs): CpuGraph => {
  if (graphs.cpu.kind !== "drawn") throw new Error("expected a drawn CPU graph");
  return graphs.cpu;
};

const drawnMemory = (graphs: MachineGraphs): MemoryGraph => {
  if (graphs.memory.kind !== "drawn") throw new Error("expected a drawn Memory graph");
  return graphs.memory;
};

const drawnDisk = (graphs: MachineGraphs): DiskGraph => {
  if (graphs.disk.kind !== "drawn") throw new Error("expected a drawn Disk graph");
  return graphs.disk;
};

/** The `x` of a time `minutesBeforeRead` before the read, on a graph that covers a day. */
const xOfFiveMinuteGraph = (minutesBeforeRead: number): number =>
  1 - (minutesBeforeRead * MINUTE_MS) / FIVE_MINUTE_HISTORY_MS;

describe("describeMachineGraphs sessions", () => {
  it("draws each point as a step as wide as the point, scaled to the cap", () => {
    const graphs = describeGraphs([buildPoint(20, { sessionsRunning: 2 })]);

    expect(graphs.sessions.running).toEqual([
      [
        { x: xOfFiveMinuteGraph(20), y: 0.5 },
        { x: xOfFiveMinuteGraph(15), y: 0.5 },
      ],
    ]);
    expect(graphs.sessions.capY).toBe(1);
    expect(graphs.sessions.resolution).toBe("fiveMinutes");
  });

  it("ends the step of the point that is still filling where the history was read", () => {
    const graphs = describeGraphs([buildPoint(2, { sessionsRunning: 1 })]);

    expect(graphs.sessions.running[0]!.at(-1)!.x).toBe(1);
  });

  it("joins the steps of consecutive points", () => {
    const graphs = describeGraphs([
      buildPoint(15, { sessionsRunning: 1 }),
      buildPoint(10, { sessionsRunning: 3 }),
    ]);

    expect(graphs.sessions.running).toHaveLength(1);
    expect(graphs.sessions.running[0]).toHaveLength(4);
  });

  it("keeps a gap a gap, never a zero", () => {
    const graphs = describeGraphs([
      buildPoint(30, { sessionsRunning: 1 }),
      buildPoint(25, { sessionsRunning: 1 }),
      buildPoint(10, { sessionsRunning: 1 }),
    ]);

    expect(graphs.sessions.running.map((run) => run.length)).toEqual([4, 2]);
  });

  it("does not break the series for points exactly one point apart", () => {
    const graphs = describeGraphs([buildPoint(10), buildPoint(5)]);

    expect(graphs.sessions.running).toHaveLength(1);
  });

  it("draws the sessions that waited as a marigold band stacked above the running ones", () => {
    const graphs = describeGraphs([
      buildPoint(20, { sessionsRunning: 4 }),
      buildPoint(15, { sessionsRunning: 4, sessionsQueued: 4 }),
      buildPoint(10, { sessionsRunning: 4 }),
    ]);

    // The scale rises to 8, the most running and queued at once.
    expect(graphs.sessions.capY).toBe(0.5);
    expect(graphs.sessions.waiting).toEqual([
      [
        { x: xOfFiveMinuteGraph(15), low: 0.5, high: 1 },
        { x: xOfFiveMinuteGraph(10), low: 0.5, high: 1 },
      ],
    ]);
  });

  it("draws no band while nothing waited", () => {
    expect(describeGraphs([buildPoint(10, { sessionsRunning: 2 })]).sessions.waiting).toEqual([]);
  });

  it("draws the cap and nothing else for a machine with no history", () => {
    const graphs = describeGraphs([]);

    expect(graphs.sessions).toMatchObject({ running: [], waiting: [], capY: 1 });
  });

  it("uses only the points of the machine", () => {
    const graphs = describeGraphs([
      buildPoint(10, { sessionsRunning: 4 }),
      buildPoint(10, { runnerId: OTHER_RUNNER, sessionsRunning: 9 }),
    ]);

    expect(graphs.sessions.capY).toBe(1);
    expect(graphs.sessions.running).toHaveLength(1);
  });
});

describe("describeMachineGraphs cpu", () => {
  it("draws the average as a line and the peak as a band above it", () => {
    const graphs = describeGraphs([buildPoint(10, { cpuAveragePercent: 25, cpuPeakPercent: 80 })]);

    expect(drawnCpu(graphs).average).toEqual([[{ x: xOfFiveMinuteGraph(10), y: 0.25 }]]);
    expect(drawnCpu(graphs).peak).toEqual([[{ x: xOfFiveMinuteGraph(10), low: 0.25, high: 0.8 }]]);
  });

  it("breaks the line and the band at a point with no CPU", () => {
    const graphs = describeGraphs([
      buildPoint(15),
      buildPoint(10, { cpuAveragePercent: null, cpuPeakPercent: null }),
      buildPoint(5),
    ]);

    expect(drawnCpu(graphs).average.map((run) => run.length)).toEqual([1, 1]);
    expect(drawnCpu(graphs).peak.map((run) => run.length)).toEqual([1, 1]);
  });

  it("says what to do on a machine whose runner reports no CPU", () => {
    const graphs = describeGraphs(
      [buildPoint(10)],
      buildRunner({ metrics: { diskFreeBytes: 1, availableMemoryBytes: 1 } }),
    );

    expect(graphs.cpu).toEqual({
      kind: "unavailable",
      note: "This machine's runner is too old to report CPU. Update it.",
    });
  });

  it("says nothing was reported before the first report", () => {
    expect(describeGraphs([], buildRunner({ metrics: null })).cpu).toEqual({
      kind: "unavailable",
      note: "Not reported yet",
    });
  });
});

describe("describeMachineGraphs memory", () => {
  it("draws the memory in use as a line, its highest as a band, and the 80% and 92% lines", () => {
    const graphs = describeGraphs([
      buildPoint(10, { availableMemoryBytes: 600, availableMemoryLowestBytes: 300 }),
    ]);

    expect(drawnMemory(graphs)).toMatchObject({
      inUse: [[{ x: xOfFiveMinuteGraph(10), y: 0.4 }]],
      highest: [[{ x: xOfFiveMinuteGraph(10), low: 0.4, high: 0.7 }]],
      youY: 0.8,
      failY: 0.92,
    });
  });

  it("breaks the line at a gap", () => {
    const graphs = describeGraphs([buildPoint(30), buildPoint(10)]);

    expect(drawnMemory(graphs).inUse).toHaveLength(2);
  });

  it("draws no graph before the machine's memory is known", () => {
    expect(describeGraphs([], buildRunner({ facts: null })).memory).toEqual({
      kind: "unavailable",
      note: "Not reported yet",
    });
  });
});

describe("describeMachineGraphs disk", () => {
  const FORECAST_FROM = { at: READ_AT, freeBytes: 400 };

  /** Hour points that use 500 and then 600 of the disk. */
  const filling = [
    buildHourPoint(2, { diskFreeBytes: 500 }),
    buildHourPoint(1, { diskFreeBytes: 400 }),
  ];

  it("draws the space in use on a scale from under the lowest point up to the limit", () => {
    const graphs = describeGraphs([], buildRunner(), filling);

    // In use 500 and 600, the limit at 900, so the bottom is 500 - 400 * 0.6 = 260.
    const [first, second] = drawnDisk(graphs).inUse[0]!;
    expect(first!.y).toBeCloseTo(240 / 640);
    expect(second!.y).toBeCloseTo(340 / 640);
    expect(second!.x).toBeCloseTo(1 - HOUR_MS / HOUR_HISTORY_MS);
    expect(drawnDisk(graphs).limitY).toBe(1);
    expect(drawnDisk(graphs).resolution).toBe("hour");
    expect(drawnDisk(graphs).forecast).toBeNull();
    expect(drawnDisk(graphs).forecastText).toBeNull();
  });

  it("raises the top to the highest point when the space in use is above the limit", () => {
    const graphs = describeGraphs([], buildRunner(), [
      buildHourPoint(2, { diskFreeBytes: 500 }),
      buildHourPoint(1, { diskFreeBytes: 50 }),
    ]);

    // In use 500 and 950; the limit at 900 is under the top.
    expect(drawnDisk(graphs).inUse[0]!.at(-1)!.y).toBe(1);
    expect(drawnDisk(graphs).limitY).toBeLessThan(1);
  });

  it("breaks the line at a missing hour", () => {
    const graphs = describeGraphs([], buildRunner(), [
      buildHourPoint(5),
      buildHourPoint(4),
      buildHourPoint(2),
    ]);

    expect(drawnDisk(graphs).inUse.map((run) => run.length)).toEqual([2, 1]);
  });

  it("makes the graph wider to the right for the forecast, and draws the dashed line to the limit", () => {
    const forecast: DiskForecast = {
      days: 3,
      from: FORECAST_FROM,
      reachesAt: READ_AT + 3 * DAY_MS,
    };

    const graphs = describeGraphs([], buildRunner(), filling, forecast);

    const width = 17 * DAY_MS;
    expect(drawnDisk(graphs).inUse[0]!.at(-1)!.x).toBeCloseTo((HOUR_HISTORY_MS - HOUR_MS) / width);
    expect(drawnDisk(graphs).forecast).toEqual([
      { x: HOUR_HISTORY_MS / width, y: 340 / 640 },
      { x: 1, y: 1 },
    ]);
    expect(drawnDisk(graphs).forecastText).toBe("Reaches its limit in about 3 days");
  });

  it("cuts a forecast further out than 14 days at the right edge", () => {
    const forecast: DiskForecast = {
      days: 30,
      from: FORECAST_FROM,
      reachesAt: READ_AT + 30 * DAY_MS,
    };

    const line = drawnDisk(describeGraphs([], buildRunner(), filling, forecast)).forecast!;

    // 14 of the 30 days from 600 to the limit at 900: 740, which is (740 - 260) / 640 up.
    expect(line[1]!.x).toBe(1);
    expect(line[1]!.y).toBeCloseTo(480 / 640);
  });

  it("words one day in the singular", () => {
    const forecast: DiskForecast = { days: 1, from: FORECAST_FROM, reachesAt: READ_AT + DAY_MS };

    expect(drawnDisk(describeGraphs([], buildRunner(), filling, forecast)).forecastText).toBe(
      "Reaches its limit in about 1 day",
    );
  });

  it("says what to do on a machine whose runner does not report its disk's size", () => {
    const runner = buildRunner({ facts: { ...BARE.facts!, totalMemoryBytes: MEMORY } });

    expect(describeGraphs([], runner, filling).disk).toEqual({
      kind: "unavailable",
      note: "This machine's runner does not report its disk size. Update it to see how full the disk is.",
    });
  });

  it("draws the limit and no line for a machine with no history", () => {
    const graphs = describeGraphs([], buildRunner(), []);

    expect(drawnDisk(graphs)).toMatchObject({ inUse: [], limitY: 1 });
  });
});

describe("describeMachineGraphs history shorter than the range", () => {
  it("draws the points it has from the right", () => {
    const graphs = describeGraphs([buildPoint(10), buildPoint(5)]);

    const xs = drawnMemory(graphs)
      .inUse.flat()
      .map((place) => place.x);
    expect(Math.min(...xs)).toBeGreaterThan(0.99);
    expect(Math.max(...xs)).toBeLessThanOrEqual(1);
  });
});
