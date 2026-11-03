/**
 * The four graphs of a machine's page on the desktop Fleet screen, described
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
import type { Runner, RunnerMetricsPoint, RunnerMetricsResolution } from "@hercule/contract";
import type { DiskForecast } from "./disk-forecast";
import { describeForecastDays, MEMORY_FAIL_FROM_PERCENT, MEMORY_YOU_FROM_PERCENT } from "./machine";
import { CPU_TOO_OLD_NOTE, DISK_TOTAL_MISSING_NOTE, NOT_REPORTED_NOTE } from "./machine-page";
import type { RunnerMetricsHistory } from "./metrics-history";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** The time the Sessions, CPU and Memory graphs cover: their history holds five-minute points. */
export const FIVE_MINUTE_HISTORY_MS = DAY_MS;

/** The time the Disk graph covers: its history holds hour points. */
export const HOUR_HISTORY_MS = 14 * DAY_MS;

const FIVE_MINUTES_MS = 5 * MINUTE_MS;

/** The Disk graph's dashed forecast reaches this many days past the newest point, at most. */
const MAX_FORECAST_DRAWN_DAYS = 14;

/** A bottom of the Disk graph's scale this far under its lowest point, in parts of the way to the top. */
const ZOOM_MARGIN = 0.6;

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

/** A graph that has nothing to draw, with the line that says why and what to do. */
export interface UnavailableGraph {
  readonly kind: "unavailable";
  readonly note: string;
}

/**
 * The Sessions graph, from five-minute points. Each point is a step as wide as
 * the point. Steps of consecutive points join; a gap breaks them.
 */
export interface SessionsGraph {
  readonly kind: "drawn";
  readonly resolution: Extract<RunnerMetricsResolution, "fiveMinutes">;
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
  readonly resolution: Extract<RunnerMetricsResolution, "fiveMinutes">;
  /** The average, as a line. A point with no CPU breaks it. */
  readonly average: readonly GraphLine[];
  /** The band from the average up to the peak. */
  readonly peak: readonly GraphBand[];
}

/** The Memory graph, from five-minute points, on a scale of 0 to the machine's memory. */
export interface MemoryGraph {
  readonly kind: "drawn";
  readonly resolution: Extract<RunnerMetricsResolution, "fiveMinutes">;
  /** The memory in use, as a line. */
  readonly inUse: readonly GraphLine[];
  /** The band from the memory in use up to the most that was in use. */
  readonly highest: readonly GraphBand[];
  /** The `y` where memory in use turns `you`: 80%. */
  readonly youY: number;
  /** The `y` where memory in use turns `fail`: 92%. */
  readonly failY: number;
}

/**
 * The Disk graph, from hour points. The scale runs from a little under the
 * lowest point at the bottom to the limit (or the highest point, when that is
 * above it) at the top. When there is a forecast, the graph is wider to the
 * right, so the dashed line fits.
 */
export interface DiskGraph {
  readonly kind: "drawn";
  readonly resolution: Extract<RunnerMetricsResolution, "hour">;
  /** The space in use, as a line that has an area under it down to y 0. */
  readonly inUse: readonly GraphLine[];
  /** The `y` of the line of the disk limit. */
  readonly limitY: number;
  /** The dashed forecast, from the fitted line's start to the limit, cut at the right edge. */
  readonly forecast: GraphLine | null;
  /** "Reaches its limit in about 12 days", when the forecast shows. */
  readonly forecastText: string | null;
}

/** The four graphs of a machine's page. */
export interface MachineGraphs {
  readonly sessions: SessionsGraph;
  readonly cpu: CpuGraph | UnavailableGraph;
  readonly memory: MemoryGraph | UnavailableGraph;
  readonly disk: DiskGraph | UnavailableGraph;
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
 * A run is unbroken: a point that starts more than `spanMs` after the one
 * before it begins a new run, so a gap in the history stays a gap. So does a
 * point `describe` returns `null` for, which is a point with no value to draw.
 * The points come oldest first.
 */
const splitIntoRuns = <Drawn>(
  points: readonly DatedPoint[],
  spanMs: number,
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
    if (run === undefined || at - previousAt > spanMs) {
      run = [];
      runs.push(run);
    }
    run.push(...drawn);
    previousAt = at;
  }
  return runs;
};

