/**
 * The port through which an assistant's conversation sessions are started,
 * given input and stopped.
 *
 * It is declared here, in the assistants domain's words, and implemented by
 * the controller daemon, because only the controller daemon sends frames to
 * runners. The assistants domain decides whether to start a session or give
 * one input; the implementation only does the work that reaches a runner.
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { Forbidden, InvalidState, Unauthenticated, Validation } from "@hercule/contract";
import type { GrantsError } from "../permissions";
import type { SettingError } from "../settings";

/** Everything placement can refuse a new session with. */
type StartError =
  | Unauthenticated
  | Forbidden
  | Validation
  | InvalidState
  | GrantsError
  | SettingError
  | SqlError
  | Schema.SchemaError;

export class AssistantSessions extends Context.Service<
  AssistantSessions,
  {
    /**
     * Places a new session for the conversation, as the assistant, with
     * `text` as its first input. Joins the caller's transaction; the start
     * frame goes out after commit. The session is `queued` when its runner is
     * full. Fails with `InvalidState` when no runner can take it.
     */
    readonly start: (request: {
      readonly conversationId: string;
      readonly assistantId: string;
      readonly text: string;
    }) => Effect.Effect<void, StartError>;

    /**
     * Queues `text` as the user's input to the session, and returns whether
     * it did:
     *
     * - `given`: the input is stored. A session that has exited is put back
     *   on the queue in place, to resume its own transcript. The input is
     *   delivered after the caller's transaction commits.
     * - `unresumable`: the session has exited and cannot be resumed, for
     *   example because its runner is draining, so nothing was stored.
     *
     * Joins the caller's transaction, so the resume check and the write see
     * the same rows. A resume runs under the assistant's current access mode
     * and permission profile, so a change to either reaches the session at its
     * next resume. A resume reads the controller settings, the stored spec
     * and the provider, so it can also fail with their errors, and with
     * `InvalidState` when the provider supports no access mode at or below
     * the assistant's.
     */
    readonly give: (request: {
      readonly sessionId: string;
      readonly text: string;
    }) => Effect.Effect<
      "given" | "unresumable",
      InvalidState | Validation | SettingError | SqlError | Schema.SchemaError
    >;

    /**
     * Stops the session and waits until it has exited, at most the stop
     * deadline.
     * A queued session is ended at once, and an exited one is left alone.
     * Must not run inside a transaction, because it waits on the runner.
     * Fails with `InvalidState` naming the runner when the runner is not
     * connected or the session does not exit in time.
     */
    readonly stop: (sessionId: string) => Effect.Effect<void, InvalidState | SqlError>;
  }
>()("hercule/controller/assistants/AssistantSessions") {}
