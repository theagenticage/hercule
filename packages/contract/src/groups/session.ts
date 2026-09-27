/**
 * Sessions: one provider-backed agent conversation, as the API sees it. A
 * caller spawns a session, reads it and sends it input; the only thing a
 * caller can change is its model selection.
 *
 * `requestedAccessMode` and `accessMode` are both on the record because the
 * access-mode fallback of [06-providers section 8.4] must never be silent.
 */
import { Schema } from "effect";
import {
  AccessMode,
  ApprovalDecision,
  Fact,
  ModelSelection,
  OpenRequest,
  OutputSchema,
} from "@hercule/protocol";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import { closedStruct } from "../closed";
import {
  Forbidden,
  Internal,
  InvalidState,
  NotFound,
  Unauthenticated,
  Validation,
} from "../errors";
import { Id, Timestamp } from "../ids";
import { UnenforcedSpecField } from "./agent";
import { Branch } from "./workspace";
import { page, pageParams } from "../pagination";
import { Authenticated } from "../security";
import { atMost, bounded } from "../strings";

/** The request vocabulary comes from the runner protocol; the API returns it unchanged. */
export { ApprovalDecision, OpenRequest };

/** The longest prompt or turn input the API accepts: it is sent to the runner in one frame. */
export const MAX_PROMPT_LENGTH = 64 * 1024;

export const Prompt = bounded(1, MAX_PROMPT_LENGTH);

/**
 * The status of a session:
 *
 * - `queued`: placement accepted it, but the runner is full or unreachable;
 * - `starting`: the start was sent and no `session.started` has come back yet;
 * - `idle`: running, with no turn in progress;
 * - `busy`: a turn is running;
 * - `exited`: the process is gone. An exited session with `resumable` true is
 *   resumed in place by its next input.
 */
export const SESSION_STATUSES = ["queued", "starting", "idle", "busy", "exited"] as const;

export const SessionStatus = Schema.Literals(SESSION_STATUSES);

export type SessionStatus = Schema.Schema.Type<typeof SessionStatus>;

export const Session = Schema.Struct({
  id: Id,
  /** The opening prompt's first non-empty line, capped at 80 characters; set once and never rewritten. */
  title: Schema.String,
  status: SessionStatus,
  /**
   * Computed when the session is read, never stored. True when all of these hold:
   *
   * - the session is `exited` and has a `nativeSessionId`;
   * - its runner is not retired, and its workspace is still ready;
   * - it answered no assistant's conversation, or that conversation still exists.
   *
   * True means the next input resumes it in place.
   */
  resumable: Schema.Boolean,
  /**
   * Computed when the session is read: true when the session exited before
   * its last resume started any turn, inputs wait for it, no input has been
   * stored since that resume, and it could otherwise be resumed (`resumable`).
   * Such a session is not resumed automatically, because it would most likely
   * die the same way again: its input waits, and the next input anyone sends
   * resumes it with all of it (the crash-loop guard, spec 12 section 5.1). An
   * assistant's owner is told with a "can't be reached" notice when the hold
   * starts.
   */
  resumeHeld: Schema.Boolean,
  permissionProfileId: Id,
  /** The Agent this session was spawned from; `null` for a Thread. Kept only as a record of origin. */
  agentId: Schema.NullOr(Id),
  /**
   * The assistant's conversation this session answers; `null` for any other
   * session. Kept after the conversation is deleted, as a record of origin.
   */
  conversationId: Schema.NullOr(Id),
  instanceId: Id,
  /** The runner the session started on. A session never moves to another runner. */
  runnerId: Id,
  workspaceId: Schema.NullOr(Id),
  /** The project the thread belongs to. It only groups the thread; nothing is derived from it. */
  projectId: Schema.NullOr(Id),
  requestedAccessMode: AccessMode,
  /** The mode the session actually runs in, after the access-mode fallback. */
  accessMode: AccessMode,
  /** The provider-native id, once the runner has reported its binding. */
  nativeSessionId: Schema.NullOr(Schema.String),
  /**
   * The model the session runs under now. It starts as the spec's and is
   * updated by `session.update` and by an input that carries a model or
   * options, so a resume or a fork uses the model the conversation ended on
   * rather than the one it started with.
   */
  modelSelection: ModelSelection,
  /** Set where this session was forked off another one; null otherwise. */
  parentSessionId: Schema.NullOr(Id),
  /**
   * The request the harness is parked on, if any: what the user has to answer
   * before this turn can continue. At most one is open at a time, and it is
   * cleared when the machine resolves it or when the turn or session it belongs
   * to ends.
   */
  openRequest: Schema.NullOr(OpenRequest),
  createdAt: Timestamp,
  startedAt: Schema.NullOr(Timestamp),
  /** The time of the last exit. Kept while the session is resumed, and overwritten when it exits again. */
  exitedAt: Schema.NullOr(Timestamp),
  lastActivityAt: Timestamp,
  /**
   * The fields this session was spawned with that its provider ignores.
   * Computed from the instance's declared capabilities every time the session
   * is read.
   */
  unenforced: Schema.Array(UnenforcedSpecField),
});

