/**
 * Reports the Runner Metrics: the free disk, the available memory and the CPU
 * use of the machine. Unlike the runner's facts, the metrics change all the
 * time. So they are reported every minute whether they changed or not, and
 * never buffered, because only the latest report matters. A workspace removal
 * frees disk space the user is waiting to see, so it also asks for a report
 * sooner than the minute. What is read is passed in so a test can fake a full
 * disk or a busy machine.
 */
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import type { RunnerCpu, RunnerMetrics } from "@hercule/protocol";
import { readAvailableMemoryBytes } from "./available-memory";
import { readDiskSpace } from "./disk";
import { startCpuSampler, type CpuTimes } from "./machine-cpu";

export const METRICS_INTERVAL: Duration.Duration = Duration.seconds(60);

/**
 * The longest a workspace removal waits for its report: a removal that ends is
 * reported within this time, and a bulk cleanup that removes workspaces one
 * after the other is reported at most once in this time. The controller keeps
 * one row per minute, so a faster rhythm would only replace the same row.
 */
export const REMOVAL_REPORT_DELAY: Duration.Duration = Duration.seconds(5);

/**
 * The longest the disk and memory read may take. A `vm_stat` that never exits
 * or a `statfs` on a dead mount would otherwise block the reports for good.
 */
export const DISK_AND_MEMORY_TIMEOUT: Duration.Duration = Duration.seconds(10);

/** The part of the metrics that is read on the spot. The CPU use is collected over the minute instead. */
export type DiskAndMemory = Omit<RunnerMetrics, "cpu">;

/**
 * Reads the free space of the file system that holds the runner's storage
 * directory, and the memory the operating system can give a new process.
 * Fails when either cannot be read.
 */
export const readDiskAndMemory = (
  storageDir: string,
): Effect.Effect<DiskAndMemory, Cause.UnknownError> =>
  Effect.map(
    Effect.all([readDiskSpace(storageDir), readAvailableMemoryBytes]),
    ([disk, availableMemoryBytes]) => ({ diskFreeBytes: disk.freeBytes, availableMemoryBytes }),
  );

export interface MetricsCheck<E> {
  readonly readDiskAndMemory: Effect.Effect<DiskAndMemory, Cause.UnknownError>;
  readonly send: (metrics: RunnerMetrics) => Effect.Effect<void, E>;
  /** Reads the machine's CPU counters once a second. A test passes a fake sequence. */
  readonly readCpuTimes?: () => CpuTimes;
  /**
   * Receives a signal each time a workspace removal ends, completed or not,
   * because a removal that failed can have deleted files before it failed. The
   * queue holds at most one signal: signals that arrive together are one. It
   * outlives the connection, so `reportMetrics` drops the signals it finds
   * when it starts: the first report covers them. A test that does not remove
   * workspaces leaves it out.
   */
  readonly workspaceRemovals?: Queue.Dequeue<void>;
}

