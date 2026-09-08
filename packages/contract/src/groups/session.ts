/**
 * Sessions: one provider-backed agent conversation, as the API sees it. Nothing
 * here is editable - a caller spawns a session, reads it, and sends it input.
 *
 * `requestedAccessMode` and `accessMode` are both on the record because the
 * downward fallback of [06-providers section 8.4] must never be silent.
 */
import { Schema } from "effect";
import { AccessMode, ModelSelection } from "@hydra/protocol";
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
import { page, pageParams } from "../pagination";
import { Authenticated } from "../security";
import { bounded } from "../strings";

/** The longest prompt or turn input the API takes: it crosses the runner socket in one frame. */
export const MAX_PROMPT_LENGTH = 64 * 1024;

export const Prompt = bounded(1, MAX_PROMPT_LENGTH);

/**
 * Where a session stands. `queued` is placement accepted with the runner full
 * or unreachable, `starting` is the start sent with no `session.started` back
 * yet, `busy` is a turn running, and `exited` is final.
 */
export const SESSION_STATUSES = ["queued", "starting", "idle", "busy", "exited"] as const;

export const SessionStatus = Schema.Literals(SESSION_STATUSES);

export type SessionStatus = Schema.Schema.Type<typeof SessionStatus>;

export const Session = Schema.Struct({
  id: Id,
  status: SessionStatus,
  /**
   * Derived, never stored: an exited session whose runner still holds the
   * provider-native state behind it.
   */
  resumable: Schema.Boolean,
  permissionProfileId: Id,
  instanceId: Id,
  /** Pinned where the session started; a session never migrates. */
  runnerId: Id,
  workspaceId: Schema.NullOr(Id),
  requestedAccessMode: AccessMode,
  /** What the session runs as, after the downward fallback. */
  accessMode: AccessMode,
  /** The provider-native id, once the runner has reported its binding. */
  nativeSessionId: Schema.NullOr(Schema.String),
  /**
   * What the session runs under now. It starts as the spec's and is rewritten
   * by `session.update`, so a resume or a fork carries the model the
   * conversation ended on rather than the one it opened with.
   */
  modelSelection: ModelSelection,
  /** Set where this session was forked off another one; null for a resume. */
  parentSessionId: Schema.NullOr(Id),
  createdAt: Timestamp,
  startedAt: Schema.NullOr(Timestamp),
  exitedAt: Schema.NullOr(Timestamp),
  lastActivityAt: Timestamp,
});

export type Session = Schema.Schema.Type<typeof Session>;

/**
 * Spawning a Thread: no agent, so every value comes from the user's `thread.*`
 * settings unless this call overrides it, for this session only.
 */
export const SessionSpawnInput = closedStruct({
  prompt: Prompt,
  instanceId: Schema.optionalKey(Id),
  model: Schema.optionalKey(Schema.NonEmptyString),
  accessMode: Schema.optionalKey(AccessMode),
  /** Workspaces are not built yet, so a non-null id is refused rather than ignored. */
  workspaceId: Schema.optionalKey(Schema.NullOr(Id)),
});

export type SessionSpawnInput = Schema.Schema.Type<typeof SessionSpawnInput>;

/**
 * One turn's input. Declared apart from the payload so a service can spread it
 * beside the session id and hold an in-process caller to the same bound.
 */
export const SESSION_INPUT_FIELDS = {
  text: Prompt,
} as const;

export const SESSION_UPDATE_FIELDS = {
  model: Schema.NonEmptyString,
} as const;

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
 * cannot take yet.
 */
export const SessionInputOutcome = Schema.Struct({
  inputId: Id,
  result: Schema.Literals(["opened", "steered", "queued"]),
});

export type SessionInputOutcome = Schema.Schema.Type<typeof SessionInputOutcome>;

/**
 * Carrying a session on: `resume` continues the provider-native session the
 * parent left behind, `fork` branches off it and leaves the parent's own
 * history untouched. Either way the new session lands on the parent's runner
 * and provider instance, because that is where the native state is.
 */
export const SESSION_CONTINUE_FIELDS = {
  mode: Schema.Literals(["resume", "fork"]),
  prompt: Prompt,
} as const;

export const SessionContinueInput = closedStruct(SESSION_CONTINUE_FIELDS);

export type SessionContinueInput = Schema.Schema.Type<typeof SessionContinueInput>;

export const SessionFilter = Schema.Struct({
  status: Schema.optionalKey(SessionStatus),
  runnerId: Schema.optionalKey(Id),
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
      error: [Unauthenticated, Forbidden, Validation, InvalidState, Internal],
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
