/**
 * Helpers a driver uses to run each item so that one failing item does not
 * stop the driver.
 *
 * A driver is a loop that runs for the life of the process, such as the event
 * pipeline or a periodic sweep. If one item fails, the driver logs the cause
 * and moves on. This applies to defects as well as failures: otherwise a bug in
 * handling one item would silently stop the driver for the rest of the
 * process, for every runner. A cause that contains an interrupt means the
 * driver itself is being stopped, so it is passed on and nothing in it is
 * lost.
 */
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";

/**
 * Runs `effect`, and logs its failure with `failureMessage` instead of
 * passing it on. Never fails: an interrupt is passed on with the rest of its
 * cause, where each failure that came with the interrupt becomes a defect, so
 * the caller has no error left to handle.
 */
export const absorbFailures = <E, R = never>(
  failureMessage: string,
  effect: Effect.Effect<void, E, R>,
): Effect.Effect<void, never, R> =>
  Effect.catchCause(effect, (cause) =>
    Cause.hasInterrupts(cause)
      ? Effect.failCause(
          Cause.fromReasons(
            cause.reasons.map((reason) =>
              Cause.isFailReason(reason) ? Cause.makeDieReason(reason.error) : reason,
            ),
          ),
        )
      : Effect.logError(failureMessage, cause),
  );

/**
 * Runs `effect` on its own fiber, and logs its failure like `absorbFailures`.
 * Returns as soon as the fiber is started.
 *
 * Use this for work that waits on a runner, such as a dispatch or a flush, so
 * that the wait does not hold up the next item.
 */
export const forkAndAbsorbFailures = <E, R = never>(
  failureMessage: string,
  effect: Effect.Effect<void, E, R>,
): Effect.Effect<void, never, R> =>
  Effect.asVoid(Effect.forkChild(absorbFailures(failureMessage, effect)));
