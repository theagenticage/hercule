/**
 * Sessions: one provider-backed agent conversation, as the API sees it. Nothing
 * here is editable - a caller spawns a session, reads it, and sends it input.
 *
 * `requestedAccessMode` and `accessMode` are both on the record because the
 * downward fallback of [06-providers section 8.4] must never be silent.
 */
import { Schema } from "effect";
import {
  AccessMode,
  ApprovalDecision,
  Fact,
  ModelSelection,
  OpenRequest,
  OutputSchema,
} from "@hydra/protocol";
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

/** The request vocabulary is the protocol's; the API hands it out unchanged. */
export { ApprovalDecision, OpenRequest };

/** The longest prompt or turn input the API takes: it crosses the runner socket in one frame. */
export const MAX_PROMPT_LENGTH = 64 * 1024;

export const Prompt = bounded(1, MAX_PROMPT_LENGTH);

/**
 * Where a session stands. `queued` is placement accepted with the runner full
 * or unreachable, `starting` is the start sent with no `session.started` back
 * yet, `busy` is a turn running, and `exited` is the process gone; an exited
 * session with `resumable` true is resumed in place by its next input.
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
   * Derived at read, never stored: the session is `exited`, has a
   * `nativeSessionId`, and its runner is not retired. True means the next
   * `session.input` resumes it in place.
   */
  resumable: Schema.Boolean,
  permissionProfileId: Id,
  /** The Agent this session was spawned from; `null` is a Thread. Lineage only. */
  agentId: Schema.NullOr(Id),
  instanceId: Id,
  /** Pinned where the session started; a session never migrates. */
  runnerId: Id,
  workspaceId: Schema.NullOr(Id),
  /** The project the thread belongs to; organisation only, nothing derives from it. */
  projectId: Schema.NullOr(Id),
  requestedAccessMode: AccessMode,
  /** What the session runs as, after the downward fallback. */
  accessMode: AccessMode,
  /** The provider-native id, once the runner has reported its binding. */
  nativeSessionId: Schema.NullOr(Schema.String),
  /**
   * What the session runs under now. It starts as the spec's and is rewritten
   * by `session.update` and by an input that carries picks, so a resume or a
   * fork carries the model the conversation ended on rather than the one it
   * opened with.
   */
  modelSelection: ModelSelection,
  /** Set where this session was forked off another one; null otherwise. */
  parentSessionId: Schema.NullOr(Id),
  /**
   * The request the harness has parked on, if any: what the user has to answer
   * before this turn goes any further. At most one is open at a time, and it is
   * cleared when the machine resolves it or when the turn or session it belongs
   * to ends.
   */
  openRequest: Schema.NullOr(OpenRequest),
  createdAt: Timestamp,
  startedAt: Schema.NullOr(Timestamp),
  /** The last exit: kept while the session is resumed, rewritten when it exits again. */
  exitedAt: Schema.NullOr(Timestamp),
  lastActivityAt: Timestamp,
  /**
   * Which of the fields this session was spawned with its provider will not
   * act on, read from the instance's declared capabilities at every read.
   */
  unenforced: Schema.Array(UnenforcedSpecField),
});

export type Session = Schema.Schema.Type<typeof Session>;

/** The most repos one thread may open a workspace over at once. */
export const MAX_SPAWN_CHECKOUTS = 32;

/** One repo a fresh workspace gets a worktree of, and where that worktree starts. */
export const SpawnCheckout = Schema.Struct({
  resourceId: Id,
  /** What the thread's own branch starts from; absent takes the default branch. */
  baseBranch: Schema.optionalKey(Branch),
});

export type SpawnCheckout = Schema.Schema.Type<typeof SpawnCheckout>;

/**
 * The workspace a thread opens in: the repo's main workspace, a fresh worktree
 * of its own, or one that already stands. A workspace is a kind and a list of
 * checkouts; every git word rides a checkout. Leaving it off is a thread with
 * no checkout at all.
 */
export const SpawnWorkspace = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("primary"),
    resourceId: Id,
    /** The branch the main workspace is switched to before the harness starts. */
    branch: Schema.optionalKey(Branch),
  }),
  Schema.Struct({
    kind: Schema.Literal("ephemeral"),
    /** Empty makes a scratch workspace: a directory and no checkout at all. */
    checkouts: atMost(SpawnCheckout, MAX_SPAWN_CHECKOUTS),
  }),
  Schema.Struct({ kind: Schema.Literal("existing"), workspaceId: Id }),
]);

