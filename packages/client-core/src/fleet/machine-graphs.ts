/**
 * The three graphs of a machine's page on the desktop Fleet screen, described
 * as geometry (spec 17 §Graphs and the forecast). The caller turns the
 * geometry into SVG paths. Nothing here reads a clock: the right edge of a
 * graph is the time its history was read.
 *
 * This module is its own subpath (`@hercule/client-core/machine-graphs`) and is
 * not re-exported from the package index, so the first screen does not carry
 * it.
 *
 * Every coordinate is between 0 and 1. `x` runs from the left edge (0) to the
 * right edge (1). `y` runs from the bottom (0) to the top (1), so a renderer
 * flips it. A graph with fewer points than its range holds draws them from the
 * right.
 */
import { RUNNER_METRICS_POINT_MS, type Runner, type RunnerMetricsPoint } from "@hercule/contract";
import { MEMORY_FAIL_FROM_PERCENT, MEMORY_YOU_FROM_PERCENT } from "./machine";
import { FIVE_MINUTE_HISTORY_MS, type RunnerMetricsHistory } from "./metrics-history";

const FIVE_MINUTES_MS = RUNNER_METRICS_POINT_MS.fiveMinutes;

/** A place on a graph. */
export interface GraphPoint {
  readonly x: number;
  readonly y: number;
}

/** One unbroken stretch of a series. A gap in the history starts a new one. */
export type GraphLine = readonly GraphPoint[];

/** A place on the edge of a band: the band covers `low` to `high` at `x`. */
export interface GraphBandPoint {
  readonly x: number;
  readonly low: number;
  readonly high: number;
}

/** One unbroken stretch of a band. A gap in the history starts a new one. */
export type GraphBand = readonly GraphBandPoint[];

/**
 * A graph that has nothing to draw. The caller shows the note of the matching
 * instrument in its place (`MachineInstruments`), which says why and what to
 * do.
 */
export interface UnavailableGraph {
  readonly kind: "unavailable";
}

/**
 * The Sessions graph, from five-minute points. Each point is a step as wide as
 * the point. Steps of consecutive points join; a gap breaks them.
 */
export interface SessionsGraph {
  readonly kind: "drawn";
  /** The sessions running, as the outline of a step area that fills down to y 0. */
  readonly running: readonly GraphLine[];
  /** Where sessions waited: the band from the running sessions up to running plus queued. */
  readonly waiting: readonly GraphBand[];
  /** The `y` of the line of the session cap. */
  readonly capY: number;
}

/** The CPU graph, from five-minute points, on a scale of 0 to 100%. */
export interface CpuGraph {
  readonly kind: "drawn";
  /** The average, as a line. A point with no CPU breaks it. */
  readonly average: readonly GraphLine[];
  /** The band from the average up to the peak. */
  readonly peak: readonly GraphBand[];
}

/** The Memory graph, from five-minute points, on a scale of 0 to the machine's memory. */
export interface MemoryGraph {
  readonly kind: "drawn";
  /** The memory in use, as a line. */
  readonly inUse: readonly GraphLine[];
  /** The band from the memory in use up to the most that was in use. */
  readonly highest: readonly GraphBand[];
  /** The `y` where memory in use turns `you`: 80%. */
  readonly youY: number;
  /** The `y` where memory in use turns `fail`: 92%. */
  readonly failY: number;
}

/** The three graphs of a machine's page. */
export interface MachineGraphs {
  readonly sessions: SessionsGraph;
  readonly cpu: CpuGraph | UnavailableGraph;
  readonly memory: MemoryGraph | UnavailableGraph;
}

/** A point of the runner's history with its start parsed, so it is parsed once. */
interface DatedPoint {
  readonly at: number;
  readonly point: RunnerMetricsPoint;
}

/** The part of the graph's width from its left edge to `time`, between 0 and 1 for a time inside it. */
type TimeScale = (time: number) => number;

/** Keeps a coordinate on the graph. */
const clamp = (value: number): number => Math.min(1, Math.max(0, value));

/** Returns the points of `runnerId` with their start parsed, in the order they come. */
const pickRunnerPoints = (
  history: RunnerMetricsHistory,
  runnerId: string,
): readonly DatedPoint[] => {
  const picked: DatedPoint[] = [];
  for (const point of history.points) {
    if (point.runnerId === runnerId) picked.push({ at: Date.parse(point.at), point });
  }
  return picked;
};

/**
 * Splits `points` into runs and returns what `describe` made of each point.
 * A run is unbroken: a point that starts more than five minutes after the one
 * before it begins a new run, so a gap in the history stays a gap. So does a
 * point `describe` returns `null` for, which is a point with no value to draw.
 * The points come oldest first.
 */
const splitIntoRuns = <Drawn>(
  points: readonly DatedPoint[],
  describe: (point: RunnerMetricsPoint, at: number) => readonly Drawn[] | null,
): Drawn[][] => {
  const runs: Drawn[][] = [];
  let run: Drawn[] | undefined;
  let previousAt = 0;
  for (const { at, point } of points) {
    const drawn = describe(point, at);
    if (drawn === null) {
      run = undefined;
      continue;
    }
    if (run === undefined || at - previousAt > FIVE_MINUTES_MS) {
      run = [];
      runs.push(run);
    }
    run.push(...drawn);
    previousAt = at;
  }
  return runs;
};

