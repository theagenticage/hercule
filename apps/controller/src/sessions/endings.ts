/**
 * The port through which the sessions domain tells another domain that a
 * session has ended.
 *
 * It is declared here, in the sessions domain's own words ("this session
 * ended, for this reason"), and implemented by the domain that cares, so this
 * domain never imports that domain. Boot provides the implementation.
 *
 * Every path that moves a session to `exited` goes through
 * `SessionService`'s one cleanup step, and that step calls this port. So an
 * ending path added later reaches the port without anyone remembering to call
 * it.
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { ExitReason } from "@hercule/protocol";
import type { StoredInput } from "./inputs";
import type { StoredSession } from "./repository";

/**
 * Why a session ended. It is the runner's exit reason when a runner reported
 * the exit, or one of the controller's own reasons when the controller ended
 * the session without a report:
 *
 * - `runner_retired`: its runner was retired;
 * - `runner_lost`: its runner was not heard from for longer than the
 *   session's absolute timeout.
 */
export type SessionEndReason = ExitReason | "runner_retired" | "runner_lost";

/** One session that has just ended. */
export interface SessionEnding {
  /** The session as it was just before it ended. */
  readonly session: StoredSession;
  readonly reason: SessionEndReason;
  /** The runner's error message, for a workspace that could not be made; absent otherwise. */
  readonly message?: string;
  /**
   * The session's inputs that no turn has started from when it ended:
   *
   * - every input still queued, sent to the runner or not, oldest first;
   * - then every input the runner accepted as the start of a new turn whose
   *   `turn.started` the stored stream does not show yet.
   */
  readonly unansweredInputs: ReadonlyArray<StoredInput>;
}

/** The party told about every session that ends. */
export class SessionEndings extends Context.Service<
  SessionEndings,
  {
    /**
     * Handles one session that has just ended. It runs inside the transaction
     * that ended the session, before that transaction cancels the session's
     * waiting inputs, so a failure rolls the ending back. It must not wait on
     * anything outside the database.
     */
    readonly sessionEnded: (ending: SessionEnding) => Effect.Effect<void, SqlError>;
  }
>()("hercule/controller/sessions/SessionEndings") {}