export type SpawnWorkspace = Schema.Schema.Type<typeof SpawnWorkspace>;

/**
 * Spawning a session: from an Agent, whose fields say what it runs under, or
 * with no `agentId` at all, which is a Thread and takes the user's `thread.*`
 * settings instead. Either way a value named here overrides both, for this
 * session only.
 */
export const SessionSpawnInput = closedStruct({
  prompt: Prompt,
  /**
   * The Agent to spawn from. Its fields stand in for the `thread.*` settings
   * in the same precedence chain, so `instanceId` and `permissionProfileId`
   * beside it are refused: those come from the Agent.
   */
  agentId: Schema.optionalKey(Id),
  /** What every turn of this session must answer with; refused outside the shared subset. */
  outputSchema: Schema.optionalKey(OutputSchema),
  instanceId: Schema.optionalKey(Id),
  model: Schema.optionalKey(Schema.NonEmptyString),
  /** The per-model choices this session opens with; what the model does not offer is refused. */
  options: Schema.optionalKey(ModelSelection.fields.options),
  accessMode: Schema.optionalKey(AccessMode),
  /** Names a runner directly, a reserved one included; placement is skipped. */
  runnerId: Schema.optionalKey(Id),
  /** The Permission Profile the session's token carries, in place of the thread default. */
  permissionProfileId: Schema.optionalKey(Id),
  /** The project the thread belongs to; every resource it names must be in it. */
  projectId: Schema.optionalKey(Id),
  /** Where it works; absent is a thread with no checkout. */
  workspace: Schema.optionalKey(SpawnWorkspace),
});

export type SessionSpawnInput = Schema.Schema.Type<typeof SessionSpawnInput>;

/**
 * What a session is to run under from here on: the config picks a caller made
 * since the last time it said. `options` merges over the ones the session
 * already runs with, because a submission carries only what the user touched;
 * a call whose `model` differs from the stored one starts from `{}`, because
 * the choices belong to the model that offered them; and a call naming neither
 * changes nothing.
 */
export const SESSION_SELECTION_FIELDS = {
  model: Schema.optionalKey(Schema.NonEmptyString),
  options: Schema.optionalKey(ModelSelection.fields.options),
} as const;

export const SessionSelection = Schema.Struct(SESSION_SELECTION_FIELDS);

export type SessionSelection = Schema.Schema.Type<typeof SessionSelection>;

/**
 * One turn's input: the text, and the picks that ride with it. Declared apart
 * from the payload so a service can spread it beside the session id and hold an
 * in-process caller to the same bound.
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
 * What one input did. `inputId` names the row it was stored as, which is what a
 * caller edits or cancels while it is still `queued`.
 *
 * Folding input into a turn already running is steering, hence the
 * `session.steer` grant. `opened` and `steered` are the runner's own words for
 * what it did with it; `queued` is the controller's, for an input the session
 * cannot take yet - the input that resumes an exited session included.
 */
export const SessionInputOutcome = Schema.Struct({
  inputId: Id,
  result: Schema.Literals(["opened", "steered", "queued"]),
});

export type SessionInputOutcome = Schema.Schema.Type<typeof SessionInputOutcome>;

/**
 * Answering the request a session is parked on. `requestId` is the open
 * request's own, so an answer that arrives after the harness moved on is
 * refused rather than applied to whatever is open now.
 */
export const SESSION_RESPOND_FIELDS = {
  requestId: Fact,
  decision: ApprovalDecision,
} as const;

export const SessionRespondInput = closedStruct(SESSION_RESPOND_FIELDS);

export type SessionRespondInput = Schema.Schema.Type<typeof SessionRespondInput>;

/**
 * Branching a session: `fork` opens a second provider-native session off the
 * one the parent left behind, leaving the parent's own history untouched. It
 * lands on the parent's runner and provider instance, because that is where
 * the native state is. Carrying the parent itself on is not here: an exited
 * session that still has its transcript is resumed in place by its next input.
 */
export const SESSION_CONTINUE_FIELDS = {
  mode: Schema.Literal("fork"),
  prompt: Prompt,
} as const;

export const SessionContinueInput = closedStruct(SESSION_CONTINUE_FIELDS);

export type SessionContinueInput = Schema.Schema.Type<typeof SessionContinueInput>;

/**
 * One status, or several - the runner page's "how full is this machine"
 * needs `starting | idle | busy` in one read, everything else names one. The
 * wire carries several as repeated `status` query keys.
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
  /** `true` is the sessions with no Agent behind them; `false` is the rest. */
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
