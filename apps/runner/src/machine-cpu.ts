/**
 * Measures how busy the machine's processors are, for the Runner Metrics.
 *
 * The runner reads the kernel's cumulative CPU counters once a second and
 * reports the minute's average and highest sample. A sample is the share of
 * all cores that were busy since the previous read. Reading the counters starts
 * no process. A minute keeps only a sum, a count and the highest sample, so a
 * minute costs the same memory however many samples it holds.
 *
 * The counters are passed in, so a test can feed a known sequence.
 */
import { readFileSync } from "node:fs";
import { cpus } from "node:os";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import type { RunnerCpu } from "@hercule/protocol";

/** The processors' cumulative counters, in kernel ticks, summed over all cores. */
export interface CpuTimes {
  readonly busyTicks: number;
  readonly totalTicks: number;
}

/** What one minute has collected so far. */
interface CpuMinute {
  readonly sumPercent: number;
  readonly samples: number;
  readonly peakPercent: number;
}

const CPU_READ_INTERVAL: Duration.Duration = Duration.seconds(1);

const EMPTY_CPU_MINUTE: CpuMinute = { sumPercent: 0, samples: 0, peakPercent: 0 };

/**
 * Parses the text of `/proc/stat` on Linux and returns the counters of all
 * cores added together, from its first line, the one that starts with `cpu `.
 * That line is `cpu user nice system idle iowait irq softirq steal guest
 * guest_nice`, in ticks. Throws when the line is missing or has fewer than the
 * first eight numbers.
 *
 * - Busy is user, nice, system, irq, softirq and steal. Steal is time the
 *   hypervisor gave to another virtual machine, which is time this machine
 *   could not use.
 * - Total is busy plus idle and iowait. A core that waits for the disk is not
 *   busy, but it is time that passed.
 * - Guest and guest_nice are left out because the kernel already counts them
 *   inside user and nice.
 */
export const parseProcStatCpuTimes = (text: string): CpuTimes => {
  const line = /^cpu\s+(.*)$/m.exec(text)?.[1];
  const ticks = line?.trim().split(/\s+/).map(Number);
  if (ticks === undefined || ticks.length < 8 || ticks.some((tick) => !Number.isFinite(tick))) {
    throw new Error("/proc/stat has no `cpu` line with eight tick counts");
  }
  const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] =
    ticks;
  const busyTicks = user + nice + system + irq + softirq + steal;
  return { busyTicks, totalTicks: busyTicks + idle + iowait };
};

/**
 * Returns the cumulative counters of all cores added together. Busy and total
 * are as `parseProcStatCpuTimes` defines them on Linux. Elsewhere busy is user,
 * nice, system and interrupt time, and total is busy plus idle time.
 *
 * Linux reads the one summary line of `/proc/stat`. `os.cpus()` would read
 * three files and build an object per core every second, and its times leave
 * out iowait and steal. The read is synchronous on purpose: `/proc` is memory,
 * not disk, so it cannot wait, and the sampler updates its state in one step.
 * Other platforms use `os.cpus()`, which on macOS is one cheap kernel call.
 */
export const readMachineCpuTimes = (): CpuTimes => {
  if (process.platform === "linux")
    return parseProcStatCpuTimes(readFileSync("/proc/stat", "utf8"));
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
 * Returns the share of all cores that were busy between two reads, from 0 to
 * 100. Returns `undefined` when there is nothing to measure: a counter went
 * backwards (a reset, or cores that went offline) or no ticks passed.
 */
const measureBusyPercent = (previous: CpuTimes, next: CpuTimes): number | undefined => {
  const busy = next.busyTicks - previous.busyTicks;
  const total = next.totalTicks - previous.totalTicks;
  if (busy < 0 || total <= 0) return undefined;
  return Math.min(100, (busy / total) * 100);
};

/** Returns the minute with one more sample in it. */
const addCpuSample = (minute: CpuMinute, percent: number): CpuMinute => ({
  sumPercent: minute.sumPercent + percent,
  samples: minute.samples + 1,
  peakPercent: Math.max(minute.peakPercent, percent),
});

const roundToOneDecimal = (value: number): number => Math.round(value * 10) / 10;

/** Returns the minute's average and highest sample, or `null` when the minute holds no sample. */
const summarizeCpuMinute = (minute: CpuMinute): RunnerCpu | null =>
  minute.samples === 0
    ? null
    : {
        averagePercent: roundToOneDecimal(minute.sumPercent / minute.samples),
        peakPercent: roundToOneDecimal(minute.peakPercent),
      };

export interface CpuSampler {
  /**
   * Returns the CPU use since the previous call, or since the sampler started,
   * and starts a new minute. Returns `null` when no sample was made in that
   * time. A sample that lands while this runs is counted in exactly one minute.
   */
  readonly takeMinute: Effect.Effect<RunnerCpu | null>;
}

interface SamplerState {
  /** The counters at the last successful read, or `undefined` before the first one. */
  readonly previous: CpuTimes | undefined;
  readonly minute: CpuMinute;
}

/**
 * Reads the counters at once as a baseline, then every second until the
 * enclosing scope closes. The first sample is the second read, because a
 * sample is the change since the read before it. `readCpuTimes` defaults to
 * the machine's own counters; this is the one place that default lives.
 *
 * A read that throws is skipped, and the sampler goes on with the next second.
 * The first failure of a run of failures is logged as a warning, and the
 * following ones are not, so a counter that stays unreadable does not fill the
 * log. Without that, a failed read would stop the sampler for good and the
 * reports would show "no CPU yet" for ever. A failed read also clears the
 * baseline, so the first read after the failures only sets a fresh baseline and
 * adds no sample. Otherwise its sample would span the whole gap and put time
 * that belongs to earlier minutes into the latest one. Samples already in the
 * current minute are kept.
 */
export const startCpuSampler = (
  readCpuTimes: () => CpuTimes = readMachineCpuTimes,
): Effect.Effect<CpuSampler, never, Scope.Scope> =>
  Effect.gen(function* () {
    const state = yield* Ref.make<SamplerState>({ previous: undefined, minute: EMPTY_CPU_MINUTE });
    let lastReadFailed = false;

    const sample = Effect.matchEffect(Effect.try(readCpuTimes), {
      onFailure: (error) =>
        Effect.suspend(() => {
          const alreadyLogged = lastReadFailed;
          lastReadFailed = true;
          return Effect.andThen(
            Ref.update(state, ({ minute }) => ({ previous: undefined, minute })),
            alreadyLogged
              ? Effect.void
              : Effect.logWarning(
                  "The runner could not read the machine's CPU counters, so it skips CPU samples until it can",
                  error,
                ),
          );
        }),
      onSuccess: (next) =>
        Effect.suspend(() => {
          lastReadFailed = false;
          return Ref.update(state, ({ previous, minute }) => {
            const percent = previous === undefined ? undefined : measureBusyPercent(previous, next);
            // The new counters become the baseline even when the sample is
            // skipped, so one bad step does not spoil the samples after it.
            return {
              previous: next,
              minute: percent === undefined ? minute : addCpuSample(minute, percent),
            };
          });
        }),
    });

    yield* sample;
    yield* Effect.forkScoped(
      Effect.forever(Effect.andThen(Effect.sleep(CPU_READ_INTERVAL), sample)),
    );

    return {
      takeMinute: Ref.modify(state, ({ previous, minute }) => [
        summarizeCpuMinute(minute),
        { previous, minute: EMPTY_CPU_MINUTE },
      ]),
    };
  });
