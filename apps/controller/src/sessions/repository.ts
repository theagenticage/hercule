/**
 * Session rows and the append-only stream beside them. Nothing here decides
 * policy: placement, the access-mode fallback and the status axis are the
 * service's and the fold's.
 *
 * `resumable` is computed in the SELECT rather than stored: a stored copy would
 * go stale the moment a runner is retired.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { AccessMode, ModelSelection, ProviderEvent } from "@hydra/protocol";
import type { SessionStatus, SortDirection } from "@hydra/contract";
import {
  decodeCursor,
  decodeIdCursor,
  encodeCursor,
  encodeIdCursor,
  keysetOver,
  mintUuid,
  pageOf,
  uuidFromString,
  uuidToString,
  type CursorError,
  type CursorScope,
  type Page,
} from "../db";
import type { StreamRow } from "./stream";

/** A session as it is stored. `resumable` is derived at read; see above. */
export interface StoredSession {
  readonly id: string;
  readonly permissionProfileId: string;
  readonly instanceId: string;
  readonly runnerId: string;
  readonly workspaceId: string | null;
  readonly requestedAccessMode: AccessMode;
  readonly accessMode: AccessMode;
  readonly nativeSessionId: string | null;
  readonly modelSelection: ModelSelection;
  readonly parentSessionId: string | null;
  readonly status: SessionStatus;
  readonly resumable: boolean;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly exitedAt: string | null;
  readonly lastActivityAt: string;
}

export interface NewSession {
  readonly permissionProfileId: string;
  readonly instanceId: string;
  readonly runnerId: string;
  readonly workspaceId: string | null;
  readonly requestedAccessMode: AccessMode;
  readonly accessMode: AccessMode;
  /** The encoded `SessionSpec`, stored as the exact string that goes on the wire. */
  readonly spec: string;
  readonly modelSelection: ModelSelection;
  /**
   * Known at insert only where the session resumes another one: it carries on
   * the same provider-native session, so there is nothing to wait to be told.
   * A fresh session and a fork are both named by the machine and bound later.
   */
  readonly nativeSessionId: string | undefined;
  readonly parentSessionId: string | undefined;
  readonly at: string;
}

export interface SessionPageRequest {
  readonly limit: number;
  readonly cursor: string | undefined;
  readonly direction: SortDirection;
  readonly status: SessionStatus | undefined;
  readonly runnerId: string | undefined;
}

interface SessionRow {
  readonly id: Uint8Array;
  readonly permission_profile_id: Uint8Array;
  readonly instance_id: Uint8Array;
  readonly runner_id: Uint8Array;
  readonly workspace_id: Uint8Array | null;
  readonly requested_access_mode: string;
  readonly access_mode: string;
  readonly native_session_id: string | null;
  readonly model_selection: string;
  readonly parent_session_id: Uint8Array | null;
  readonly status: string;
  readonly resumable: number;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly exited_at: string | null;
  readonly last_activity_at: string;
}

/** Spec 06 section 4.1's derived `resumable`, in one expression. */
const RESUMABLE =
  "(status = 'exited' AND native_session_id IS NOT NULL AND EXISTS " +
  "(SELECT 1 FROM runners WHERE runners.id = sessions.runner_id " +
  "AND runners.lifecycle <> 'retired')) AS resumable";

const COLUMNS =
  "id, permission_profile_id, instance_id, runner_id, workspace_id, requested_access_mode, " +
  `access_mode, native_session_id, model_selection, parent_session_id, status, ` +
  `created_at, started_at, exited_at, ` +
  `last_activity_at, ${RESUMABLE}`;

