/**
 * Reports the Runner Metrics: the free disk, the available memory and the CPU
 * use of the machine. Unlike the runner's facts, the metrics change all the
 * time. So they are reported every minute whether they changed or not, and
 * never buffered, because only the latest reading matters. The readings are
 * passed in so a test can fake a full disk or a busy machine.
 */
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { RunnerMetrics } from "@hercule/protocol";
import { readAvailableMemoryBytes } from "./available-memory";
import { readDiskSpace } from "./disk";
import { readMachineCpuTimes, startCpuSampler, type CpuTimes } from "./machine-cpu";

export const METRICS_INTERVAL: Duration.Duration = Duration.seconds(60);

/** The part of the metrics that is read on the spot. The CPU use is collected over the minute instead. */
export type MetricsReading = Omit<RunnerMetrics, "cpu">;

/**
 * Reads the free space of the file system that holds the runner's storage
 * directory, and the memory the operating system can give a new process.
 * Fails when either cannot be read.
 */
export const readRunnerMetrics = (
  storageDir: string,
): Effect.Effect<MetricsReading, Cause.UnknownError> =>
  Effect.map(
    Effect.all([readDiskSpace(storageDir), readAvailableMemoryBytes]),
    ([disk, availableMemoryBytes]) => ({ diskFreeBytes: disk.freeBytes, availableMemoryBytes }),
  );

export interface MetricsCheck<E> {
  readonly read: Effect.Effect<MetricsReading, Cause.UnknownError>;
  readonly send: (metrics: RunnerMetrics) => Effect.Effect<void, E>;
  /** Reads the machine's CPU counters once a second. A test passes a fake sequence. */
  readonly readCpuTimes?: () => CpuTimes;
}

/**
 * Sends the Runner Metrics at once, then every minute, until interrupted.
 * Sending the first reading at once means a runner that has just connected does
 * not spend a minute with an unknown disk.
 *
 * The loop starts a CPU sampler that lives as long as the loop. So the
 * once-a-second CPU reads happen only while the runner is connected, in one
 * timer, and stop when the connection ends. Each report carries the CPU use
 * since the previous report that was sent:
 *
 * - the first report carries `cpu: null`, because no minute has been read yet;
 * - the others carry the minute's average and peak.
 *
 * A reading that fails is logged and skipped: sending zero free bytes instead
 * would take the machine out of service because of one failed call. The whole
 * report is skipped, even when only the memory read failed, because the
 * protocol requires `availableMemoryBytes` and a made-up value would be wrong.
 * The log line, once a minute, is how a persistent failure shows up. The CPU
 * minute is taken only when a report is about to be sent, so a skipped report
 * does not lose it: the next report's CPU covers both minutes.
 *
 * The controller decides whether a reading means the machine can take work,
 * by comparing the free disk with the disk watermark it holds. The runner only
 * reports.
 */
export const reportMetrics = <E>(check: MetricsCheck<E>): Effect.Effect<never, E> =>
  Effect.scoped(
    Effect.gen(function* () {
      const sampler = yield* startCpuSampler(check.readCpuTimes ?? readMachineCpuTimes);
      while (true) {
        const reading = yield* Effect.option(
          Effect.tapCause(check.read, (cause) =>
            Effect.logWarning(
              "The runner could not read its free disk space and memory, so it skipped this metrics report",
              cause,
            ),
          ),
        );
        if (Option.isSome(reading)) {
          // On the first report the sampler has not made its first read yet
          // (it reads one second after it starts), so this is `null` by itself.
          const cpu = yield* sampler.takeMinute;
          yield* check.send({ ...reading.value, cpu });
        }
        yield* Effect.sleep(METRICS_INTERVAL);
      }
    }),
  );