export type Session = Schema.Schema.Type<typeof Session>;

/** The most repos one thread's workspace may hold. */
export const MAX_SPAWN_CHECKOUTS = 32;

/** One repo a fresh workspace gets a worktree of, and where that worktree starts. */
export const SpawnCheckout = Schema.Struct({
  resourceId: Id,
  /** The branch the thread's own branch starts from; the default branch when absent. */
  baseBranch: Schema.optionalKey(Branch),
});

export type SpawnCheckout = Schema.Schema.Type<typeof SpawnCheckout>;

/** A repo's main workspace. */
export const PrimarySpawnWorkspace = Schema.Struct({
  kind: Schema.Literal("primary"),
  resourceId: Id,
  /** The branch the main workspace is switched to before the harness starts. */
  branch: Schema.optionalKey(Branch),
});

/** A new workspace with a worktree for each repo in `checkouts`. */
export const EphemeralSpawnWorkspace = Schema.Struct({
  kind: Schema.Literal("ephemeral"),
  /** An empty list makes a scratch workspace: a directory with no checkout at all. */
  checkouts: atMost(SpawnCheckout, MAX_SPAWN_CHECKOUTS),
});

/**
 * The workspace a thread opens in: the repo's main workspace, a fresh worktree
 * of its own, or one that already exists. A workspace is a kind and a list of
 * checkouts; every git detail is on a checkout. Without a workspace, the
 * thread has no checkout at all.
 */
export const SpawnWorkspace = Schema.Union([
  PrimarySpawnWorkspace,
  EphemeralSpawnWorkspace,
  Schema.Struct({ kind: Schema.Literal("existing"), workspaceId: Id }),
]);

export type SpawnWorkspace = Schema.Schema.Type<typeof SpawnWorkspace>;

/**
 * The payload of `session.spawn`. A spawn with an `agentId` takes its settings
 * from that Agent. A spawn with no `agentId` is a Thread, and takes the user's
 * `thread.*` settings instead. Either way, a value given here overrides the
 * Agent or the setting, for this session only.
 */
export const SessionSpawnInput = closedStruct({
  prompt: Prompt,
  /**
   * The Agent to spawn from. Its fields take the place of the `thread.*`
   * settings, with the same precedence. `instanceId` and `permissionProfileId`
   * are rejected with it, because the Agent sets both.
   */
  agentId: Schema.optionalKey(Id),
  /** What every turn of this session must return. A schema outside the subset all harnesses support is rejected. */
  outputSchema: Schema.optionalKey(OutputSchema),
  instanceId: Schema.optionalKey(Id),
  model: Schema.optionalKey(Schema.NonEmptyString),
  /** The per-model choices this session opens with; a choice the model does not offer is rejected. */
  options: Schema.optionalKey(ModelSelection.fields.options),
  accessMode: Schema.optionalKey(AccessMode),
  /** Chooses a runner directly, a reserved one included; placement is skipped. */
  runnerId: Schema.optionalKey(Id),
  /** The Permission Profile the session's token carries, in place of the thread default. */
  permissionProfileId: Schema.optionalKey(Id),
  /** The project the thread belongs to; every resource in `workspace` must be in it. */
  projectId: Schema.optionalKey(Id),
  /** Where the session works; when absent, the thread has no checkout. */
  workspace: Schema.optionalKey(SpawnWorkspace),
});

export type SessionSpawnInput = Schema.Schema.Type<typeof SessionSpawnInput>;

/**
 * What a session runs under from now on: the model and options a caller chose
 * since its last call.
 *
 * - `options` is merged into the options the session already runs with,
 *   because a submission carries only what the user changed;
 * - a call whose `model` differs from the stored one starts from `{}`, because
 *   the choices belong to the model that offered them;
 * - a call with neither field changes nothing.
 */
export const SESSION_SELECTION_FIELDS = {
  model: Schema.optionalKey(Schema.NonEmptyString),
  options: Schema.optionalKey(ModelSelection.fields.options),
} as const;

export const SessionSelection = Schema.Struct(SESSION_SELECTION_FIELDS);

export type SessionSelection = Schema.Schema.Type<typeof SessionSelection>;

/**
 * One turn's input: the text, and the model and options sent with it. Declared
 * separately from the payload, so a service can spread these fields next to
 * the session id and apply the same bounds to an in-process caller.
 */
export const SESSION_INPUT_FIELDS = {
  text: Prompt,
  ...SESSION_SELECTION_FIELDS,
} as const;

export const SESSION_UPDATE_FIELDS = SESSION_SELECTION_FIELDS;

export const SessionUpdateInput = closedStruct(SESSION_UPDATE_FIELDS);

export type SessionUpdateInput = Schema.Schema.Type<typeof SessionUpdateInput>;

export const SessionInputPayload = closedStruct(SESSION_INPUT_FIELDS);

export type SessionInputPayload = Schema.Schema.Type<typeof SessionInputPayload>;

