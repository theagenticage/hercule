/**
 * The repository for session rows and the append-only stream beside them.
 * Nothing here decides policy: placement, the access-mode fallback and status
 * changes are decided by the service and by the fold in `stream.ts`.
 *
 * `resumable` is computed in the SELECT rather than stored, because a stored
 * copy would be out of date as soon as a runner is retired.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { Fragment } from "effect/unstable/sql/Statement";
import type {
  AccessMode,
  DisallowedTool,
  ModelSelection,
  OpenRequest,
  ProviderEvent,
} from "@hercule/protocol";
import {
  createNotFoundError,
  SESSION_STATUSES,
  type NotFound,
  type SessionStatus,
  type SortDirection,
} from "@hercule/contract";
import {
  decodeCursor,
  decodeIntegerKeyCursor,
  encodeCursor,
  encodeIntegerKeyCursor,
  buildKeyset,
  buildPage,
  uuidFromString,
  uuidToString,
  type CursorError,
  type CursorScope,
  type Page,
} from "../db";
import { buildReadyClause, buildResumableClause } from "../workspaces";
import { DEFAULT_ABSOLUTE_TIMEOUT_MS } from "./options";
import type { StreamRow } from "./stream";

/** A session as it is stored. `resumable` is computed on read; see above. */
export interface StoredSession {
  readonly id: string;
  readonly title: string;
  readonly permissionProfileId: string;
  /** The Agent the session was spawned from; `null` for a Thread. */
  readonly agentId: string | null;
  /** The assistant's conversation the session answers; `null` for any other session. */
  readonly conversationId: string | null;
  readonly instanceId: string;
  readonly runnerId: string;
  readonly workspaceId: string | null;
  readonly projectId: string | null;
  /** The GitHub account this session pushes as, chosen when it was spawned. */
  readonly githubConnectionId: string | null;
  readonly requestedAccessMode: AccessMode;
  readonly accessMode: AccessMode;
  readonly nativeSessionId: string | null;
  readonly modelSelection: ModelSelection;
  readonly parentSessionId: string | null;
  readonly status: SessionStatus;
  readonly resumable: boolean;
  readonly openRequest: OpenRequest | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly exitedAt: string | null;
  readonly lastActivityAt: string;
  /**
   * Whether the session's last exit came before its process started any
   * turn, with no input stored for it since. The crash-loop guard in
   * `isResumeHeld` reads it. A new input or a resume sets it back to `false`.
   */
  readonly awaitingNewInput: boolean;
  /** Whether an input still waits on the session, sent to the runner or not. Computed on read. */
  readonly inputWaiting: boolean;
  /**
   * The provider behind the session's instance, and the tool families its
   * spec disallowed. Both are used to work out whether the provider enforces
   * the restriction. They are read on every read, not stored, because the
   * adapter in a later binary may enforce what this one ignores. `providerId`
   * is `null` once the instance is deleted.
   */
  readonly providerId: string | null;
  readonly disallowedTools: ReadonlyArray<DisallowedTool>;
}

export interface NewSession {
  /**
   * Created by the caller, not here. A spawn opens the workspace in the same
   * transaction, and a thread's own worktree is created on a branch named
   * after the thread, so the id has to exist before either row does.
   */
  readonly id: string;
  readonly title: string;
  readonly permissionProfileId: string;
  /** The Agent the session was spawned from; `undefined` for a Thread. */
  readonly agentId: string | undefined;
  /** The assistant's conversation the session answers; `undefined` for any other session. */
  readonly conversationId: string | undefined;
  readonly instanceId: string;
  readonly runnerId: string;
  readonly workspaceId: string | null;
  readonly projectId: string | undefined;
  /** The branch the main workspace is switched to before the harness starts. */
  readonly checkoutBranch: string | undefined;
  /** The GitHub account this session pushes as, chosen when it was spawned. */
  readonly githubConnectionId: string | undefined;
  readonly requestedAccessMode: AccessMode;
  readonly accessMode: AccessMode;
  /** The encoded `SessionSpec`, stored as the exact string that goes on the wire. */
  readonly spec: string;
  readonly modelSelection: ModelSelection;
  readonly parentSessionId: string | undefined;
  readonly at: string;
}

/**
 * What a session may do: the access mode it asked for, the one it runs under
 * after the provider's fallback, and the permission profile its token is
 * bound to.
 */
export interface SessionAccess {
  readonly requestedAccessMode: AccessMode;
  readonly accessMode: AccessMode;
  readonly permissionProfileId: string;
}

