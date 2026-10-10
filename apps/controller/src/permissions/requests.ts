/**
 * Permission Request rows: a session asking the user for a grant its
 * Permission Profile lacks. This module only reads and writes them. Who may
 * ask, who may decide and what a decision changes are decided by the
 * Permission Request use case in the controller daemon.
 *
 * A request is `open` until it is decided or its session ends, which
 * withdraws it. The token check reads the grants of a session's requests
 * decided with outcome `session` under the session's current profile (see
 * `tokens.ts`), and the session record lists a session's open requests (see
 * `buildOpenPermissionRequestsColumn`).
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type {
  BoundOperation,
  Grant,
  PermissionDecisionOutcome,
  PermissionRequest,
} from "@hercule/contract";
import { mintUuid, uuidFromString, uuidHexToString, uuidToString } from "../db";

/** Where a request stands: open, decided by the user, or withdrawn when its session ended. */
type PermissionRequestStatus = "open" | "decided" | "withdrawn";

/** A Permission Request as it is stored. */
export interface StoredPermissionRequest {
  readonly id: string;
  readonly sessionId: string;
  /** The permission profile the session was on when it asked. */
  readonly profileId: string;
  readonly grant: Grant;
  readonly reason: string;
  readonly operation: BoundOperation | undefined;
  readonly status: PermissionRequestStatus;
  /** The user's decision; `null` unless the request is decided. */
  readonly outcome: PermissionDecisionOutcome | null;
  readonly createdAt: string;
  /** When the user decided it; `null` unless the request is decided. */
  readonly decidedAt: string | null;
}

/** The fields of a new request. The repository generates the id. */
export interface NewPermissionRequest {
  readonly sessionId: string;
  /** The permission profile the session is on as it asks. */
  readonly profileId: string;
  readonly grant: Grant;
  readonly reason: string;
  readonly operation: BoundOperation | undefined;
  /** The instant the request is made, which is its `createdAt`. */
  readonly at: string;
}

interface PermissionRequestRow {
  readonly id: Uint8Array;
  readonly session_id: Uint8Array;
  readonly profile_id: Uint8Array;
  readonly grant: string;
  readonly reason: string;
  readonly operation: string | null;
  readonly status: string;
  readonly outcome: string | null;
  readonly created_at: string;
  readonly decided_at: string | null;
}

const COLUMNS =
  "id, session_id, profile_id, grant, reason, operation, status, outcome, created_at, decided_at";

const toPermissionRequest = (row: PermissionRequestRow): StoredPermissionRequest => ({
  id: uuidToString(row.id),
  sessionId: uuidToString(row.session_id),
  profileId: uuidToString(row.profile_id),
  grant: row.grant as Grant,
  reason: row.reason,
  operation: row.operation === null ? undefined : (JSON.parse(row.operation) as BoundOperation),
  status: row.status as PermissionRequestStatus,
  outcome: row.outcome as PermissionDecisionOutcome | null,
  createdAt: row.created_at,
  decidedAt: row.decided_at,
});

/**
 * Builds the SQL for a column that holds the open Permission Requests of the
 * session in `sessionTable`, oldest first, as a JSON array. A query over
 * sessions selects it, so a page of session records reads its requests with
 * the page, through the `permission_requests_by_session` index. Parse the
 * column with `parseOpenPermissionRequests`.
 *
 * The ids are written as hex, because JSON cannot carry the stored bytes.
 */
export const buildOpenPermissionRequestsColumn = (sessionTable: string): string =>
  "(SELECT json_group_array(json_object('id', hex(id), 'grant', grant, 'reason', reason, " +
  "'operation', json(operation), 'createdAt', created_at)) FROM (SELECT * FROM permission_requests " +
  `WHERE permission_requests.session_id = ${sessionTable}.id AND status = 'open' ` +
  "ORDER BY created_at, id))";

/**
 * Builds the SQL for a column that holds, as a JSON array, the grants of the
 * requests of the session in `sessionTable` that were decided with outcome
 * `session` under the profile the session is on now. A session holds these
 * grants on top of its profile's (see `tokens.ts`).
 */
export const buildSessionGrantsColumn = (sessionTable: string): string =>
  "(SELECT json_group_array(r.grant) FROM permission_requests r " +
  `WHERE r.session_id = ${sessionTable}.id AND r.profile_id = ${sessionTable}.permission_profile_id ` +
  "AND r.status = 'decided' AND r.outcome = 'session')";