/**
 * What happened to one input. `inputId` is the id of the row it was stored as,
 * which a caller can edit or cancel while it is still `queued`.
 *
 * Adding input to a turn that is already running is steering, which is why it
 * needs the `session.steer` grant. `opened` and `steered` are the runner's own
 * words for what it did with the input. `queued` is the controller's word for
 * an input the session cannot take yet, including the input that resumes an
 * exited session, and a steer on a provider that does not steer natively: the
 * running turn is interrupted, and the input is sent as the next turn.
 */
export const SessionInputOutcome = Schema.Struct({
  inputId: Id,
  result: Schema.Literals(["opened", "steered", "queued"]),
});

export type SessionInputOutcome = Schema.Schema.Type<typeof SessionInputOutcome>;

/**
 * The answer to the request a session is parked on. `requestId` is the open
 * request's own id, so an answer that arrives after the harness moved on is
 * rejected rather than applied to whatever request is open now.
 */
export const SESSION_RESPOND_FIELDS = {
  requestId: Fact,
  decision: ApprovalDecision,
} as const;

export const SessionRespondInput = closedStruct(SESSION_RESPOND_FIELDS);

export type SessionRespondInput = Schema.Schema.Type<typeof SessionRespondInput>;

/**
 * Branching a session: `fork` opens a second provider-native session from the
 * one the parent left behind, and leaves the parent's own history untouched.
 * It runs on the parent's runner and provider instance, because that is where
 * the native state is. Continuing the parent itself is not done here: an
 * exited session that still has its transcript is resumed in place by its next
 * input.
 */
export const SESSION_CONTINUE_FIELDS = {
  mode: Schema.Literal("fork"),
  prompt: Prompt,
} as const;

export const SessionContinueInput = closedStruct(SESSION_CONTINUE_FIELDS);

export type SessionContinueInput = Schema.Schema.Type<typeof SessionContinueInput>;

/**
 * One status, or several. The runner page's "how full is this machine" view
 * needs `starting | idle | busy` in one read; every other caller asks for one.
 * The query string carries several as repeated `status` keys.
 */
export const SessionStatusFilter = Schema.Union([
  SessionStatus,
  Schema.NonEmptyArray(SessionStatus),
]);

export const SessionFilter = Schema.Struct({
  status: Schema.optionalKey(SessionStatusFilter),
  runnerId: Schema.optionalKey(Id),
  /** Only the sessions spawned from this Agent. */
  agentId: Schema.optionalKey(Id),
  /** Only the sessions carrying this Permission Profile, whichever Agent spawned them. */
  permissionProfileId: Schema.optionalKey(Id),
  /** Only the sessions of this conversation. */
  conversationId: Schema.optionalKey(Id),
  /** `true` lists the sessions with no Agent behind them; `false` lists the rest. */
  thread: Schema.optionalKey(Schema.Boolean),
});

export const SESSION_SORT_FIELDS = ["createdAt"] as const;

export const session = HttpApiGroup.make("session")
  .add(
    HttpApiEndpoint.get("query", "/sessions", {
      query: Schema.Struct({
        ...SessionFilter.fields,
        ...pageParams(SESSION_SORT_FIELDS).fields,
      }),
      success: page(Session),
      error: [Unauthenticated, Forbidden, Validation, Internal],
    }),
    HttpApiEndpoint.get("read", "/sessions/:id", {
      params: { id: Id },
      success: Session,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    HttpApiEndpoint.post("spawn", "/sessions", {
      payload: SessionSpawnInput,
      success: Session,
      error: [Unauthenticated, Forbidden, Validation, NotFound, InvalidState, Internal],
    }),
    HttpApiEndpoint.patch("update", "/sessions/:id", {
      params: { id: Id },
      payload: SessionUpdateInput,
      success: Session,
      error: [Unauthenticated, Forbidden, Validation, NotFound, InvalidState, Internal],
    }),
    HttpApiEndpoint.post("input", "/sessions/:id/input", {
      params: { id: Id },
      payload: SessionInputPayload,
      success: SessionInputOutcome,
      error: [Unauthenticated, Forbidden, Validation, NotFound, InvalidState, Internal],
    }),
    HttpApiEndpoint.post("interrupt", "/sessions/:id/interrupt", {
      params: { id: Id },
      success: Session,
      error: [Unauthenticated, Forbidden, Validation, NotFound, InvalidState, Internal],
    }),
    HttpApiEndpoint.post("respond", "/sessions/:id/respond", {
      params: { id: Id },
      payload: SessionRespondInput,
      success: Session,
      error: [Unauthenticated, Forbidden, Validation, NotFound, InvalidState, Internal],
    }),
    HttpApiEndpoint.post("stop", "/sessions/:id/stop", {
      params: { id: Id },
      success: Session,
      error: [Unauthenticated, Forbidden, Validation, NotFound, InvalidState, Internal],
    }),
    HttpApiEndpoint.post("continue", "/sessions/:id/continue", {
      params: { id: Id },
      payload: SessionContinueInput,
      success: Session,
      error: [Unauthenticated, Forbidden, Validation, NotFound, InvalidState, Internal],
    }),
  )
  .middleware(Authenticated);