/**
 * Every session status except `exited`. A live session still uses what it was
 * spawned with (a runner, a workspace, and a token limited to the grants it
 * copied), so those cannot be deleted while it runs. The list is derived from
 * `SESSION_STATUSES`, so a status added later counts as live.
 */
export const LIVE_SESSION_STATUSES: ReadonlyArray<SessionStatus> = SESSION_STATUSES.filter(
  (status) => status !== "exited",
);

export interface SessionPageRequest {
  readonly limit: number;
  readonly cursor: string | undefined;
  readonly direction: SortDirection;
  readonly status: SessionStatus | ReadonlyArray<SessionStatus> | undefined;
  readonly runnerId: string | undefined;
  readonly agentId: string | undefined;
  readonly permissionProfileId: string | undefined;
  /** Only the sessions of this conversation. */
  readonly conversationId: string | undefined;
  /** `true` lists the sessions with no agent behind them; `false` lists the rest. */
  readonly thread: boolean | undefined;
}

interface SessionRow {
  readonly id: Uint8Array;
  readonly title: string;
  readonly permission_profile_id: Uint8Array;
  readonly agent_id: Uint8Array | null;
  readonly conversation_id: Uint8Array | null;
  readonly provider_id: string | null;
  /** The spec's disallowed tool families as a JSON array, or null for none. */
  readonly disallowed_tools: string | null;
  readonly instance_id: Uint8Array;
  readonly runner_id: Uint8Array;
  readonly workspace_id: Uint8Array | null;
  readonly project_id: Uint8Array | null;
  readonly github_connection_id: Uint8Array | null;
  readonly requested_access_mode: string;
  readonly access_mode: string;
  readonly native_session_id: string | null;
  readonly model_selection: string;
  readonly parent_session_id: Uint8Array | null;
  readonly status: string;
  readonly resumable: number;
  readonly open_request: string | null;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly exited_at: string | null;
  readonly last_activity_at: string;
  readonly awaiting_new_input: number;
  readonly input_waiting: number;
}

/**
 * Builds the column list. It is called when the repository is built, never at
 * module load. Part of the list comes from a function the workspaces domain
 * exports. A constant that called it while this module loads could run before
 * the workspaces module has finished loading, and throw a `ReferenceError`
 * that depends only on which domain was imported first.
 */
const buildColumnList = (): string =>
  "id, title, permission_profile_id, agent_id, conversation_id, instance_id, runner_id, workspace_id, project_id, " +
  "github_connection_id, requested_access_mode, " +
  // Both are read to compute `unenforced`: the provider behind the instance,
  // and the tool families this session's spec disallowed.
  "(SELECT provider_id FROM provider_instances WHERE id = sessions.instance_id) AS provider_id, " +
  "json_extract(spec, '$.disallowedTools') AS disallowed_tools, " +
  "access_mode, native_session_id, model_selection, parent_session_id, status, " +
  "open_request, created_at, started_at, exited_at, " +
  "last_activity_at, awaiting_new_input, " +
  "EXISTS (SELECT 1 FROM session_inputs WHERE session_inputs.session_id = sessions.id " +
  "AND session_inputs.status = 'queued') AS input_waiting, " +
  `(${buildResumableClause("sessions")}) AS resumable`;

const toSession = (row: SessionRow): StoredSession => ({
  id: uuidToString(row.id),
  title: row.title,
  permissionProfileId: uuidToString(row.permission_profile_id),
  agentId: row.agent_id === null ? null : uuidToString(row.agent_id),
  conversationId: row.conversation_id === null ? null : uuidToString(row.conversation_id),
  instanceId: uuidToString(row.instance_id),
  runnerId: uuidToString(row.runner_id),
  workspaceId: row.workspace_id === null ? null : uuidToString(row.workspace_id),
  projectId: row.project_id === null ? null : uuidToString(row.project_id),
  githubConnectionId:
    row.github_connection_id === null ? null : uuidToString(row.github_connection_id),
  requestedAccessMode: row.requested_access_mode as AccessMode,
  accessMode: row.access_mode as AccessMode,
  nativeSessionId: row.native_session_id,
  modelSelection: JSON.parse(row.model_selection) as ModelSelection,
  parentSessionId: row.parent_session_id === null ? null : uuidToString(row.parent_session_id),
  status: row.status as SessionStatus,
  resumable: row.resumable === 1,
  openRequest: row.open_request === null ? null : (JSON.parse(row.open_request) as OpenRequest),
  createdAt: row.created_at,
  startedAt: row.started_at,
  exitedAt: row.exited_at,
  lastActivityAt: row.last_activity_at,
  awaitingNewInput: row.awaiting_new_input === 1,
  inputWaiting: row.input_waiting === 1,
  providerId: row.provider_id,
  disallowedTools:
    row.disallowed_tools === null
      ? []
      : (JSON.parse(row.disallowed_tools) as ReadonlyArray<DisallowedTool>),
});

