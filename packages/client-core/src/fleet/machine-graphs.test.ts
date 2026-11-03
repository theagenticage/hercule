import { describe, expect, it } from "vitest";
import type { Runner, RunnerMetricsPoint } from "@hercule/contract";
import { BARE } from "../providers.testing";
import { describeMachinePage } from "./machine-page";
import {
  describeMachineGraphs,
  type CpuGraph,
  type MachineGraphs,
  type MemoryGraph,
} from "./machine-graphs";
import { FIVE_MINUTE_HISTORY_MS, type RunnerMetricsHistory } from "./metrics-history";

const MINUTE_MS = 60_000;
const READ_AT = Date.parse("2026-11-03T12:00:00.000Z");
const MEMORY = 1000;

const OTHER_RUNNER = "01a06d02-0000-7000-8000-0000000000ff";

const buildRunner = (overrides: Partial<Runner> = {}): Runner => ({
  ...BARE,
  facts: { ...BARE.facts!, totalMemoryBytes: MEMORY },
  metrics: { diskFreeBytes: 500, availableMemoryBytes: 500, cpu: null },
  maxConcurrentSessions: 4,
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

const toHistory = (points: RunnerMetricsPoint[]): RunnerMetricsHistory => ({
  points,
  readAt: READ_AT,
});

const describeGraphs = (
  fiveMinutePoints: RunnerMetricsPoint[],
  runner: Runner = buildRunner(),
): MachineGraphs => describeMachineGraphs(runner, toHistory(fiveMinutePoints));

const drawnCpu = (graphs: MachineGraphs): CpuGraph => {
  if (graphs.cpu === null) throw new Error("expected a drawn CPU graph");
  return graphs.cpu;
};

const drawnMemory = (graphs: MachineGraphs): MemoryGraph => {
  if (graphs.memory === null) throw new Error("expected a drawn Memory graph");
  return graphs.memory;
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

  it("draws no CPU graph on a machine whose runner reports no CPU", () => {
    const graphs = describeGraphs(
      [buildPoint(10)],
      buildRunner({ metrics: { diskFreeBytes: 1, availableMemoryBytes: 1 } }),
    );

    expect(graphs.cpu).toBeNull();
  });

  it("draws no CPU graph before the first report", () => {
    expect(describeGraphs([], buildRunner({ metrics: null })).cpu).toBeNull();
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
    expect(describeGraphs([], buildRunner({ facts: null })).memory).toBeNull();
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

describe("describeMachineGraphs unavailable graphs", () => {
  /** The notes of the instruments of `runner`, which are what a page shows in place of an unavailable graph. */
  const describeInstrumentNotes = (runner: Runner) => {
    const { instruments } = describeMachinePage(
      runner,
      {},
      "0.4.2",
      "UTC",
      new Date("2026-11-03T12:00:00.000Z"),
    );
    return {
      cpu: instruments.cpu.note,
      memory: instruments.memory.note,
    };
  };

  it("has an instrument note that says what to do, for each graph with nothing to draw", () => {
    const withoutCpu = buildRunner({ metrics: { diskFreeBytes: 500, availableMemoryBytes: 500 } });
    const withoutFacts = buildRunner({ facts: null });

    expect(describeGraphs([], withoutCpu).cpu).toBeNull();
    expect(describeInstrumentNotes(withoutCpu).cpu).toBe(
      "This machine's runner is too old to report CPU. Update it.",
    );
    expect(describeGraphs([], withoutFacts).memory).toBeNull();
    expect(describeInstrumentNotes(withoutFacts).memory).toBe("Not reported yet");
  });

  it("has the instrument say it was not reported yet, before the first report", () => {
    const unreported = buildRunner({ metrics: null });

    expect(describeGraphs([], unreported).cpu).toBeNull();
    expect(describeInstrumentNotes(unreported)).toEqual({
      cpu: "Not reported yet",
      memory: "Not reported yet",
    });
  });
});