/** Returns the scale of a graph that ends at `readAt` and spans `FIVE_MINUTE_HISTORY_MS`. */
const buildTimeScale = (readAt: number): TimeScale => {
  const left = readAt - FIVE_MINUTE_HISTORY_MS;
  return (time) => (time - left) / FIVE_MINUTE_HISTORY_MS;
};

/**
 * Returns the `x` where the step of a point starts and where it ends. A step
 * is as wide as the point's span, but the newest point is still filling, so
 * its step ends where the history was read.
 */
const locateStep = (at: number, readAt: number, x: TimeScale): readonly [number, number] => [
  x(at),
  x(Math.min(at + FIVE_MINUTES_MS, readAt)),
];

const describeSessionsGraph = (
  runner: Runner,
  points: readonly DatedPoint[],
  x: TimeScale,
  readAt: number,
): SessionsGraph => {
  const cap = runner.maxConcurrentSessions;
  let top = cap;
  for (const { point } of points) {
    top = Math.max(top, point.sessionsRunning + point.sessionsQueued);
  }
  const y = (sessions: number): number => sessions / top;
  return {
    kind: "drawn",
    running: splitIntoRuns(points, ({ sessionsRunning }, at) => {
      const [start, end] = locateStep(at, readAt, x);
      return [
        { x: start, y: y(sessionsRunning) },
        { x: end, y: y(sessionsRunning) },
      ];
    }),
    waiting: splitIntoRuns(points, ({ sessionsRunning, sessionsQueued }, at) => {
      if (sessionsQueued === 0) return null;
      const [start, end] = locateStep(at, readAt, x);
      const low = y(sessionsRunning);
      const high = y(sessionsRunning + sessionsQueued);
      return [
        { x: start, low, high },
        { x: end, low, high },
      ];
    }),
    capY: y(cap),
  };
};

const describeCpuGraph = (
  runner: Runner,
  points: readonly DatedPoint[],
  x: TimeScale,
): CpuGraph | UnavailableGraph => {
  if (runner.metrics === null) return { kind: "unavailable" };
  if (runner.metrics.cpu === undefined) return { kind: "unavailable" };
  return {
    kind: "drawn",
    average: splitIntoRuns(points, ({ cpuAveragePercent }, at) =>
      cpuAveragePercent === null ? null : [{ x: x(at), y: clamp(cpuAveragePercent / 100) }],
    ),
    peak: splitIntoRuns(points, ({ cpuAveragePercent, cpuPeakPercent }, at) =>
      cpuAveragePercent === null || cpuPeakPercent === null
        ? null
        : [
            {
              x: x(at),
              low: clamp(cpuAveragePercent / 100),
              high: clamp(cpuPeakPercent / 100),
            },
          ],
    ),
  };
};

const describeMemoryGraph = (
  runner: Runner,
  points: readonly DatedPoint[],
  x: TimeScale,
): MemoryGraph | UnavailableGraph => {
  const total = runner.facts?.totalMemoryBytes;
  if (total === undefined || total <= 0) return { kind: "unavailable" };
  const y = (availableBytes: number): number => clamp((total - availableBytes) / total);
  return {
    kind: "drawn",
    inUse: splitIntoRuns(points, ({ availableMemoryBytes }, at) => [
      { x: x(at), y: y(availableMemoryBytes) },
    ]),
    highest: splitIntoRuns(points, ({ availableMemoryBytes, availableMemoryLowestBytes }, at) => {
      const low = y(availableMemoryBytes);
      return [{ x: x(at), low, high: y(availableMemoryLowestBytes) }];
    }),
    youY: MEMORY_YOU_FROM_PERCENT / 100,
    failY: MEMORY_FAIL_FROM_PERCENT / 100,
  };
};

/**
 * Describes the Sessions, CPU and Memory graphs of `runner`.
 *
 * `fiveMinutes` holds five-minute points over `FIVE_MINUTE_HISTORY_MS`. It may
 * hold the points of other runners; only those of `runner` are used.
 *
 * - A series is a list of lines or bands. A gap in the history (two points more
 *   than one point apart) starts a new one, so a point the controller has no
 *   row for is a break, never a zero. A point with no CPU breaks the CPU series.
 * - Sessions: the scale is 0 to the larger of the cap and the most sessions
 *   running and queued at once.
 * - CPU: `unavailable` when the runner is too old to report CPU or has not
 *   reported yet.
 * - Memory: `unavailable` until the runner's total memory is known.
 *
 * An `unavailable` graph says nothing itself. The note of the matching
 * instrument (`describeMachinePage`) says why and what to do, and is the one
 * place that sentence is written.
 */
export const describeMachineGraphs = (
  runner: Runner,
  fiveMinutes: RunnerMetricsHistory,
): MachineGraphs => {
  const fiveMinutePoints = pickRunnerPoints(fiveMinutes, runner.id);
  const x = buildTimeScale(fiveMinutes.readAt);
  return {
    sessions: describeSessionsGraph(runner, fiveMinutePoints, x, fiveMinutes.readAt),
    cpu: describeCpuGraph(runner, fiveMinutePoints, x),
    memory: describeMemoryGraph(runner, fiveMinutePoints, x),
  };
};
