/**
 * The port through which the sessions domain tells another domain what its
 * sessions do: what a runner reported, that a session exited, and that input
 * waiting for a session was dropped because it could not be delivered.
 *
 * It is declared here, in the sessions domain's own words, and implemented by
 * the domain that cares, so this domain never imports that domain. Boot
 * provides the implementation.
 *
 * Every method is called by `SessionService` itself, inside the transaction
 * that made the change it reports:
 *
 * - `sessionReported` by the one step that applies a runner's report;
 * - `sessionExited` by the one cleanup step every path to `exited` goes
 *   through, so an exit path added later reaches the port without anyone
 *   remembering to call it;
 * - `inputsDropped` by the steps that give up on waiting input: the one
 *   that drops the input of a session that cannot be resumed, and the one
 *   that cancels an input the runner refused after its session exited for
 *   good.
 *
 * `sessionExited` and `inputsDropped` both name the agent step prompts that
 * were cancelled before any runner took them (`droppedStepIterations`). A
 * step prompt that left the controller and was never answered is not among
 * them: the runner may have taken it, so only the runner's answer about the
 * step settles the step.
 *
 * So a failure in the implementation rolls the change back, and the
 * implementation must not wait on anything outside the database.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { ExitReason, ProviderEvent } from "@hercule/protocol";
import type { StoredSession } from "./repository";

/**
 * Why a session exited. It is the runner's exit reason when a runner reported
 * the exit, or one of the controller's own reasons when the controller ended
 * the session without a report:
 *
 * - `runner_retired`: its runner was retired;
 * - `runner_lost`: its runner was not heard from for longer than the
 *   session's absolute timeout.
 */
export type SessionEndReason = ExitReason | "runner_retired" | "runner_lost";

/** One session that has just exited. */
export interface SessionExit {
  /** The session as it was just before it exited, so `status` is the status it exited from. */
  readonly session: StoredSession;
  readonly reason: SessionEndReason;
  /**
   * `true` when the crash-loop guard now holds the session back from an
   * automatic resume (`isResumeHeld`): it was resumed for input that still
   * waits, and it exited before it started a turn. The input waits until
   * someone sends more.
   */
  readonly resumeHeld: boolean;
  /**
   * The iterations of the session's agent step whose prompts this exit
   * cancelled before any runner took them. Empty for a session no agent
   * step started, and for one that keeps its step prompt through the exit.
   */
  readonly droppedStepIterations: ReadonlyArray<number>;
}

/**
 * Input that waited for an exited session and was cancelled: the session
 * cannot be resumed, or the runner refused the input after the session
 * exited for good.
 */
export interface DroppedInputs {
  /** The exited session the input waited for. */
  readonly session: StoredSession;
  /** The reason the input could not be delivered. */
  readonly refusal: string;
  /**
   * The iterations of the session's agent step whose prompts were among the
   * cancelled input. No runner took them.
   */
  readonly droppedStepIterations: ReadonlyArray<number>;
}

/** The party told about what every session does. */
export class SessionObserver extends Context.Service<
  SessionObserver,
  {
    /**
     * Handles one runner report about a session's own agent. It runs after
     * the report's transcript rows are written, so it can read them.
     *
     * An event attributed to a subagent is never passed here: a subagent's
     * work changes nothing the session's own agent owns, such as an
     * assistant's reply (spec 06 section 13.1).
     */
    readonly sessionReported: (
      session: StoredSession,
      event: ProviderEvent,
    ) => Effect.Effect<void, SqlError>;
    /**
     * Handles one session that has just exited, whatever the reason, an idle
     * unload included.
     */
    readonly sessionExited: (exit: SessionExit) => Effect.Effect<void, SqlError>;
    /** Handles input that waited for an exited session and was cancelled. */
    readonly inputsDropped: (dropped: DroppedInputs) => Effect.Effect<void, SqlError>;
  }
>()("hercule/controller/sessions/SessionObserver") {}

/**
 * Returns one observer that passes every call to each of `observers` in turn,
 * so more than one domain can watch the sessions through the one port. The
 * calls run in the order given, and the first failure stops the rest, which
 * rolls back the change being reported.
 */
export const combineSessionObservers = (
  observers: ReadonlyArray<SessionObserver["Service"]>,
): SessionObserver["Service"] =>
  SessionObserver.of({
    sessionReported: (session, event) =>
      Effect.forEach(observers, (one) => one.sessionReported(session, event), { discard: true }),
    sessionExited: (exit) =>
      Effect.forEach(observers, (one) => one.sessionExited(exit), { discard: true }),
    inputsDropped: (dropped) =>
      Effect.forEach(observers, (one) => one.inputsDropped(dropped), { discard: true }),
  });
