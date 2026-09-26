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
 * - `inputsDropped` by the one step that gives up on waiting input.
 *
 * So a failure in the implementation rolls the change back, and the
 * implementation must not wait on anything outside the database.
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
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
}

/** Input that waited for an exited session and was cancelled, because the session cannot be resumed. */
export interface DroppedInputs {
  /** The exited session the input waited for. */
  readonly session: StoredSession;
  /** The reason the resume was refused. */
  readonly refusal: string;
}

/** The party told about what every session does. */
export class SessionObserver extends Context.Service<
  SessionObserver,
  {
    /**
     * Handles one runner report about a session. It runs after the report's
     * transcript rows are written, so it can read them.
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
