/**
 * The controller daemon's implementation of the assistants domain's
 * `AssistantSessions` port: starting, feeding and stopping the sessions that
 * answer an assistant's conversations.
 *
 * It holds no rule about assistants. Placement, the live session operations
 * and the resume check do the work; this file only runs their frame-sending
 * part after the caller's transaction commits, and waits for a stopped
 * session to exit.
 */
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { createInvalidStateError, InvalidState, NotFound } from "@hercule/contract";
import { AssistantSessions } from "../../assistants";
import { afterCommit } from "../../db";
import { runnerRepository } from "../../runners";
import { sessionRepository } from "../../sessions";
import type { WorkspaceService } from "../../workspaces";
import { absorbFailures } from "../absorbing";
import { Live } from "./live";
import { Placement } from "./placement";

const ASSISTANT_STOP_DEADLINE: Duration.Duration = Duration.seconds(30);

/**
 * How long `stop` waits for a session to exit: the stop deadline. Tests
 * replace it with a shorter one, so a test of the timeout does not wait for
 * the real one.
 */
export const AssistantStopDeadline = Context.Reference<Duration.Duration>(
  "hercule/controller/daemon/AssistantStopDeadline",
  { defaultValue: (): Duration.Duration => ASSISTANT_STOP_DEADLINE },
);

/**
 * How often `stop` reads the session again while it waits for the exit. The
 * controller has no in-process signal for a session's exit to wait on: the
 * exit is a row written by the report from the runner, so the row is read.
 */
const STOP_POLL_INTERVAL = Duration.millis(250);

const make = Effect.gen(function* () {
  const rows = yield* sessionRepository;
  const runners = yield* runnerRepository;
  const placement = yield* Placement;
  const live = yield* Live;
  // Runs the frame-sending half of a start or a give on a fiber of this
  // layer, not of the request. The request's context holds its transaction's
  // connection, which is gone by the time the frames are sent.
  const fork = yield* FiberSet.makeRuntime<never>();

  /**
   * Schedules `send` to run once the caller's transaction commits, and not at
   * all if it rolls back. A failure is logged, not returned: the caller's
   * write is already durable, and the dispatch and flush passes retry.
   */
  const sendAfterCommit = (
    failureMessage: string,
    send: Effect.Effect<void, unknown>,
  ): Effect.Effect<void> =>
    afterCommit(() => {
      // The fiber yields first, so the request that stored the rows is
      // answered before the runner is told anything.
      fork(Effect.andThen(Effect.yieldNow, absorbFailures(failureMessage, send)));
    });

  /**
   * Fails with `InvalidState` naming the session's runner, for a stop the
   * runner did not confirm.
   */
  const failStopNotConfirmed = (runnerId: string): Effect.Effect<never, InvalidState | SqlError> =>
    Effect.flatMap(runners.read(runnerId), (runner) =>
      Effect.fail(
        createInvalidStateError(
          "the assistant's session did not stop; try again when runner " +
            `${Option.isSome(runner) ? runner.value.name : runnerId} is reachable`,
        ),
      ),
    );

  /** Waits until the session has exited, reading it every quarter second. */
  const waitForExit = (sessionId: string): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      while (true) {
        const found = yield* rows.one(sessionId);
        if (Option.isNone(found) || found.value.status === "exited") return;
        yield* Effect.sleep(STOP_POLL_INTERVAL);
      }
    });

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
        const stopped = yield* Effect.catchIf(
          live.stopSession(session),
          (error): error is NotFound => error instanceof NotFound,
          // The session was read just above, and sessions are never deleted.
          (error) => Effect.die(error),
        );
        // A queued session has no harness yet, so it has ended already, by
        // this stop or by something else before it.
        if (stopped === "ended" || stopped === "exited") return;
        if (stopped === "unreachable") return yield* failStopNotConfirmed(session.runnerId);
        const exited = yield* Effect.timeoutOption(
          waitForExit(sessionId),
          yield* AssistantStopDeadline,
        );
        if (Option.isNone(exited)) return yield* failStopNotConfirmed(session.runnerId);
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
  SqlClient.SqlClient | WorkspaceService | Placement | Live
> = Layer.effect(AssistantSessions)(make);