const buildCursorScope = (direction: SortDirection): CursorScope => ({
  op: "session.query",
  field: "createdAt",
  direction,
});

/**
 * Builds the cursor scope for one session's transcript. The cursor key is the
 * position, which is per session, so the session id is part of the scope.
 * Without it, a cursor from one session's transcript would silently skip rows
 * on another session's transcript.
 */
const buildTranscriptScope = (sessionId: string, direction: SortDirection): CursorScope => ({
  op: "transcript.read",
  field: `position:${sessionId}`,
  direction,
});

/**
 * The position of the last queued row a batch read. The next batch starts
 * after it, so a caller that skips rows never reads the same row twice.
 */
export interface QueuePosition {
  readonly createdAt: string;
  readonly id: string;
}

/**
 * One queued session, with everything needed to build its start frame except
 * the token and the GitHub account, which are read when the session is
 * claimed.
 */
export interface QueuedSession {
  readonly id: string;
  readonly createdAt: string;
  readonly spec: string;
  readonly checkoutBranch: string | null;
  readonly githubConnectionId: string | null;
  readonly providerId: string;
  readonly config: unknown;
}

/** A session's ingest state; see `ingestState`. */
export interface IngestState {
  readonly lastSeq: number;
  /** Added to every sequence number the session's current process reports. */
  readonly base: number;
}

/** One row of a session's stream, as the transcript reads it. */
export interface StoredStreamRow {
  readonly position: number;
  readonly at: string;
  readonly event: ProviderEvent;
}

export interface TranscriptPageRequest {
  readonly sessionId: string;
  readonly limit: number;
  readonly cursor: string | undefined;
  readonly direction: SortDirection;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const COLUMNS = buildColumnList();

  /**
   * Builds the status filter: `=` for one status, `IN` for several (the
   * runner page reads capacity that way). The contract requires at least one
   * element in the array, so an empty array cannot reach this.
   */
  const buildStatusClause = (status: SessionStatus | ReadonlyArray<SessionStatus>) =>
    Array.isArray(status) ? sql`status IN ${sql.in(status)}` : sql`status = ${status}`;

  /**
   * Moves every session that matches `condition` and has not exited to
   * `exited`, and returns those rows as they were just before, oldest first.
   * The caller needs the old rows, because what an end means depends on the
   * status the session ended from, and an UPDATE's RETURNING gives only the
   * new values. So the rows are read first and then updated by id, and the
   * caller runs both in one transaction, so no write can land between them.
   */
  const endMatching = (
    condition: Fragment,
    at: string,
  ): Effect.Effect<ReadonlyArray<StoredSession>, SqlError> =>
    Effect.gen(function* () {
      const rows = yield* sql<SessionRow>`
        SELECT ${sql.literal(COLUMNS)} FROM sessions
        WHERE status <> 'exited' AND ${condition}
        ORDER BY created_at, id
      `;
      if (rows.length === 0) return [];
      yield* sql`
        UPDATE sessions SET
          status = 'exited',
          last_activity_at = ${at},
          open_request = NULL,
          token_hash = NULL,
          exited_at = ${at},
          awaiting_new_input = 1 - turn_started_in_process
        WHERE id IN ${sql.in(rows.map((row) => row.id))} AND status <> 'exited'
      `;
      return rows.map(toSession);
    });