const toSession = (row: SessionRow): StoredSession => ({
  id: uuidToString(row.id),
  permissionProfileId: uuidToString(row.permission_profile_id),
  instanceId: uuidToString(row.instance_id),
  runnerId: uuidToString(row.runner_id),
  workspaceId: row.workspace_id === null ? null : uuidToString(row.workspace_id),
  requestedAccessMode: row.requested_access_mode as AccessMode,
  accessMode: row.access_mode as AccessMode,
  nativeSessionId: row.native_session_id,
  modelSelection: JSON.parse(row.model_selection) as ModelSelection,
  parentSessionId: row.parent_session_id === null ? null : uuidToString(row.parent_session_id),
  status: row.status as SessionStatus,
  resumable: row.resumable === 1,
  createdAt: row.created_at,
  startedAt: row.started_at,
  exitedAt: row.exited_at,
  lastActivityAt: row.last_activity_at,
});

const scopeOf = (direction: SortDirection): CursorScope => ({
  op: "session.query",
  field: "createdAt",
  direction,
});

/**
 * The transcript walk. Its key is the position, which is per session, so the
 * session is part of the walk the cursor belongs to: without it one session's
 * cursor would silently hide rows on another's transcript.
 */
const transcriptScope = (sessionId: string, direction: SortDirection): CursorScope => ({
  op: "transcript.read",
  field: `position:${sessionId}`,
  direction,
});

