/**
 * Measures how busy the machine's processors are, for the Runner Metrics.
 *
 * The runner reads the kernel's cumulative CPU counters once a second and
 * reports the minute's average and highest read. A reading is the share of all
 * cores that were busy since the previous reading. Reading the counters starts
 * no process. A minute keeps only a sum, a count and the highest reading, so a
 * minute costs the same memory however many reads it holds.
 *
 * The counters are passed in, so a test can feed a known sequence.
 */
import { cpus } from "node:os";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";

/** The processors' cumulative counters, in kernel ticks, summed over all cores. */
export interface CpuTimes {
  readonly busyTicks: number;
  readonly totalTicks: number;
}

/**
 * The CPU use over one minute. Both values are percentages from 0 to 100 and
 * are rounded to one decimal.
 */
export interface RunnerCpu {
  readonly averagePercent: number;
  readonly peakPercent: number;
}

/** What one minute has collected so far. */
export interface CpuMinute {
  readonly sumPercent: number;
  readonly reads: number;
  readonly peakPercent: number;
}

export const CPU_READ_INTERVAL: Duration.Duration = Duration.seconds(1);

export const EMPTY_CPU_MINUTE: CpuMinute = { sumPercent: 0, reads: 0, peakPercent: 0 };

/**
 * Returns the cumulative counters of all cores added together. Busy is user,
 * nice, system and interrupt time; total is busy plus idle time.
 */
export const readMachineCpuTimes = (): CpuTimes => {
  let busyTicks = 0;
  let totalTicks = 0;
  for (const { times } of cpus()) {
    const busy = times.user + times.nice + times.sys + times.irq;
    busyTicks += busy;
    totalTicks += busy + times.idle;
  }
  return { busyTicks, totalTicks };
};

/**
 * Returns the share of all cores that were busy between two readings, from 0
 * to 100. Returns `undefined` when there is nothing to measure: a counter went
 * backwards (a reset, or cores that went offline) or no ticks passed.
 */
export const measureBusyPercent = (previous: CpuTimes, next: CpuTimes): number | undefined => {
  const busy = next.busyTicks - previous.busyTicks;
  const total = next.totalTicks - previous.totalTicks;
  if (busy < 0 || total <= 0) return undefined;
  return Math.min(100, (busy / total) * 100);
};

/** Returns the minute with one more reading in it. */
export const addCpuRead = (minute: CpuMinute, percent: number): CpuMinute => ({
  sumPercent: minute.sumPercent + percent,
  reads: minute.reads + 1,
  peakPercent: Math.max(minute.peakPercent, percent),
});

const roundToOneDecimal = (value: number): number => Math.round(value * 10) / 10;

/** Returns the minute's average and highest reading, or `null` when the minute holds no reading. */
export const summarizeCpuMinute = (minute: CpuMinute): RunnerCpu | null =>
  minute.reads === 0
    ? null
    : {
        averagePercent: roundToOneDecimal(minute.sumPercent / minute.reads),
        peakPercent: roundToOneDecimal(minute.peakPercent),
      };

export interface CpuSampler {
  /**
   * Returns the CPU use since the previous call, or since the sampler started,
   * and starts a new minute. Returns `null` when no reading was made in that
   * time. A reading that lands while this runs is counted in exactly one minute.
   */
  readonly takeMinute: Effect.Effect<RunnerCpu | null>;
}

interface SamplerState {
  readonly previous: CpuTimes;
  readonly minute: CpuMinute;
}

/**
 * Reads the counters at once as a baseline, then every second until the
 * enclosing scope closes. The first reading to count is the second one,
 * because a reading is the change since the one before it.
 */
export const startCpuSampler = (
  readCpuTimes: () => CpuTimes = readMachineCpuTimes,
): Effect.Effect<CpuSampler, never, Scope.Scope> =>
  Effect.gen(function* () {
    const state = yield* Ref.make<SamplerState>({
      previous: readCpuTimes(),
      minute: EMPTY_CPU_MINUTE,
    });

    const read = Ref.update(state, ({ previous, minute }) => {
      const next = readCpuTimes();
      const percent = measureBusyPercent(previous, next);
      // The new counters become the baseline even when the read is skipped,
      // so one bad step does not spoil the reads after it.
      return {
        previous: next,
        minute: percent === undefined ? minute : addCpuRead(minute, percent),
      };
    });

    yield* Effect.forkScoped(Effect.forever(Effect.andThen(Effect.sleep(CPU_READ_INTERVAL), read)));

    return {
      takeMinute: Ref.modify(state, ({ previous, minute }) => [
        summarizeCpuMinute(minute),
        { previous, minute: EMPTY_CPU_MINUTE },
      ]),
    };
  });
