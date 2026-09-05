/**
 * The headroom a runner has left, and what it means for placement.
 *
 * Unlike the facts, this moves: a disk fills while sessions run on it, so it is
 * read every minute and reported every minute whether it changed or not. Only
 * the latest reading is worth anything, which is why it is never buffered and
 * why a connection that has gone drops what it was about to say.
 *
 * The disk is handed in for the same reason the probe's machine is: a test
 * cannot fill one.
 */
import { freemem } from "node:os";
import { statfs } from "node:fs/promises";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { RunnerWatermark } from "@hydra/protocol";

/**
 * Below this much free disk a runner stops accepting placements. Ten gibibytes
 * is room for a checkout and the build it needs, with enough left that the
 * machine itself keeps working.
 */
export const DISK_WATERMARK_BYTES = 10 * 1024 * 1024 * 1024;

/** How often a connected runner reports what it has left. */
export const WATERMARK_INTERVAL: Duration.Duration = Duration.seconds(60);

/** What the machine has left, as the machine reports it. */
export interface Headroom {
  readonly diskFreeBytes: number;
  readonly availableMemoryBytes: number;
}

/** What this machine has left, for the filesystem the given path sits on. */
export const machineHeadroom = (path: string): Effect.Effect<Headroom, Cause.UnknownError> =>
  Effect.map(
    Effect.tryPromise(() => statfs(path)),
    (stats) => ({
      // What an ordinary user may still write, which is what a session is.
      diskFreeBytes: stats.bavail * stats.bsize,
      availableMemoryBytes: freemem(),
    }),
  );

/**
 * What a reading means. Only the disk decides: a machine short of memory runs
 * fewer sessions at once, which is the session cap's business, but a machine
 * out of disk cannot check anything out at all.
 */
export const watermarkOf = (headroom: Headroom): RunnerWatermark => ({
  ...headroom,
  acceptingPlacements: headroom.diskFreeBytes >= DISK_WATERMARK_BYTES,
});

/** What the check needs to do its work. */
export interface WatermarkCheck<E> {
  readonly read: Effect.Effect<Headroom, Cause.UnknownError>;
  readonly send: (watermark: RunnerWatermark) => Effect.Effect<void, E>;
}

/**
 * Reports at once and then on the interval, until it is interrupted with the
 * connection it belongs to. Reporting at once is what keeps a runner that has
 * just said hello from looking like a machine with an unknown disk for a
 * minute.
 *
 * A reading nobody could take is skipped rather than reported. Sending zero
 * free bytes would take the machine out of service over one unlucky call.
 */
export const checkWatermark = <E>(check: WatermarkCheck<E>): Effect.Effect<never, E> =>
  Effect.gen(function* () {
    while (true) {
      const headroom = yield* Effect.option(
        Effect.tapCause(check.read, (cause) =>
          Effect.logWarning("A runner could not read what its machine has left", cause),
        ),
      );
      if (Option.isSome(headroom)) yield* check.send(watermarkOf(headroom.value));
      yield* Effect.sleep(WATERMARK_INTERVAL);
    }
  });