/**
 * Sends the Runner Metrics at once, then every minute, and sooner after a
 * workspace removal, until interrupted. Sending the first report at once means
 * a runner that has just connected does not spend a minute with an unknown
 * disk.
 *
 * The loop starts a CPU sampler that lives as long as the loop. So the
 * once-a-second CPU reads happen only while the runner is connected, in one
 * timer, and stop when the connection ends. Each round takes the CPU minute
 * first, then reads the disk and memory, then sends. That order gives the
 * report's CPU these properties without any extra bookkeeping:
 *
 * - the first report carries `cpu: null`. The loop takes the minute right
 *   after starting the sampler, which has only its baseline read by then and
 *   no sample, however long the disk and memory read takes;
 * - a report skipped because its read failed drops its own minute, because the
 *   minute was already taken. The next report covers only the minute after it,
 *   never two minutes mixed;
 * - a report's minute ends when its round starts, so the minute is at most
 *   `DISK_AND_MEMORY_TIMEOUT` old when the report is sent.
 *
 * A removal's report is sent within `REMOVAL_REPORT_DELAY` of a signal on
 * `check.workspaceRemovals`, and no sooner than `REMOVAL_REPORT_DELAY` after
 * the report before it. So a bulk cleanup sends one report every
 * `REMOVAL_REPORT_DELAY` at most, never one per removal, and never keeps
 * waiting while more removals come: the wait is counted from the first signal.
 * A removal's report takes no CPU minute, because a minute cut short would
 * average a few seconds and put that in the history as a minute. It repeats the
 * CPU of the report before it, so the periodic report that follows still covers
 * its whole minute. The controller keeps one row per minute and a report in the
 * same minute replaces the row, so the repeated CPU leaves the row as it was
 * when the periodic report of that minute came first, and until the periodic
 * report comes when it did not.
 *
 * A read that fails or takes longer than `DISK_AND_MEMORY_TIMEOUT` is logged
 * and skipped: sending zero free bytes instead would take the machine out of
 * service because of one failed call. The whole report is skipped, even when
 * only the memory read failed, because the protocol requires
 * `availableMemoryBytes` and a made-up value would be wrong. The cost is that
 * while the read keeps failing, the controller keeps the last free disk it was
 * sent and places sessions on it. The warning, once a minute, is how that
 * shows. A removal's report that is skipped is not tried again: the next
 * periodic report is at most a minute away.
 *
 * The controller decides whether a report means the machine can take work,
 * by comparing the free disk with the disk watermark it holds. The runner only
 * reports.
 */
export const reportMetrics = <E>(check: MetricsCheck<E>): Effect.Effect<never, E> =>
  Effect.scoped(
    Effect.gen(function* () {
      const sampler = yield* startCpuSampler(check.readCpuTimes);
      // The periodic loop and the removal loop never read or send at the same
      // time, so the report sent last is the one read last.
      const oneReportAtATime = yield* Semaphore.make(1);
      let lastReportAt = Number.NEGATIVE_INFINITY;
      let lastReportCpu: RunnerCpu | null = null;

      const readAndSend = (cpu: RunnerCpu | null): Effect.Effect<void, E> =>
        oneReportAtATime.withPermits(1)(
          Effect.gen(function* () {
            const diskAndMemory = yield* Effect.option(
              Effect.tapCause(
                Effect.timeout(check.readDiskAndMemory, DISK_AND_MEMORY_TIMEOUT),
                (cause) =>
                  Effect.logWarning(
                    "The runner could not read its free disk space and memory, so it skipped this metrics report",
                    cause,
                  ),
              ),
            );
            if (Option.isNone(diskAndMemory)) return;
            yield* check.send({ ...diskAndMemory.value, cpu });
            lastReportAt = yield* Clock.currentTimeMillis;
            lastReportCpu = cpu;
          }),
        );

      const reportEveryMinute = Effect.gen(function* () {
        while (true) {
          const minute = yield* sampler.takeMinute;
          yield* readAndSend(minute);
          yield* Effect.sleep(METRICS_INTERVAL);
        }
      });

      const workspaceRemovals = check.workspaceRemovals;
      const reportAfterRemovals =
        workspaceRemovals === undefined
          ? Effect.never
          : Effect.gen(function* () {
              // Signals from before this connection are covered by the first report.
              yield* Queue.clear(workspaceRemovals);
              while (true) {
                yield* Queue.take(workspaceRemovals);
                const now = yield* Clock.currentTimeMillis;
                const sendAt = Math.max(
                  now,
                  lastReportAt + Duration.toMillis(REMOVAL_REPORT_DELAY),
                );
                yield* Effect.sleep(Duration.millis(sendAt - now));
                // Removals that ended while this waited are in the report it sends now.
                yield* Queue.clear(workspaceRemovals);
                yield* readAndSend(lastReportCpu);
              }
            });

      return yield* Effect.all([reportEveryMinute, reportAfterRemovals], {
        concurrency: "unbounded",
      }).pipe(Effect.andThen(Effect.never));
    }),
  );
