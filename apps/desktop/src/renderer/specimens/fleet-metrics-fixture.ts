/**
 * The Runner Metrics history of the Fleet specimen (fleet-fixture.ts): what
 * `runnerMetrics.query` would return for each machine at the specimen's clock.
 * It holds no randomness. Every wobble is a sine, so each run draws the same
 * graphs and the goldens stay still.
 *
 * A machine's story is a few functions of "hours ago". `buildMachineMetrics`
 * samples them every five minutes over 14 days, leaves out the samples of a
 * gap or of the time a machine was offline, and makes both kinds of point from
 * the samples: five-minute points for the last 24 hours and hour points for the
 * last 14 days, as the controller does.
 */
import type { RunnerMetricsPoint } from "@hercule/contract";
import { FIVE_MINUTE_HISTORY_MS, HOUR_HISTORY_MS } from "@hercule/client-core/machine-graphs";
import type { RunnerMetricsHistory } from "@hercule/client-core/metrics-history";
import { SPECIMEN_NOW } from "./sidebar-fixture";

const MINUTE_MS = 60_000;
const FIVE_MINUTES_MS = 5 * MINUTE_MS;
const HOUR_MS = 60 * MINUTE_MS;

/** The hour of the day, in UTC, at the specimen's clock: 09:41. */
const NOW_HOUR_OF_DAY = 9 + 41 / 60;

/** A function of how many hours before the specimen's clock a moment is. */
export type OfHoursAgo = (hoursAgo: number) => number;

/** How one machine's numbers moved over the 14 days before the specimen's clock. */
export interface MachineStory {
  readonly runnerId: string;
  readonly totalMemoryBytes: number;
  readonly diskTotalBytes: number;
  readonly sessionsRunning: OfHoursAgo;
  readonly sessionsQueued: OfHoursAgo;
  readonly cpuAveragePercent: OfHoursAgo;
  readonly cpuPeakPercent: OfHoursAgo;
  /** The share of the memory in use, between 0 and 1. */
  readonly memoryInUseShare: OfHoursAgo;
  readonly diskInUseBytes: OfHoursAgo;
  /** Stretches with no samples, as pairs of hours ago, the older first. */
  readonly gaps: ReadonlyArray<readonly [number, number]>;
  /** The machine sent nothing in the last this many hours: it went offline. */
  readonly silentForHours: number;
}

/** The history one machine's page and the Fleet page hold, each as `runnerMetrics.query` reads it. */
export interface MachineMetrics {
  readonly fiveMinutes: RunnerMetricsHistory;
  readonly hours: RunnerMetricsHistory;
}

/** A number between -1 and 1 that moves smoothly with `x` and never repeats exactly. */
export const wobble = (x: number, seed: number): number =>
  Math.sin(x * 2.3 + seed) * 0.6 + Math.sin(x * 7.1 + seed * 3) * 0.4;

/** Like `wobble`, but so slow that hour points follow it smoothly: a disk's use drifts, it does not jitter. */
export const driftWobble = (x: number, seed: number): number => Math.sin(x / 7 + seed);

/**
 * Returns the value at `hoursAgo` on the straight lines between `corners`,
 * which are `[hoursAgo, value]` pairs from the newest to the oldest. Before the
 * first corner and after the last, it holds their value.
 */
export const interpolate = (
  corners: ReadonlyArray<readonly [number, number]>,
  hoursAgo: number,
): number => {
  const first = corners[0]!;
  if (hoursAgo <= first[0]) return first[1];
  for (let index = 1; index < corners.length; index += 1) {
    const [laterAgo, laterValue] = corners[index]!;
    const [earlierAgo, earlierValue] = corners[index - 1]!;
    if (hoursAgo <= laterAgo) {
      const share = (hoursAgo - earlierAgo) / (laterAgo - earlierAgo);
      return earlierValue + (laterValue - earlierValue) * share;
    }
  }
  return corners[corners.length - 1]![1];
};

/** Returns how busy a working day is at `hoursAgo`: 0 at night, 1 at midday UTC. */
export const workingDay = (hoursAgo: number): number => {
  const hourOfDay = (((NOW_HOUR_OF_DAY - hoursAgo) % 24) + 24) % 24;
  return hourOfDay < 7 || hourOfDay > 19 ? 0 : Math.sin((Math.PI * (hourOfDay - 7)) / 12);
};

/** One sample of a machine: what it reported in one five-minute stretch. */
interface Sample {
  readonly at: number;
  readonly diskFreeBytes: number;
  readonly availableMemoryBytes: number;
  readonly availableMemoryLowestBytes: number;
  readonly cpuAveragePercent: number;
  readonly cpuPeakPercent: number;
  readonly sessionsRunning: number;
  readonly sessionsQueued: number;
}

const clampPercent = (value: number): number => Math.min(100, Math.max(0, value));

