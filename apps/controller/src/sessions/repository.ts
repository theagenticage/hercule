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
import type { AccessMode, ModelSelection, OpenRequest, ProviderEvent } from "@hydra/protocol";
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
  readonly title: string;
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
  readonly openRequest: OpenRequest | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly exitedAt: string | null;
  readonly lastActivityAt: string;
}

export interface NewSession {
  readonly title: string;
  readonly permissionProfileId: string;
  readonly instanceId: string;
  readonly runnerId: string;
  readonly workspaceId: string | null;
  readonly requestedAccessMode: AccessMode;
  readonly accessMode: AccessMode;
  /** The encoded `SessionSpec`, stored as the exact string that goes on the wire. */
  readonly spec: string;
  readonly modelSelection: ModelSelection;
  readonly parentSessionId: string | undefined;
  readonly at: string;
}

export interface SessionPageRequest {
  readonly limit: number;
  readonly cursor: string | undefined;
  readonly direction: SortDirection;
  readonly status: SessionStatus | ReadonlyArray<SessionStatus> | undefined;
  readonly runnerId: string | undefined;
}

interface SessionRow {
  readonly id: Uint8Array;
  readonly title: string;
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
  readonly open_request: string | null;
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
  "id, title, permission_profile_id, instance_id, runner_id, workspace_id, requested_access_mode, " +
  `access_mode, native_session_id, model_selection, parent_session_id, status, ` +
  `open_request, created_at, started_at, exited_at, ` +
  `last_activity_at, ${RESUMABLE}`;

const toSession = (row: SessionRow): StoredSession => ({
  id: uuidToString(row.id),
  title: row.title,
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
  openRequest: row.open_request === null ? null : (JSON.parse(row.open_request) as OpenRequest),
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

/** Where a session's ingest stands: see `ingestState`. */
export interface IngestState {
  readonly lastSeq: number;
  /** Added to every sequence this session's current process reports. */
  readonly base: number;
}

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

  /**
   * One status is `=`; several - the runner page's capacity read - is `IN`.
   * The contract requires at least one element in the array, so there is no
   * empty case here to guard.
   */
  const statusClause = (status: SessionStatus | ReadonlyArray<SessionStatus>) =>
    Array.isArray(status) ? sql`status IN ${sql.in(status)}` : sql`status = ${status}`;

  return {
    insert: (session: NewSession): Effect.Effect<StoredSession, SqlError> =>
      Effect.gen(function* () {
        const id = mintUuid();
        const parent =
          session.parentSessionId === undefined ? null : uuidFromString(session.parentSessionId);
        const workspace = session.workspaceId === null ? null : uuidFromString(session.workspaceId);
        yield* sql`
          INSERT INTO sessions (id, title, permission_profile_id, instance_id, runner_id,
                                workspace_id, requested_access_mode, access_mode, spec,
                                model_selection, parent_session_id, status,
                                created_at, last_activity_at)
          VALUES (${id}, ${session.title}, ${uuidFromString(session.permissionProfileId)},
                  ${uuidFromString(session.instanceId)}, ${uuidFromString(session.runnerId)},
                  ${workspace}, ${session.requestedAccessMode}, ${session.accessMode},
                  ${session.spec}, ${JSON.stringify(session.modelSelection)}, ${parent},
                  'queued', ${session.at}, ${session.at})
        `;
        return {
          id: uuidToString(id),
          title: session.title,
          permissionProfileId: session.permissionProfileId,
          instanceId: session.instanceId,
          runnerId: session.runnerId,
          workspaceId: session.workspaceId,
          requestedAccessMode: session.requestedAccessMode,
          accessMode: session.accessMode,
          nativeSessionId: null,
          modelSelection: session.modelSelection,
          parentSessionId: session.parentSessionId ?? null,
          status: "queued",
          resumable: false,
          openRequest: null,
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
        if (request.status !== undefined) clauses.push(statusClause(request.status));
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
     * Where ingest stands for this session: the highest sequence already
     * written, and what the current process's own numbers are counted from.
     *
     * A high-water mark, not a contiguous prefix: a coalesced delta row carries
     * the sequence of the last delta folded into it, so a plain event can be
     * written under a higher sequence while lower text is still only held.
     * Nothing replays today; the outbox of spec 03 section 2.3 will need more.
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
     * Moves the session and stamps the activity. `startedAt` is written once:
     * it is when the conversation first came up, and a session resumed later
     * does not get a new one. `exitedAt` is the last exit, so every move to
     * `exited` stamps it afresh.
     *
     * The WHERE clause is what keeps an exited session where it is: this row
     * has two writers - ingest, and the spawn that could not reach its machine
     * - so a status read before a transaction proves nothing inside it. The
     * one move out of `exited` is `resume` below, and nothing else.
     */
    moved: (sessionId: string, status: SessionStatus, at: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE sessions SET
          status = ${status},
          last_activity_at = ${at},
          started_at = CASE WHEN started_at IS NULL AND ${status} IN ('idle', 'busy') THEN ${at}
                            ELSE started_at END,
          exited_at = CASE WHEN ${status} = 'exited' THEN ${at} ELSE exited_at END
        WHERE id = ${uuidFromString(sessionId)} AND status <> 'exited'
      `),

    /**
     * The move to `starting` dispatch makes, carrying the hash of the token it
     * minted for that start. One statement rather than a move and a write: the
     * row may hold a credential exactly because it is starting, and the two
     * facts are never separately true. `moved`'s rule applies unchanged - an
     * exited session is not restarted from here.
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
     * The one move out of `exited`, and so the one exception to `moved`'s rule
     * above: the session goes back on the queue for dispatch to place, under
     * the spec its resumed harness is to be started with. The caller's read of
     * `resumable` inside this same transaction is the licence for the write.
     *
     * The token goes with the process that held it. A queued session has no
     * harness running, so there is nothing for a credential to be the identity
     * of, and leaving the old hash here would let a token that leaked before
     * the exit act again from the moment the session is put back on the queue.
     * Dispatch mints the resumed process one of its own.
     *
     * The base every reported sequence is counted from moves up to what the
     * stored stream reached, unconditionally: the controller cannot tell
     * whether the machine's process restarted and so began numbering from zero
     * again. Moving it anyway is harmless, because `runner_seq` is only a
     * dedupe key and the transcript reads back in `position` order.
     */
    resume: (sessionId: string, spec: string, at: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE sessions SET
          status = 'queued',
          spec = ${spec},
          last_activity_at = ${at},
          open_request = NULL,
          token_hash = NULL,
          stream_base = (SELECT COALESCE(MAX(runner_seq), 0) FROM session_stream
                         WHERE session_id = sessions.id)
        WHERE id = ${uuidFromString(sessionId)}
      `),

    /**
     * The hash of the session's own credential on the public API, or `null`
     * where the start it was minted for never reached the machine. Written by
     * the same transaction as the move it belongs to, which is what decides
     * whether the row may hold one at all.
     */
    setTokenHash: (sessionId: string, tokenHash: string | null): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE sessions SET token_hash = ${tokenHash} WHERE id = ${uuidFromString(sessionId)}
      `),

    /**
     * The model and the per-model choices the session runs under from here on.
     * `spec` is left alone: it is the document the runner was told at start,
     * and only `resume` above rewrites it, for the start it is about to make.
     */
    setModelSelection: (
      sessionId: string,
      modelSelection: ModelSelection,
    ): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE sessions SET model_selection = ${JSON.stringify(modelSelection)}
        WHERE id = ${uuidFromString(sessionId)}
      `),

    /** The request the machine says it is parked on, or `null` for none. */
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

    /**
     * This runner's oldest queued sessions, up to `limit`, with what it takes
     * to tell the machine to start each: the exact spec document it was
     * queued with, and the provider it was opened against. Joined rather than
     * looked up per row, so dispatch reads it in one statement.
     */
    oldestQueued: (
      runnerId: string,
      limit: number,
    ): Effect.Effect<
      ReadonlyArray<{
        readonly id: string;
        readonly spec: string;
        readonly providerId: string;
        readonly config: unknown;
      }>,
      SqlError
    > =>
      Effect.map(
        sql<{
          readonly id: Uint8Array;
          readonly spec: string;
          readonly provider_id: string;
          readonly config: string;
        }>`
          SELECT s.id, s.spec, pi.provider_id, pi.config
          FROM sessions s JOIN provider_instances pi ON pi.id = s.instance_id
          WHERE s.runner_id = ${uuidFromString(runnerId)} AND s.status = 'queued'
          ORDER BY s.created_at ASC, s.id ASC
          LIMIT ${limit}
        `,
        (rows) =>
          rows.map((row) => ({
            id: uuidToString(row.id),
            spec: row.spec,
            providerId: row.provider_id,
            config: JSON.parse(row.config) as unknown,
          })),
      ),

    /**
     * Ends every session this runner still holds open. `toStop` is what was
     * `starting`, `idle` or `busy` before this call - read first, because the
     * update below turns all of it into `exited` and there would be nothing
     * left to tell apart - which is what a caller ending the runner itself
     * still has to send a stop for; `ended` is every id this call moved,
     * queued ones included, for the caller to cancel inputs on and announce.
     */
    endOnRunner: (
      runnerId: string,
      at: string,
    ): Effect.Effect<
      { readonly ended: ReadonlyArray<string>; readonly toStop: ReadonlyArray<string> },
      SqlError
    > =>
      Effect.gen(function* () {
        const key = uuidFromString(runnerId);
        const toStopRows = yield* sql<{ readonly id: Uint8Array }>`
          SELECT id FROM sessions WHERE runner_id = ${key} AND status IN ('starting', 'idle', 'busy')
        `;
        const endedRows = yield* sql<{ readonly id: Uint8Array }>`
          UPDATE sessions SET
            status = 'exited',
            last_activity_at = ${at},
            open_request = NULL,
            exited_at = CASE WHEN exited_at IS NULL THEN ${at} ELSE exited_at END
          WHERE runner_id = ${key} AND status <> 'exited'
          RETURNING id
        `;
        return {
          ended: endedRows.map((row) => uuidToString(row.id)),
          toStop: toStopRows.map((row) => uuidToString(row.id)),
        };
      }),

    /**
     * Ends every session on this runner that is `starting`, `idle` or `busy`
     * and that `held` does not name: what a sessions report says this runner
     * no longer has. Scoped to those three statuses so a session already
     * `exited`, or `queued` and never told to this runner, is untouched.
     */
    reportedGone: (
      runnerId: string,
      held: ReadonlyArray<string>,
      at: string,
    ): Effect.Effect<ReadonlyArray<string>, SqlError> =>
      Effect.map(
        sql<{ readonly id: Uint8Array }>`
          UPDATE sessions SET
            status = 'exited',
            last_activity_at = ${at},
            open_request = NULL,
            exited_at = CASE WHEN exited_at IS NULL THEN ${at} ELSE exited_at END
          WHERE runner_id = ${uuidFromString(runnerId)}
            AND status IN ('starting', 'idle', 'busy')
            AND ${held.length === 0 ? sql`1 = 1` : sql`id NOT IN ${sql.in(held.map(uuidFromString))}`}
          RETURNING id
        `,
        (rows) => rows.map((row) => uuidToString(row.id)),
      ),
  };
});

export const sessionRepository = make;
