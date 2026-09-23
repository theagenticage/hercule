/**
 * The headroom a runner has left. Unlike the facts this moves, so it is reported
 * every minute whether it changed or not, and never buffered: only the latest
 * reading is worth anything. The disk is handed in because a test cannot fill one.
 */
import { freemem } from "node:os";
import { statfs } from "node:fs/promises";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { RunnerWatermark } from "@hercule/protocol";

export const WATERMARK_INTERVAL: Duration.Duration = Duration.seconds(60);

/** For the filesystem the given path sits on. */
export const readMachineHeadroom = (
  path: string,
): Effect.Effect<RunnerWatermark, Cause.UnknownError> =>
  Effect.map(
    Effect.tryPromise(() => statfs(path)),
    (stats) => ({
      // What an ordinary user may still write, which is what a session is.
      diskFreeBytes: stats.bavail * stats.bsize,
      availableMemoryBytes: freemem(),
    }),
  );

export interface WatermarkCheck<E> {
  readonly read: Effect.Effect<RunnerWatermark, Cause.UnknownError>;
  readonly send: (watermark: RunnerWatermark) => Effect.Effect<void, E>;
}

/**
 * Reports at once, which keeps a runner that has just said hello from looking
 * like a machine with an unknown disk for a minute. A reading nobody could take
 * is skipped: sending zero free bytes would retire the machine over one call.
 *
 * Whether a reading means the machine can take work is the controller's to
 * decide, against the watermark it holds; the runner only reports what the
 * machine has left.
 */
export const reportWatermark = <E>(check: WatermarkCheck<E>): Effect.Effect<never, E> =>
  Effect.gen(function* () {
    while (true) {
      const headroom = yield* Effect.option(
        Effect.tapCause(check.read, (cause) =>
          Effect.logWarning("A runner could not read what its machine has left", cause),
        ),
      );
      if (Option.isSome(headroom)) yield* check.send(headroom.value);
      yield* Effect.sleep(WATERMARK_INTERVAL);
    }
  });
