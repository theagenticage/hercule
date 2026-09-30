/**
 * The controller daemon's implementation of the assistants domain's
 * `AssistantSessions` port: starting, feeding and stopping the sessions that
 * answer an assistant's conversations.
 *
 * It holds no rule about assistants. Placement and the live session
 * operations do the work; this file only runs their frame-sending part after
 * the caller's transaction commits.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { NotFound } from "@hercule/contract";
import { AssistantSessions } from "../../assistants";
import { sessionRepository } from "../../sessions";
import { makeForkAfterCommit } from "./after-commit";
import { Live } from "./live";
import { Placement } from "./placement";

const make = Effect.gen(function* () {
  const rows = yield* sessionRepository;
  const placement = yield* Placement;
  const live = yield* Live;
  // Runs the frame-sending half of a start, a give or a stop once the
  // caller's transaction commits.
  const sendAfterCommit = yield* makeForkAfterCommit;

  return AssistantSessions.of({
    start: (request) =>
      Effect.gen(function* () {
        const send = yield* Effect.catchIf(
          placement.placeConversationSession(request),
          (error): error is NotFound => error instanceof NotFound,
          // The caller read the conversation in this transaction, and an
          // assistant's agent row is deleted in the same transaction as its
          // conversations, so the agent row exists.
          (error) => Effect.die(error),
        );
        yield* sendAfterCommit("Could not start an assistant's session", send);
      }),

    give: (request) =>
      Effect.gen(function* () {
        const deliver = yield* Effect.catchIf(
          live.queueConversationInput(request.sessionId, request.text),
          (error): error is NotFound => error instanceof NotFound,
          // The caller read the session in this transaction, and sessions are
          // never deleted.
          (error) => Effect.die(error),
        );
        if (Option.isNone(deliver)) return "unresumable" as const;
        yield* sendAfterCommit("Could not deliver input to an assistant's session", deliver.value);
        return "given" as const;
      }),

    stop: (sessionId) =>
      Effect.gen(function* () {
        const found = yield* rows.one(sessionId);
        if (Option.isNone(found) || found.value.status === "exited") return;
        const session = found.value;
        yield* sendAfterCommit(
          "Could not stop an assistant's session",
          Effect.flatMap(live.stopSession(session), (stopped) =>
            stopped === "unreachable"
              ? Effect.logWarning(
                  "An assistant's session was not stopped: its runner is not connected",
                  { sessionId, runnerId: session.runnerId },
                )
              : Effect.void,
          ),
        );
      }),
  });
});

/**
 * Implements the assistants domain's `AssistantSessions` port. Boot provides
 * it; nothing else in the controller uses it directly.
 */
export const AssistantSessionsLayer: Layer.Layer<
  AssistantSessions,
  never,
  SqlClient.SqlClient | Placement | Live
> = Layer.effect(AssistantSessions)(make);
