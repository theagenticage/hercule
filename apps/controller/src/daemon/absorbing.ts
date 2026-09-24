/**
 * Helpers a driver uses to run each item so that one failing item does not
 * stop the driver.
 *
 * A driver is a loop that runs for the life of the process, such as the event
 * pipeline or a periodic sweep. If one item fails, the driver logs the cause
 * and moves on. This applies to defects as well as failures: otherwise a bug in
 * handling one item would silently stop the driver for the rest of the
 * process, for every runner. A cause that contains an interrupt means the
 * driver itself is being stopped, so it is passed on unchanged and nothing in
 * it is lost.
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
 * Runs `effect` on its own fiber, and logs its failure like `absorbFailures`.
 * Returns as soon as the fiber is started.
 *
 * Use this for work that waits on a runner, such as a dispatch or a flush, so
 * that the wait does not hold up the next item.
 */
export const forkAndAbsorbFailures = <E>(
  what: string,
  effect: Effect.Effect<void, E>,
): Effect.Effect<void> => Effect.asVoid(Effect.forkChild(absorbFailures(what, effect)));