/** One row of a session's stream, as the transcript reads it back. */
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

  return {
    insert: (session: NewSession): Effect.Effect<StoredSession, SqlError> =>
      Effect.gen(function* () {
        const id = mintUuid();
        const parent =
          session.parentSessionId === undefined ? null : uuidFromString(session.parentSessionId);
        const workspace = session.workspaceId === null ? null : uuidFromString(session.workspaceId);
        yield* sql`
          INSERT INTO sessions (id, permission_profile_id, instance_id, runner_id, workspace_id,
                                requested_access_mode, access_mode, spec, model_selection,
                                native_session_id, parent_session_id, status, created_at,
                                last_activity_at)
          VALUES (${id}, ${uuidFromString(session.permissionProfileId)},
                  ${uuidFromString(session.instanceId)}, ${uuidFromString(session.runnerId)},
                  ${workspace}, ${session.requestedAccessMode}, ${session.accessMode},
                  ${session.spec}, ${JSON.stringify(session.modelSelection)},
                  ${session.nativeSessionId ?? null}, ${parent},
                  'starting', ${session.at}, ${session.at})
        `;
        return {
          id: uuidToString(id),
          permissionProfileId: session.permissionProfileId,
          instanceId: session.instanceId,
          runnerId: session.runnerId,
          workspaceId: session.workspaceId,
          requestedAccessMode: session.requestedAccessMode,
          accessMode: session.accessMode,
          nativeSessionId: session.nativeSessionId ?? null,
          modelSelection: session.modelSelection,
          parentSessionId: session.parentSessionId ?? null,
          status: "starting",
          resumable: false,
          createdAt: session.at,
          startedAt: null,
          exitedAt: null,
          lastActivityAt: session.at,
        };
      }),

    one: (id: string): Effect.Effect<Option.Option<StoredSession>, SqlError> =>
      Effect.map(
        sql<SessionRow>`
          SELECT ${sql.literal(COLUMNS)} FROM sessions WHERE id = ${uuidFromString(id)}
        `,
        (rows) => Option.map(Option.fromNullishOr(rows[0]), toSession),
      ),

    list: (
      request: SessionPageRequest,
    ): Effect.Effect<Page<StoredSession>, CursorError | SqlError> =>
      Effect.gen(function* () {
        const scope = scopeOf(request.direction);
        const after =
          request.cursor === undefined
            ? undefined
            : yield* decodeCursor(request.cursor, scope, "string");
        const { keyset, order } = keysetOver(
          sql,
          ["created_at", "id"],
          after === undefined ? undefined : [after[0], uuidFromString(after[1])],
          request.direction,
        );
        const clauses = [keyset];
        if (request.status !== undefined) clauses.push(sql`status = ${request.status}`);
        if (request.runnerId !== undefined) {
          clauses.push(sql`runner_id = ${uuidFromString(request.runnerId)}`);
        }
        const rows = yield* sql<SessionRow>`
          SELECT ${sql.literal(COLUMNS)} FROM sessions
          WHERE ${sql.and(clauses)} ${order} LIMIT ${request.limit + 1}
        `;
        return yield* pageOf(
          rows,
          request.limit,
          (found) => Effect.succeed(found.map(toSession)),
          (last) => encodeCursor(scope, last.createdAt, last.id),
        );
      }),

    /**
     * One page of a session's stream, in position order. The stored `event` is
     * parsed back rather than re-decoded: the schema it was written from has no
     * transform in it, so the document is the value.
     */
    transcript: (
      request: TranscriptPageRequest,
    ): Effect.Effect<Page<StoredStreamRow>, CursorError | SqlError> =>
      Effect.gen(function* () {
        const scope = transcriptScope(request.sessionId, request.direction);
        const after =
          request.cursor === undefined ? undefined : yield* decodeIdCursor(request.cursor, scope);
        const { keyset, order } = keysetOver(
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
        return yield* pageOf(
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
          (last) => encodeIdCursor(scope, last.position),
        );
      }),

    /**
     * The highest runner sequence already written for this session, where
     * ingest resumes after a restart.
     *
     * A high-water mark, not a contiguous prefix: a coalesced delta row carries
     * the sequence of the last delta folded into it, so a plain event can be
     * written under a higher sequence while lower text is still only held.
     * Nothing replays today; the outbox of spec 03 section 2.3 will need more.
     */
    lastSeq: (sessionId: string): Effect.Effect<number, SqlError> =>
      Effect.map(
        sql<{ readonly last: number | null }>`
          SELECT MAX(runner_seq) AS last FROM session_stream
          WHERE session_id = ${uuidFromString(sessionId)}
        `,
        (rows) => rows[0]?.last ?? 0,
      ),

    /**
     * Appends one row at the next position for this session. A sequence number
     * already written hits the unique index and does nothing, which is what
     * makes a replayed frame harmless.
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
     * Moves the session and stamps the activity. `startedAt` and `exitedAt` are
     * written once, so a second `session.started` cannot rewrite when it came up.
     *
     * The WHERE clause is what makes `exited` final (spec 06 section 4.1): this
     * row has two writers - ingest, and the spawn that could not reach its
     * machine - so a status read before a transaction proves nothing inside it.
     */
    moved: (sessionId: string, status: SessionStatus, at: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE sessions SET
          status = ${status},
          last_activity_at = ${at},
          started_at = CASE WHEN started_at IS NULL AND ${status} IN ('idle', 'busy') THEN ${at}
                            ELSE started_at END,
          exited_at = CASE WHEN ${status} = 'exited' AND exited_at IS NULL THEN ${at}
                           ELSE exited_at END
        WHERE id = ${uuidFromString(sessionId)} AND status <> 'exited'
      `),

    /**
     * Whether any session is still live against this provider-native session.
     * Two harnesses writing one native transcript corrupts it beyond anything
     * Hydra could repair (spec 06 section 4.1), so a resume asks first.
     */
    liveOn: (nativeSessionId: string): Effect.Effect<boolean, SqlError> =>
      Effect.map(
        sql<{ readonly id: Uint8Array }>`
          SELECT id FROM sessions
          WHERE native_session_id = ${nativeSessionId} AND status <> 'exited' LIMIT 1
        `,
        (rows) => rows.length > 0,
      ),

    /**
     * The model the session runs under from here on. `spec` is left alone: it
     * is the document the runner was told at start, and rewriting it would
     * destroy the record of what that was.
     */
    remodel: (sessionId: string, modelSelection: ModelSelection): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE sessions SET model_selection = ${JSON.stringify(modelSelection)}
        WHERE id = ${uuidFromString(sessionId)}
      `),

    touched: (sessionId: string, at: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(
        sql`UPDATE sessions SET last_activity_at = ${at} WHERE id = ${uuidFromString(sessionId)}`,
      ),

    /**
     * Records the provider-native id a runner reported for a session it holds.
     * The runner and the instance are both in the WHERE clause: a machine may
     * only speak for the sessions placed on it, and only about the instance
     * those sessions were opened against.
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
  };
});

export const sessionRepository = make;
