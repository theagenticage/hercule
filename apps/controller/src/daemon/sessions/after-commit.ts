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
 * request. The request's context holds its transaction's connection, which is
 * gone by the time the effect runs. A failure is logged with the given
 * message, not returned: the caller's write is already durable, and the
 * dispatch and flush passes retry.
 *
 * The forked fiber does not inherit the request's context, so the actor
 * behind the request is carried over explicitly. The audit entries the effect
 * writes, such as a stop's, name the person who asked for it.
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