  return {
    /**
     * Writes the session and returns nothing. The caller minted the id, so it
     * already knows it. The caller must read the row back after the write,
     * because dispatch may change the row, and the caller must pass on the
     * current row.
     */
    insert: (session: NewSession): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        const id = uuidFromString(session.id);
        const parent =
          session.parentSessionId === undefined ? null : uuidFromString(session.parentSessionId);
        const workspace = session.workspaceId === null ? null : uuidFromString(session.workspaceId);
        const project = session.projectId === undefined ? null : uuidFromString(session.projectId);
        const connection =
          session.githubConnectionId === undefined
            ? null
            : uuidFromString(session.githubConnectionId);
        const agent = session.agentId === undefined ? null : uuidFromString(session.agentId);
        const conversation =
          session.conversationId === undefined ? null : uuidFromString(session.conversationId);
        yield* sql`
          INSERT INTO sessions (id, title, permission_profile_id, agent_id, conversation_id,
                                instance_id, runner_id,
                                workspace_id, project_id, checkout_branch, github_connection_id,
                                requested_access_mode, access_mode, spec,
                                model_selection, parent_session_id, status,
                                created_at, last_activity_at)
          VALUES (${id}, ${session.title}, ${uuidFromString(session.permissionProfileId)}, ${agent},
                  ${conversation}, ${uuidFromString(session.instanceId)}, ${uuidFromString(session.runnerId)},
                  ${workspace}, ${project}, ${session.checkoutBranch ?? null}, ${connection},
                  ${session.requestedAccessMode}, ${session.accessMode},
                  ${session.spec}, ${JSON.stringify(session.modelSelection)}, ${parent},
                  'queued', ${session.at}, ${session.at})
        `;
      }),

    one: (id: string): Effect.Effect<Option.Option<StoredSession>, SqlError> =>
      Effect.map(
        sql<SessionRow>`
          SELECT ${sql.literal(COLUMNS)} FROM sessions WHERE id = ${uuidFromString(id)}
        `,
        (rows) => Option.map(Option.fromNullishOr(rows[0]), toSession),
      ),

    /**
     * Returns every session of one conversation that has not exited, oldest
     * first. The newest answers the conversation; an older one that has not
     * exited yet is still running, for example while it is being stopped.
     */
    listLiveInConversation: (
      conversationId: string,
    ): Effect.Effect<ReadonlyArray<StoredSession>, SqlError> =>
      Effect.map(
        sql<SessionRow>`
          SELECT ${sql.literal(COLUMNS)} FROM sessions
          WHERE conversation_id = ${uuidFromString(conversationId)} AND status <> 'exited'
          ORDER BY created_at, id
        `,
        (rows) => rows.map(toSession),
      ),

    /**
     * Returns the newest session of one conversation, whatever its status, or
     * `none` when the conversation has no session yet. Sessions created in
     * the same millisecond are ordered by id, as the index is.
     */
    newestInConversation: (
      conversationId: string,
    ): Effect.Effect<Option.Option<StoredSession>, SqlError> =>
      Effect.map(
        sql<SessionRow>`
          SELECT ${sql.literal(COLUMNS)} FROM sessions
          WHERE conversation_id = ${uuidFromString(conversationId)}
          ORDER BY created_at DESC, id DESC LIMIT 1
        `,
        (rows) => Option.map(Option.fromNullishOr(rows[0]), toSession),
      ),

    /**
     * Returns the ids among `ids` of sessions that have ended for good: the
     * process has exited and the session cannot be resumed. Uses one query for
     * the whole list, because the caller asks about many sessions at once and
     * a query per id would grow with the list.
     */
    listEndedForGood: (
      ids: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyArray<string>, SqlError> =>
      ids.length === 0
        ? Effect.succeed([])
        : Effect.map(
            sql<{ readonly id: Uint8Array }>`
              SELECT id FROM sessions
              WHERE id IN ${sql.in(ids.map(uuidFromString))}
                AND status = 'exited' AND NOT (${sql.literal(buildResumableClause("sessions"))})
            `,
            (rows) => rows.map((row) => uuidToString(row.id)),
          ),

    list: (
      request: SessionPageRequest,
    ): Effect.Effect<Page<StoredSession>, CursorError | SqlError> =>
      Effect.gen(function* () {
        const scope = buildCursorScope(request.direction);
        const after =
          request.cursor === undefined
            ? undefined
            : yield* decodeCursor(request.cursor, scope, "string");
        const { keyset, order } = buildKeyset(
          sql,
          ["created_at", "id"],
          after === undefined ? undefined : [after[0], uuidFromString(after[1])],
          request.direction,
        );
        const clauses = [keyset];
        if (request.status !== undefined) clauses.push(buildStatusClause(request.status));
        if (request.runnerId !== undefined) {
          clauses.push(sql`runner_id = ${uuidFromString(request.runnerId)}`);
        }
        if (request.agentId !== undefined) {
          clauses.push(sql`agent_id = ${uuidFromString(request.agentId)}`);
        }
        if (request.permissionProfileId !== undefined) {
          clauses.push(sql`permission_profile_id = ${uuidFromString(request.permissionProfileId)}`);
        }
        if (request.conversationId !== undefined) {
          clauses.push(sql`conversation_id = ${uuidFromString(request.conversationId)}`);
        }
        if (request.thread !== undefined) {
          clauses.push(request.thread ? sql`agent_id IS NULL` : sql`agent_id IS NOT NULL`);
        }
        const rows = yield* sql<SessionRow>`
          SELECT ${sql.literal(COLUMNS)} FROM sessions
          WHERE ${sql.and(clauses)} ${order} LIMIT ${request.limit + 1}
        `;
        return yield* buildPage(
          rows,
          request.limit,
          (found) => Effect.succeed(found.map(toSession)),
          (last) => encodeCursor(scope, last.createdAt, last.id),
        );
      }),

    /**
     * Returns the exact spec sent to this session's runner, as the row stores
     * it, or `none` when there is no such session. It is read separately
     * rather than on every session read, because only a session that continues
     * another session's transcript needs it, and the column is large.
     */
    readSpecDocument: (id: string): Effect.Effect<Option.Option<string>, SqlError> =>
      Effect.map(
        sql<{ readonly spec: string }>`
          SELECT spec FROM sessions WHERE id = ${uuidFromString(id)}
        `,
        (rows) => Option.map(Option.fromNullishOr(rows[0]), (row) => row.spec),
      ),

    /**
     * Returns one page of a session's stream, in position order. The stored
     * `event` is parsed with `JSON.parse` rather than decoded with the schema:
     * the schema has no transformations, so the JSON is already the value.
     */
    transcript: (
      request: TranscriptPageRequest,
    ): Effect.Effect<Page<StoredStreamRow>, CursorError | SqlError> =>
      Effect.gen(function* () {
        const scope = buildTranscriptScope(request.sessionId, request.direction);
        const after =
          request.cursor === undefined
            ? undefined
            : yield* decodeIntegerKeyCursor(request.cursor, scope);
        const { keyset, order } = buildKeyset(
          sql,
          ["position"],
          after === undefined ? undefined : [after],
          request.direction,
        );
        const rows = yield* sql<{
          readonly position: number;
          readonly at: string;
          readonly event: string;
        }>`
          SELECT position, at, event FROM session_stream
          WHERE session_id = ${uuidFromString(request.sessionId)} AND ${keyset}
          ${order} LIMIT ${request.limit + 1}
        `;
        return yield* buildPage(
          rows,
          request.limit,
          (found) =>
            Effect.succeed(
              found.map((row) => ({
                position: row.position,
                at: row.at,
                event: JSON.parse(row.event) as ProviderEvent,
              })),
            ),
          (last) => encodeIntegerKeyCursor(scope, last.position),
        );
      }),

    /**
     * Returns the reason on the newest `session.exited` row of the session's
     * stream, or `none` when the stream has none. An exit the controller
     * decided on its own, such as a lost runner, writes no such row.
     */
    readLastExitReason: (sessionId: string): Effect.Effect<Option.Option<string>, SqlError> =>
      Effect.map(
        sql<{ readonly reason: string | null }>`
          SELECT json_extract(event, '$.reason') AS reason FROM session_stream
          WHERE session_id = ${uuidFromString(sessionId)}
            AND json_extract(event, '$._tag') = 'session.exited'
          ORDER BY position DESC LIMIT 1
        `,
        (rows) => Option.fromNullishOr(rows[0]?.reason),
      ),

    /**
     * Returns the session's ingest state: the highest sequence number already
     * written, and the offset added to the current process's sequence numbers.
     *
     * The highest sequence is a high-water mark, not proof that every lower
     * number was written. A merged delta row stores the sequence of its last
     * delta, so a plain event can be written with a higher sequence while
     * lower delta text is still only held in memory. Nothing replays today;
     * the outbox of spec 03 section 2.3 will need more than this.
     */
    ingestState: (sessionId: string): Effect.Effect<IngestState, SqlError> =>
      Effect.map(
        sql<{ readonly last: number | null; readonly base: number }>`
          SELECT (SELECT MAX(runner_seq) FROM session_stream
                  WHERE session_id = sessions.id) AS last,
                 stream_base AS base
          FROM sessions WHERE id = ${uuidFromString(sessionId)}
        `,
        (rows) => ({ lastSeq: rows[0]?.last ?? 0, base: rows[0]?.base ?? 0 }),
      ),

    /**
     * Appends one row at the next position for this session. A sequence number
     * already written hits the unique index and writes nothing, so a replayed
     * frame is harmless.
     */
    append: (sessionId: string, row: StreamRow): Effect.Effect<void, SqlError> => {
      const id = uuidFromString(sessionId);
      return Effect.asVoid(sql`
        INSERT INTO session_stream (session_id, position, runner_seq, at, event)
        SELECT ${id}, COALESCE(MAX(position), 0) + 1, ${row.seq}, ${row.at},
               ${JSON.stringify(row.event)}
        FROM session_stream WHERE session_id = ${id}
        ON CONFLICT (session_id, runner_seq) DO NOTHING
      `);
    },

    /**
     * Changes the session's status and updates its last activity time.
     *
     * - `startedAt` is written once, when the session first becomes `idle` or
     *   `busy`. A session resumed later keeps its first start time.
     * - `exitedAt` is the last exit, so every move to `exited` sets it again.
     * - A move to `busy` means a turn started, so it marks the current
     *   process as having started one.
     * - A move to `exited` before the process started any turn sets
     *   `awaitingNewInput`, for the crash-loop guard.
     * - A status with no process behind it clears the token hash in the same
     *   write. The table's constraint rejects the row otherwise (migration
     *   0023).
     *
     * The WHERE clause keeps an exited session exited. This row has two
     * writers, ingest and a spawn that could not reach its runner, so a status
     * read before the transaction proves nothing inside it. Only `resume`
     * below moves a session out of `exited`.
     */
    moved: (sessionId: string, status: SessionStatus, at: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE sessions SET
          status = ${status},
          last_activity_at = ${at},
          started_at = CASE WHEN started_at IS NULL AND ${status} IN ('idle', 'busy') THEN ${at}
                            ELSE started_at END,
          exited_at = CASE WHEN ${status} = 'exited' THEN ${at} ELSE exited_at END,
          turn_started_in_process = CASE WHEN ${status} = 'busy' THEN 1
                                         ELSE turn_started_in_process END,
          awaiting_new_input = CASE WHEN ${status} = 'exited' THEN 1 - turn_started_in_process
                                    ELSE awaiting_new_input END,
          token_hash = CASE WHEN ${status} IN ('starting', 'idle', 'busy') THEN token_hash
                            ELSE NULL END
        WHERE id = ${uuidFromString(sessionId)} AND status <> 'exited'
      `),

    /**
     * Moves a `queued` session to `exited`, and returns the row as it was
     * before. A session that dispatch moved to `starting` in the meantime is
     * left alone and returns `none`: its runner now holds it, so only the
     * runner can end it. The caller runs it in a transaction.
     */
    endQueued: (
      sessionId: string,
      at: string,
    ): Effect.Effect<Option.Option<StoredSession>, SqlError> =>
      Effect.map(
        endMatching(sql`id = ${uuidFromString(sessionId)} AND status = 'queued'`, at),
        (ended) => Option.fromNullishOr(ended[0]),
      ),

    /**
     * Moves the session to `starting` for dispatch, and stores the hash of the
     * token created for that start. It is one statement rather than a status
     * change plus a write, because the row may hold a token only while it is
     * starting or running, and the two must never be out of step. Like
     * `moved`, it never changes an exited session.
     */
    started: (sessionId: string, tokenHash: string, at: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE sessions SET
          status = 'starting',
          last_activity_at = ${at},
          token_hash = ${tokenHash}
        WHERE id = ${uuidFromString(sessionId)} AND status <> 'exited'
      `),

    /**
     * Moves an exited session back to `queued`, with the spec its resumed
     * harness starts with, for dispatch to place. This is the only way out of
     * `exited`, and the one exception to the rule in `moved`.
     *
     * It decides nothing: whether the session may be resumed is the service's
     * check, made in the same transaction just before this write. The new
     * process has started no turn yet, and nothing holds it back any more, so
     * both flags of the crash-loop guard are cleared.
     *
     * An exited row holds no token hash (migration 0023), so a token that
     * leaked before the exit stays invalid once the session is back on the
     * queue. Dispatch creates a new token for the resumed process.
     *
     * The sequence offset always moves up to the highest sequence in the
     * stored stream: the controller cannot tell whether the runner's process
     * restarted and began numbering from zero again. Moving it anyway is
     * harmless, because `runner_seq` is only used to drop duplicates and the
     * transcript is read in `position` order.
     */
    resume: (sessionId: string, spec: string, at: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE sessions SET
          status = 'queued',
          spec = ${spec},
          last_activity_at = ${at},
          open_request = NULL,
          turn_started_in_process = 0,
          awaiting_new_input = 0,
          stream_base = (SELECT COALESCE(MAX(runner_seq), 0) FROM session_stream
                         WHERE session_id = sessions.id)
        WHERE id = ${uuidFromString(sessionId)}
      `),

    /**
     * Lifts the crash-loop guard's hold on the session, because an input was
     * just stored for it. Someone is asking again, so the session may be
     * resumed for every input that waits. The caller runs it in the
     * transaction that stores the input.
     */
    liftResumeHold: (sessionId: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE sessions SET awaiting_new_input = 0
        WHERE id = ${uuidFromString(sessionId)} AND awaiting_new_input = 1
      `),

    /**
     * Sets the model and model options the session runs under from now on.
     * `spec` is not changed: it is the spec the runner received at start, and
     * only `resume` above rewrites it, for the next start.
     */
    setModelSelection: (
      sessionId: string,
      modelSelection: ModelSelection,
    ): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE sessions SET model_selection = ${JSON.stringify(modelSelection)}
        WHERE id = ${uuidFromString(sessionId)}
      `),

    /**
     * Sets the access mode the session asked for, the one it runs under, and
     * the permission profile its token is bound to. Only a resume calls this,
     * before the session starts again, because a running harness keeps the
     * mode it was started with.
     */
    setAccess: (sessionId: string, access: SessionAccess): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE sessions SET
          requested_access_mode = ${access.requestedAccessMode},
          access_mode = ${access.accessMode},
          permission_profile_id = ${uuidFromString(access.permissionProfileId)}
        WHERE id = ${uuidFromString(sessionId)}
      `),

    /** Stores the request the runner reported the session is waiting on, or `null` for none. */
    setOpenRequest: (
      sessionId: string,
      request: OpenRequest | null,
    ): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE sessions SET open_request = ${request === null ? null : JSON.stringify(request)}
        WHERE id = ${uuidFromString(sessionId)}
      `),

    touched: (sessionId: string, at: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(
        sql`UPDATE sessions SET last_activity_at = ${at} WHERE id = ${uuidFromString(sessionId)}`,
      ),

    /**
     * Stores the provider-native id a runner reported for one of its sessions.
     * The runner and the instance are both in the WHERE clause, because a
     * runner may report only on the sessions placed on it, and only for the
     * instance those sessions were opened against.
     */
    bind: (
      sessionId: string,
      runnerId: string,
      instanceId: string,
      nativeSessionId: string,
    ): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE sessions SET native_session_id = ${nativeSessionId}
        WHERE id = ${uuidFromString(sessionId)} AND runner_id = ${uuidFromString(runnerId)}
          AND instance_id = ${uuidFromString(instanceId)}
      `),

    /**
     * Returns up to `limit` of this runner's oldest queued sessions, with what
     * the start frame needs: the exact spec each was queued with, and its
     * provider. The provider is joined rather than read per row, so dispatch
     * needs one statement. `after` continues an earlier batch from where it
     * stopped, in queue order, so a caller that skips rows never reads them
     * again.
     */
    oldestQueued: (
      runnerId: string,
      limit: number,
      after?: QueuePosition,
    ): Effect.Effect<ReadonlyArray<QueuedSession>, SqlError> =>
      Effect.map(
        sql<{
          readonly id: Uint8Array;
          readonly created_at: string;
          readonly spec: string;
          readonly checkout_branch: string | null;
          readonly github_connection_id: Uint8Array | null;
          readonly provider_id: string;
          readonly config: string;
        }>`
          SELECT s.id, s.created_at, s.spec,
                 -- The branch is used only once: the runner switches the main
                 -- workspace to it before this thread first runs. A resume
                 -- continues where the thread left off, and switching again
                 -- would change the branch under whatever the user has done in
                 -- that checkout since.
                 CASE WHEN s.started_at IS NULL THEN s.checkout_branch END AS checkout_branch,
                 s.github_connection_id, pi.provider_id, pi.config
          FROM sessions s JOIN provider_instances pi ON pi.id = s.instance_id
          WHERE s.runner_id = ${uuidFromString(runnerId)} AND s.status = 'queued'
            -- A session waits until its workspace is ready. Starting it
            -- earlier would give the harness a directory that does not exist
            -- yet.
            AND ${sql.literal(buildReadyClause("s"))}
            -- Continue after the previous batch's last row, on the same pair
            -- ORDER BY sorts by. The empty values a first batch passes sort
            -- before every real row.
            AND (s.created_at, s.id) > (${after?.createdAt ?? ""}, ${after === undefined ? new Uint8Array(0) : uuidFromString(after.id)})
          ORDER BY s.created_at ASC, s.id ASC
          LIMIT ${limit}
        `,
        (rows) =>
          rows.map((row) => ({
            id: uuidToString(row.id),
            createdAt: row.created_at,
            spec: row.spec,
            checkoutBranch: row.checkout_branch,
            githubConnectionId:
              row.github_connection_id === null ? null : uuidToString(row.github_connection_id),
            providerId: row.provider_id,
            config: JSON.parse(row.config) as unknown,
          })),
      ),

    /**
     * Ends every session in a workspace that has not exited, and returns those
     * rows as they were before. The caller runs it in a transaction.
     */
    endInWorkspace: (
      workspaceId: string,
      at: string,
    ): Effect.Effect<ReadonlyArray<StoredSession>, SqlError> =>
      endMatching(sql`workspace_id = ${uuidFromString(workspaceId)}`, at),

    /**
     * Ends every session still open on this runner, queued ones included, and
     * returns those rows as they were before. A caller retiring the runner
     * still has to send a stop to each one that was `starting`, `idle` or
     * `busy`. The caller runs it in a transaction.
     */
    endOnRunner: (
      runnerId: string,
      at: string,
    ): Effect.Effect<ReadonlyArray<StoredSession>, SqlError> =>
      endMatching(sql`runner_id = ${uuidFromString(runnerId)}`, at),

    /**
     * Ends every session on this runner that is `starting`, `idle` or `busy`
     * and is not in `held`, the list from the runner's sessions report.
     * Returns those rows as they were before. Only those three statuses are
     * affected, so a session already `exited`, or `queued` and never sent to
     * this runner, is left alone. The caller runs it in a transaction.
     */
    reportedGone: (
      runnerId: string,
      held: ReadonlyArray<string>,
      at: string,
    ): Effect.Effect<ReadonlyArray<StoredSession>, SqlError> =>
      endMatching(
        sql`runner_id = ${uuidFromString(runnerId)}
            AND status IN ('starting', 'idle', 'busy')
            AND ${held.length === 0 ? sql`1 = 1` : sql`id NOT IN ${sql.in(held.map(uuidFromString))}`}`,
        at,
      ),

    /**
     * Ends every running session on a lost runner: the runner is not in
     * `connected`, and nothing was heard about the session for longer than the
     * session's own absolute timeout. Returns those rows as they were before.
     * The caller runs it in a transaction.
     *
     * The absolute timeout is the bound because a runner stops every session
     * process at most that long after the process started, and
     * `last_activity_at` is never earlier than the start. Past the bound the
     * process is gone, or the runner is gone and can never report it. Before
     * the bound, the session can still run on a runner that is only out of
     * reach, and its token must keep working. One exception: a runner whose
     * machine was suspended does not count the suspended time, so its process
     * can outlive the bound. That runner lists the process in its report when
     * it returns, and the controller then stops it (`listExitedAmong`).
     *
     * A spec stored before the timeouts were on it has no absolute timeout, so
     * the default the runner applied to it at that time is the bound.
     */
    endOnLostRunners: (
      connected: ReadonlyArray<string>,
      at: string,
    ): Effect.Effect<ReadonlyArray<StoredSession>, SqlError> =>
      endMatching(
        sql`status IN ('starting', 'idle', 'busy')
            AND ${connected.length === 0 ? sql`1 = 1` : sql`runner_id NOT IN ${sql.in(connected.map(uuidFromString))}`}
            AND (julianday(${at}) - julianday(last_activity_at)) * 86400000
                > COALESCE(json_extract(spec, '$.timeouts.absoluteMs'), ${DEFAULT_ABSOLUTE_TIMEOUT_MS})`,
        at,
      ),

    /**
     * Returns the sessions in `held` (the runner's report) that the controller
     * has already marked `exited`. The caller tells the runner to stop each
     * one.
     */
    listExitedAmong: (
      runnerId: string,
      held: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyArray<string>, SqlError> =>
      held.length === 0
        ? Effect.succeed([])
        : Effect.map(
            sql<{ readonly id: Uint8Array }>`
              SELECT id FROM sessions
              WHERE runner_id = ${uuidFromString(runnerId)} AND status = 'exited'
                AND id IN ${sql.in(held.map(uuidFromString))}
            `,
            (rows) => rows.map((row) => uuidToString(row.id)),
          ),
  };
});

export const sessionRepository = make;

/** The session repository's methods. */
export type SessionRows = Effect.Success<typeof make>;

/** The error message every caller uses for a session id that matches no row. */
const NO_SUCH_SESSION = "no such session";

/**
 * Returns a function that reads one session by id from the given repository.
 * It fails with `NotFound` when there is no such session, with the same
 * message wherever it is used.
 */
export const readSessionOrFail =
  (rows: SessionRows) =>
  (id: string): Effect.Effect<StoredSession, NotFound | SqlError> =>
    Effect.flatMap(
      rows.one(id),
      Option.match({
        onNone: () => Effect.fail(createNotFoundError(NO_SUCH_SESSION)),
        onSome: Effect.succeed,
      }),
    );
