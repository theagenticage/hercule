/**
 * The delivery of the inputs a session holds: every queued input nothing has
 * sent yet to the session it was stored for, whoever wrote it.
 *
 * It reads the rows rather than remembering what anything just wrote, so a row
 * that outlived the attempt to deliver it - a controller killed between the
 * commit and the send, a machine that refused the frame, a session that was
 * busy and whose transition to idle was missed - is picked up by the next tick
 * instead of waiting for ever. A match is not special here: an input a person
 * typed is owed to its session in the same way.
 *
 * One fiber per session: a delivery waits on a machine, and a machine that is
 * slow to answer must not hold up the sessions behind it or the next tick. The
 * fibers are children of the pipeline's own driver, which lives as long as the
 * controller does.
 */
import * as Effect from "effect/Effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { SessionService } from "../../sessions";
import type { Delivery } from "../event-router";
import { forking } from "../absorbing";
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
            yield* forking(
              "A session could not be given what it was waiting for",
              live.deliverQueuedInput(sessionId),
            );
          }
        }),
    };
  });
