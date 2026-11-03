/**
 * Reports the Runner Metrics: the free disk and available memory the machine
 * has left. Unlike the runner's facts, the metrics change all the time. So
 * they are reported every minute whether they changed or not, and never
 * buffered, because only the latest reading matters. The reading is passed in
 * so a test can fake a full disk.
 */
import { freemem } from "node:os";
import { statfs } from "node:fs/promises";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { RunnerMetrics } from "@hercule/protocol";

export const METRICS_INTERVAL: Duration.Duration = Duration.seconds(60);

/** Reads the free disk space of the filesystem that holds `path`, and the available memory. Fails when `path` cannot be read. */
export const readRunnerMetrics = (path: string): Effect.Effect<RunnerMetrics, Cause.UnknownError> =>
  Effect.map(
    Effect.tryPromise(() => statfs(path)),
    (stats) => ({
      // `bavail` counts the blocks an unprivileged user may still write, and
      // sessions run as an unprivileged user.
      diskFreeBytes: stats.bavail * stats.bsize,
      availableMemoryBytes: freemem(),
    }),
  );

export interface MetricsCheck<E> {
  readonly read: Effect.Effect<RunnerMetrics, Cause.UnknownError>;
  readonly send: (metrics: RunnerMetrics) => Effect.Effect<void, E>;
}

/**
 * Sends the Runner Metrics at once, then every minute, until interrupted.
 * Sending the first reading at once means a runner that has just connected does
 * not spend a minute with an unknown disk. A reading that fails is logged and
 * skipped: sending zero free bytes instead would take the machine out of
 * service because of one failed call.
 *
 * The controller decides whether a reading means the machine can take work,
 * by comparing the free disk with the disk watermark it holds. The runner only
 * reports.
 */
export const reportMetrics = <E>(check: MetricsCheck<E>): Effect.Effect<never, E> =>
  Effect.gen(function* () {
    while (true) {
      const metrics = yield* Effect.option(
        Effect.tapCause(check.read, (cause) =>
          Effect.logWarning("The runner could not read its free disk space and memory", cause),
        ),
      );
      if (Option.isSome(metrics)) yield* check.send(metrics.value);
      yield* Effect.sleep(METRICS_INTERVAL);
    }
  });
