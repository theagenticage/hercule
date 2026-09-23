/**
 * What a driver wraps each item in, and how it hands one off.
 *
 * A driver must not stop on one item, so the cause is logged and dropped - a
 * defect as much as a failure, because a bug applying one report would
 * otherwise take the driver down for the life of the process, silently and for
 * the whole fleet. A cause carrying an interrupt is the driver being stopped
 * and is passed on whole, so nothing that rode along with it is lost.
 */
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";

export const absorbFailures = <E>(
  what: string,
  effect: Effect.Effect<void, E>,
): Effect.Effect<void, E> =>
  Effect.catchCause(effect, (cause) =>
    Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.logError(what, cause),
  );

/**
 * One item run on a fiber of its own, still absorbing its own failure: what
 * waits on a machine - a dispatch, a flush, a machine told what it owes - must
 * not hold up the next item behind it.
 */
export const forkAndAbsorbFailures = <E>(
  what: string,
  effect: Effect.Effect<void, E>,
): Effect.Effect<void> => Effect.asVoid(Effect.forkChild(absorbFailures(what, effect)));