interface OpenPermissionRequestColumnEntry {
  readonly id: string;
  readonly grant: Grant;
  readonly reason: string;
  readonly operation: BoundOperation | null;
  readonly createdAt: string;
}

/**
 * Parses the column `buildOpenPermissionRequestsColumn` selects into the
 * open requests a session record lists, oldest first.
 */
export const parseOpenPermissionRequests = (column: string): ReadonlyArray<PermissionRequest> =>
  (JSON.parse(column) as ReadonlyArray<OpenPermissionRequestColumnEntry>).map((entry) => ({
    id: uuidHexToString(entry.id),
    grant: entry.grant,
    reason: entry.reason,
    ...(entry.operation === null ? {} : { operation: entry.operation }),
    createdAt: entry.createdAt,
  }));

/** Builds the Permission Request repository on the database client. */
export const permissionRequestRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return {
    /** Stores a new open request and returns its id. */
    insert: (request: NewPermissionRequest): Effect.Effect<string, SqlError> =>
      Effect.gen(function* () {
        const id = mintUuid();
        yield* sql`
          INSERT INTO permission_requests (id, session_id, profile_id, grant, reason, operation,
                                           status, created_at)
          VALUES (${id}, ${uuidFromString(request.sessionId)},
                  ${uuidFromString(request.profileId)}, ${request.grant}, ${request.reason},
                  ${request.operation === undefined ? null : JSON.stringify(request.operation)},
                  'open', ${request.at})
        `;
        return uuidToString(id);
      }),

    /** Returns the request with the id, or `None` if there is none. */
    read: (id: string): Effect.Effect<Option.Option<StoredPermissionRequest>, SqlError> =>
      Effect.map(
        sql<PermissionRequestRow>`
          SELECT ${sql.literal(COLUMNS)} FROM permission_requests WHERE id = ${uuidFromString(id)}`,
        (rows) => Option.map(Option.fromNullishOr(rows[0]), toPermissionRequest),
      ),

    /**
     * Returns the id of the session's open request for the grant, or `None`
     * when the session is not waiting on one. A unique index allows at most
     * one open request per session and grant.
     */
    findOpen: (sessionId: string, grant: Grant): Effect.Effect<Option.Option<string>, SqlError> =>
      Effect.map(
        sql<{ readonly id: Uint8Array }>`
          SELECT id FROM permission_requests
          WHERE session_id = ${uuidFromString(sessionId)} AND status = 'open'
            AND grant = ${grant}`,
        (rows) => Option.map(Option.fromNullishOr(rows[0]), (row) => uuidToString(row.id)),
      ),

    /**
     * Returns the grants the session holds through its requests decided with
     * outcome `session` under the profile it is on now. The session's profile
     * grants are not included. Returns an empty list when there is no such
     * session.
     */
    listSessionGrants: (sessionId: string): Effect.Effect<ReadonlyArray<Grant>, SqlError> =>
      Effect.map(
        sql<{ readonly grants: string }>`
          SELECT ${sql.literal(buildSessionGrantsColumn("s"))} AS grants
          FROM sessions s WHERE s.id = ${uuidFromString(sessionId)}`,
        (rows) => (rows[0] === undefined ? [] : (JSON.parse(rows[0].grants) as Array<Grant>)),
      ),

    /**
     * Records the user's decision on an open request. The caller has read the
     * request in the same transaction and checked that it is open.
     */
    decide: (
      id: string,
      outcome: PermissionDecisionOutcome,
      at: string,
    ): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE permission_requests SET status = 'decided', outcome = ${outcome}, decided_at = ${at}
        WHERE id = ${uuidFromString(id)} AND status = 'open'`),

    /**
     * Withdraws every open request of these sessions, because the sessions
     * ended and no decision can reach them. Returns the withdrawn requests'
     * ids. One statement covers every session.
     */
    withdrawOpen: (
      sessionIds: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyArray<string>, SqlError> =>
      sessionIds.length === 0
        ? Effect.succeed([])
        : Effect.map(
            sql<{ readonly id: Uint8Array }>`
              UPDATE permission_requests SET status = 'withdrawn'
              WHERE status = 'open'
                AND session_id IN ${sql.in(sessionIds.map(uuidFromString))}
              RETURNING id`,
            (rows) => rows.map((row) => uuidToString(row.id)),
          ),
  };
});
