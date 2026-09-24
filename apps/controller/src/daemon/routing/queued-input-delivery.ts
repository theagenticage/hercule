/**
 * The delivery of queued inputs: sends every queued input that has not been
 * sent yet to its session, whoever wrote it.
 *
 * It reads the rows instead of remembering what was just written. So an input
 * whose delivery attempt failed is picked up by the next tick instead of
 * waiting forever. For example:
 *
 * - the controller was killed between the commit and the send;
 * - the runner rejected the frame;
 * - the session was busy, and its change to idle was missed.
 *
 * Inputs from a subscription match and inputs a person typed are delivered in
 * the same way.
 *
 * Each session gets its own fiber, because a delivery waits on a runner, and a
 * slow runner must not hold up other sessions or the next tick. The fibers are
 * children of the pipeline's driver, which lives as long as the controller.
 */
import * as Effect from "effect/Effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { SessionService } from "../../sessions";
import type { Delivery } from "../event-router";
import { forkAndAbsorbFailures } from "../absorbing";
import { Live } from "../live";

export const queuedInputDelivery: Effect.Effect<Delivery, never, SessionService | Live> =
  Effect.gen(function* () {
    const sessions = yield* SessionService;
    const live = yield* Live;

    return {
      name: "queued inputs",
      deliverWaiting: (): Effect.Effect<void, SqlError> =>
        Effect.gen(function* () {
          for (const sessionId of yield* sessions.listSessionsAwaitingInput()) {
            yield* forkAndAbsorbFailures(
              "Delivering queued input to a session failed",
              live.deliverQueuedInput(sessionId),
            );
          }
        }),
    };
  });