/** Returns the samples of `story`, every five minutes, oldest first, up to the specimen's clock. */
const buildSamples = (story: MachineStory): readonly Sample[] => {
  const samples: Sample[] = [];
  const newestStart = Math.floor(SPECIMEN_NOW / FIVE_MINUTES_MS) * FIVE_MINUTES_MS;
  for (let at = newestStart - HOUR_HISTORY_MS - HOUR_MS; at <= newestStart; at += FIVE_MINUTES_MS) {
    const hoursAgo = (SPECIMEN_NOW - at) / HOUR_MS;
    const isGap = story.gaps.some(([older, newer]) => hoursAgo <= older && hoursAgo > newer);
    if (isGap || hoursAgo < story.silentForHours) continue;
    const inUseShare = story.memoryInUseShare(hoursAgo);
    const lowestShare = Math.min(1, inUseShare + 0.01 + 0.015 * Math.abs(wobble(hoursAgo, 4)));
    samples.push({
      at,
      diskFreeBytes: Math.round(story.diskTotalBytes - story.diskInUseBytes(hoursAgo)),
      availableMemoryBytes: Math.round(story.totalMemoryBytes * (1 - inUseShare)),
      availableMemoryLowestBytes: Math.round(story.totalMemoryBytes * (1 - lowestShare)),
      cpuAveragePercent: clampPercent(story.cpuAveragePercent(hoursAgo)),
      cpuPeakPercent: clampPercent(story.cpuPeakPercent(hoursAgo)),
      sessionsRunning: Math.round(story.sessionsRunning(hoursAgo)),
      sessionsQueued: Math.round(story.sessionsQueued(hoursAgo)),
    });
  }
  return samples;
};

/** Returns the mean of `values`. */
const mean = (values: readonly number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

/**
 * Makes one point from `samples`, which start in the span that starts at `at`:
 * the means, the lowest available memory, the highest CPU and the most sessions.
 */
const buildPoint = (
  runnerId: string,
  at: number,
  samples: readonly Sample[],
): RunnerMetricsPoint => ({
  runnerId,
  at: new Date(at).toISOString(),
  minutes: Math.min(samples.length * 5, Math.ceil((SPECIMEN_NOW - at) / MINUTE_MS)),
  diskFreeBytes: Math.round(mean(samples.map((sample) => sample.diskFreeBytes))),
  availableMemoryBytes: Math.round(mean(samples.map((sample) => sample.availableMemoryBytes))),
  availableMemoryLowestBytes: Math.min(
    ...samples.map((sample) => sample.availableMemoryLowestBytes),
  ),
  cpuAveragePercent: mean(samples.map((sample) => sample.cpuAveragePercent)),
  cpuPeakPercent: Math.max(...samples.map((sample) => sample.cpuPeakPercent)),
  sessionsRunning: Math.max(...samples.map((sample) => sample.sessionsRunning)),
  sessionsQueued: Math.max(...samples.map((sample) => sample.sessionsQueued)),
});

/**
 * Groups the samples that start at or after `from` into points of `spanMs`,
 * which start on multiples of `spanMs`. The caller passes a `from` that is such
 * a multiple, so every point is whole at its start.
 */
const buildPoints = (
  runnerId: string,
  samples: readonly Sample[],
  from: number,
  spanMs: number,
): RunnerMetricsPoint[] => {
  const byStart = new Map<number, Sample[]>();
  for (const sample of samples) {
    if (sample.at < from) continue;
    const start = Math.floor(sample.at / spanMs) * spanMs;
    byStart.set(start, [...(byStart.get(start) ?? []), sample]);
  }
  return [...byStart].map(([start, inSpan]) => buildPoint(runnerId, start, inSpan));
};

/** Returns the start of the first span of `spanMs` that starts at or after `rangeMs` before the clock. */
const findFirstSpanStart = (rangeMs: number, spanMs: number): number =>
  Math.ceil((SPECIMEN_NOW - rangeMs) / spanMs) * spanMs;

/**
 * Builds the history of a machine as `runnerMetrics.query` returns it: the
 * five-minute points of the last 24 hours and the hour points of the last 14
 * days, each read at the specimen's clock.
 */
export const buildMachineMetrics = (story: MachineStory): MachineMetrics => {
  const samples = buildSamples(story);
  return {
    fiveMinutes: {
      points: buildPoints(
        story.runnerId,
        samples,
        findFirstSpanStart(FIVE_MINUTE_HISTORY_MS, FIVE_MINUTES_MS),
        FIVE_MINUTES_MS,
      ),
      readAt: SPECIMEN_NOW,
    },
    hours: {
      points: buildPoints(
        story.runnerId,
        samples,
        findFirstSpanStart(HOUR_HISTORY_MS, HOUR_MS),
        HOUR_MS,
      ),
      readAt: SPECIMEN_NOW,
    },
  };
};
