/**
 * Reports the headroom a runner has left: free disk and available memory.
 * Unlike the runner's facts, headroom changes all the time. So it is reported
 * every minute whether it changed or not, and never buffered, because only the
 * latest reading matters. The reading is passed in so a test can fake a full
 * disk.
 */
import { freemem } from "node:os";
import { statfs } from "node:fs/promises";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { RunnerWatermark } from "@hercule/protocol";

export const WATERMARK_INTERVAL: Duration.Duration = Duration.seconds(60);

/** Reads the free disk space of the filesystem that holds `path`, and the available memory. Fails when `path` cannot be read. */
export const readMachineHeadroom = (
  path: string,
): Effect.Effect<RunnerWatermark, Cause.UnknownError> =>
  Effect.map(
    Effect.tryPromise(() => statfs(path)),
    (stats) => ({
      // `bavail` counts the blocks an unprivileged user may still write, and
      // sessions run as an unprivileged user.
      diskFreeBytes: stats.bavail * stats.bsize,
      availableMemoryBytes: freemem(),
    }),
  );

export interface WatermarkCheck<E> {
  readonly read: Effect.Effect<RunnerWatermark, Cause.UnknownError>;
  readonly send: (watermark: RunnerWatermark) => Effect.Effect<void, E>;
}

/**
 * Sends a headroom reading at once, then every minute, until interrupted.
 * Sending the first reading at once means a runner that has just connected does
 * not spend a minute with an unknown disk. A reading that fails is logged and
 * skipped: sending zero free bytes instead would take the machine out of
 * service because of one failed call.
 *
 * The controller decides whether a reading means the machine can take work,
 * by comparing it with the watermark it holds. The runner only reports.
 */
export const reportWatermark = <E>(check: WatermarkCheck<E>): Effect.Effect<never, E> =>
  Effect.gen(function* () {
    while (true) {
      const headroom = yield* Effect.option(
        Effect.tapCause(check.read, (cause) =>
          Effect.logWarning("The runner could not read its free disk space and memory", cause),
        ),
      );
      if (Option.isSome(headroom)) yield* check.send(headroom.value);
      yield* Effect.sleep(WATERMARK_INTERVAL);
    }
  });
