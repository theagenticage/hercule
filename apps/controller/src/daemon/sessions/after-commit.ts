/**
 * Runs the frame-sending half of an operation once the caller's transaction
 * commits. The rows the frames are about are durable by then, and a
 * transaction never waits on a runner.
 */
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import type * as Scope from "effect/Scope";
import { CurrentActor } from "../../actor";
import { afterCommit } from "../../db";
import { absorbFailures } from "../absorbing";

/**
 * Makes a function that schedules an effect to run once the caller's
 * transaction commits, and not at all if it rolls back. Outside any
 * transaction the effect is scheduled at once.
 *
 * The effect runs on a fiber of the layer that makes the function, not of the
 * request, because the request's context holds its transaction's connection,
 * which is gone by the time the effect runs. The fiber still runs as the
 * request's actor, so the audit entries the effect writes, such as a stop's,
 * name the person who asked for it.
 *
 * The fiber does not run inside the caller's admission by the promotion
 * gate, because the caller may already have finished. So an effect that
 * writes to the database passes the gate itself (`PromotionState`), as
 * `Live.stopSession` does. An effect that only sends a frame does not
 * need to.
 *
 * A failure is logged with `failureMessage`, not returned, because the
 * caller's write is already durable and the caller has returned. Whether
 * anything tries again is up to the caller: queued input and a queued session
 * wait for the next flush or dispatch pass, while a frame from
 * `writeThenTellRunner` is not sent again.
 */
export const makeForkAfterCommit: Effect.Effect<
  (failureMessage: string, effect: Effect.Effect<void, unknown>) => Effect.Effect<void>,
  never,
  Scope.Scope
> = Effect.map(
  FiberSet.makeRuntime<never>(),
  (fork) => (failureMessage, effect) =>
    Effect.flatMap(CurrentActor, (actor) =>
      afterCommit(() => {
        // The fiber yields first, so the request that stored the rows is
        // answered before the runner is told anything.
        fork(
          Effect.andThen(
            Effect.yieldNow,
            absorbFailures(failureMessage, Effect.provideService(effect, CurrentActor, actor)),
          ),
        );
      }),
    ),
);
