/**
 * Sessions: one provider-backed agent conversation, as the API sees it.
 *
 * A session record is almost entirely written by the controller and by the
 * runner reporting through it. Nothing here is editable: a caller spawns a
 * session, reads it, and sends it input. What the session then says is its
 * normalized stream, which is a separate append-only concern.
 *
 * `requestedAccessMode` and `accessMode` are both on the record because the
 * downward fallback of [06-providers section 8.4] must never be silent: a
 * caller that asked for `auto` on a provider that lacks it reads back the mode
 * it actually got, beside the one it asked for.
 */
import { Schema } from "effect";
import { AccessMode } from "@hydra/protocol";
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

/**
 * The longest prompt or turn input the API takes. The same bound as a task
 * description: a prompt is a document a person wrote, and it crosses the runner
 * socket in one frame.
 */
export const MAX_PROMPT_LENGTH = 64 * 1024;

const Prompt = bounded(1, MAX_PROMPT_LENGTH);

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
  createdAt: Timestamp,
  startedAt: Schema.NullOr(Timestamp),
  exitedAt: Schema.NullOr(Timestamp),
  lastActivityAt: Timestamp,
});

export type Session = Schema.Schema.Type<typeof Session>;

/**
 * Spawning a Thread: no agent, so every value comes from the user's `thread.*`
 * settings unless this call overrides it. Overrides are for this session only
 * and are never written back to the settings store.
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
 * One turn's input. Text only; attachments are an open item. Declared apart
 * from the payload so a service can spread it beside the session id and hold an
 * in-process caller to the same bound a request is held to.
 */
export const SESSION_INPUT_FIELDS = { text: Prompt } as const;

export const SessionInputPayload = closedStruct(SESSION_INPUT_FIELDS);

export type SessionInputPayload = Schema.Schema.Type<typeof SessionInputPayload>;

/**
 * Whether the input opened a turn or was folded into the one already running.
 * The word for the second is steering, which is why the grant is `session.steer`.
 */
export const SessionInputResult = Schema.Struct({
  result: Schema.Literals(["opened", "steered"]),
});

export type SessionInputResult = Schema.Schema.Type<typeof SessionInputResult>;

export const SessionFilter = Schema.Struct({
  status: Schema.optionalKey(SessionStatus),
  runnerId: Schema.optionalKey(Id),
});

/** Newest first: a session list is read as a history. */
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
    HttpApiEndpoint.post("input", "/sessions/:id/input", {
      params: { id: Id },
      payload: SessionInputPayload,
      success: SessionInputResult,
      error: [Unauthenticated, Forbidden, Validation, NotFound, InvalidState, Internal],
    }),
  )
  .middleware(Authenticated);