/** Returns the scale of a graph whose width starts at `left` and is `widthMs` long. */
const buildTimeScale = (left: number, widthMs: number): TimeScale => {
  return (time) => (time - left) / widthMs;
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
  history: RunnerMetricsHistory,
): SessionsGraph => {
  const x = buildTimeScale(history.readAt - FIVE_MINUTE_HISTORY_MS, FIVE_MINUTE_HISTORY_MS);
  const cap = runner.maxConcurrentSessions;
  let top = cap;
  for (const { point } of points) {
    top = Math.max(top, point.sessionsRunning + point.sessionsQueued);
  }
  const y = (sessions: number): number => sessions / top;
  return {
    kind: "drawn",
    resolution: "fiveMinutes",
    running: splitIntoRuns(points, FIVE_MINUTES_MS, ({ sessionsRunning }, at) => {
      const [start, end] = locateStep(at, history.readAt, x);
      return [
        { x: start, y: y(sessionsRunning) },
        { x: end, y: y(sessionsRunning) },
      ];
    }),
    waiting: splitIntoRuns(points, FIVE_MINUTES_MS, ({ sessionsRunning, sessionsQueued }, at) => {
      if (sessionsQueued === 0) return null;
      const [start, end] = locateStep(at, history.readAt, x);
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
  history: RunnerMetricsHistory,
): CpuGraph | UnavailableGraph => {
  if (runner.metrics === null) return { kind: "unavailable", note: NOT_REPORTED_NOTE };
  if (runner.metrics.cpu === undefined) return { kind: "unavailable", note: CPU_TOO_OLD_NOTE };
  const x = buildTimeScale(history.readAt - FIVE_MINUTE_HISTORY_MS, FIVE_MINUTE_HISTORY_MS);
  return {
    kind: "drawn",
    resolution: "fiveMinutes",
    average: splitIntoRuns(points, FIVE_MINUTES_MS, ({ cpuAveragePercent }, at) =>
      cpuAveragePercent === null ? null : [{ x: x(at), y: clamp(cpuAveragePercent / 100) }],
    ),
    peak: splitIntoRuns(points, FIVE_MINUTES_MS, ({ cpuAveragePercent, cpuPeakPercent }, at) =>
      cpuAveragePercent === null
        ? null
        : [
            {
              x: x(at),
              low: clamp(cpuAveragePercent / 100),
              high: clamp((cpuPeakPercent ?? cpuAveragePercent) / 100),
            },
          ],
    ),
  };
};

const describeMemoryGraph = (
  runner: Runner,
  points: readonly DatedPoint[],
  history: RunnerMetricsHistory,
): MemoryGraph | UnavailableGraph => {
  const total = runner.facts?.totalMemoryBytes;
  if (total === undefined || total <= 0) return { kind: "unavailable", note: NOT_REPORTED_NOTE };
  const x = buildTimeScale(history.readAt - FIVE_MINUTE_HISTORY_MS, FIVE_MINUTE_HISTORY_MS);
  const y = (availableBytes: number): number => clamp((total - availableBytes) / total);
  return {
    kind: "drawn",
    resolution: "fiveMinutes",
    inUse: splitIntoRuns(points, FIVE_MINUTES_MS, ({ availableMemoryBytes }, at) => [
      { x: x(at), y: y(availableMemoryBytes) },
    ]),
    highest: splitIntoRuns(
      points,
      FIVE_MINUTES_MS,
      ({ availableMemoryBytes, availableMemoryLowestBytes }, at) => {
        const low = y(availableMemoryBytes);
        return [{ x: x(at), low, high: Math.max(low, y(availableMemoryLowestBytes)) }];
      },
    ),
    youY: MEMORY_YOU_FROM_PERCENT / 100,
    failY: MEMORY_FAIL_FROM_PERCENT / 100,
  };
};

/**
 * Returns the bottom of the Disk graph's scale: a little under the lowest
 * point, so that a slope reads, while the top stays in view. Never below 0.
 */
const computeZoomFloor = (lowestBytes: number, topBytes: number): number =>
  Math.max(0, lowestBytes - (topBytes - lowestBytes) * ZOOM_MARGIN);

/**
 * Returns the dashed line of the forecast: from where the fitted line starts
 * to where it reaches the limit. A forecast further out than the graph is wide
 * is cut at the right edge, at the height the line has there.
 */
const buildForecastLine = (
  forecast: DiskForecast,
  total: number,
  limitBytes: number,
  x: TimeScale,
  y: (bytes: number) => number,
): GraphLine => {
  const startBytes = total - forecast.from.freeBytes;
  const rightEdge = x(forecast.reachesAt) > 1 ? 1 : x(forecast.reachesAt);
  const share = (rightEdge - x(forecast.from.at)) / (x(forecast.reachesAt) - x(forecast.from.at));
  return [
    { x: x(forecast.from.at), y: y(startBytes) },
    { x: rightEdge, y: y(startBytes + (limitBytes - startBytes) * share) },
  ];
};

const describeDiskGraph = (
  runner: Runner,
  points: readonly DatedPoint[],
  history: RunnerMetricsHistory,
  forecast: DiskForecast | null,
): DiskGraph | UnavailableGraph => {
  const total = runner.facts?.diskTotalBytes;
  if (total === undefined || total <= 0) {
    return { kind: "unavailable", note: DISK_TOTAL_MISSING_NOTE };
  }
  const left = history.readAt - HOUR_HISTORY_MS;
  const forecastDrawnMs =
    forecast === null ? 0 : Math.min(forecast.days, MAX_FORECAST_DRAWN_DAYS) * DAY_MS;
  const x = buildTimeScale(left, HOUR_HISTORY_MS + forecastDrawnMs);

  const limitBytes = total - runner.diskWatermarkBytes;
  let lowestBytes = Infinity;
  let topBytes = limitBytes;
  for (const { point } of points) {
    const inUseBytes = total - point.diskFreeBytes;
    lowestBytes = Math.min(lowestBytes, inUseBytes);
    topBytes = Math.max(topBytes, inUseBytes);
  }
  const floorBytes = points.length === 0 ? 0 : computeZoomFloor(lowestBytes, topBytes);
  const heightBytes = topBytes - floorBytes;
  const y = (bytes: number): number =>
    heightBytes > 0 ? clamp((bytes - floorBytes) / heightBytes) : 0;

  return {
    kind: "drawn",
    resolution: "hour",
    inUse: splitIntoRuns(points, HOUR_MS, ({ diskFreeBytes }, at) => [
      { x: x(at), y: y(total - diskFreeBytes) },
    ]),
    limitY: y(limitBytes),
    forecast: forecast === null ? null : buildForecastLine(forecast, total, limitBytes, x, y),
    forecastText:
      forecast === null ? null : `Reaches its limit in about ${describeForecastDays(forecast)}`,
  };
};

/**
 * Describes the Sessions, CPU, Memory and Disk graphs of `runner`.
 *
 * `fiveMinutes` holds five-minute points over `FIVE_MINUTE_HISTORY_MS` and
 * `hours` holds hour points over `HOUR_HISTORY_MS`. Both may hold the points of
 * other runners; only those of `runner` are used. `forecast` is the machine's
 * disk forecast, or `null` for none.
 *
 * - A series is a list of lines or bands. A gap in the history (two points more
 *   than one point apart) starts a new one, so a point the controller has no
 *   row for is a break, never a zero. A point with no CPU breaks the CPU series.
 * - Sessions: the scale is 0 to the larger of the cap and the most sessions
 *   running and queued at once.
 * - CPU: `unavailable` with a note when the runner is too old to report CPU
 *   or has not reported yet.
 * - Memory: `unavailable` until the runner's total memory is known.
 * - Disk: `unavailable` with a note to update the runner when it does not
 *   report its disk's total size.
 */
export const describeMachineGraphs = (
  runner: Runner,
  fiveMinutes: RunnerMetricsHistory,
  hours: RunnerMetricsHistory,
  forecast: DiskForecast | null,
): MachineGraphs => {
  const fiveMinutePoints = pickRunnerPoints(fiveMinutes, runner.id);
  return {
    sessions: describeSessionsGraph(runner, fiveMinutePoints, fiveMinutes),
    cpu: describeCpuGraph(runner, fiveMinutePoints, fiveMinutes),
    memory: describeMemoryGraph(runner, fiveMinutePoints, fiveMinutes),
    disk: describeDiskGraph(runner, pickRunnerPoints(hours, runner.id), hours, forecast),
  };
};
