/**
 * Reads and writes the `connections` table. It handles rows only: credentials
 * live in the `secrets` table, and the caller that returns a connection adds
 * their references.
 */
import type * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { ConnectionStatus } from "@hercule/plugin-host";
import { GITHUB_CONNECTION_TYPE } from "@hercule/contract";
import {
  mintUuid,
  buildPage,
  prepareKeysetListing,
  uuidFromString,
  uuidToString,
  type CursorError,
  type Page,
  type ResolvedSortKey,
  type SortColumn,
} from "../db";

/** The type of the GitHub connection that ships with Hercule. The contract defines it. */
export { GITHUB_CONNECTION_TYPE };

/** Checks whether this connection has the GitHub type, the type a repo resource acts through. */
export const isGithubConnection = (connection: StoredConnection): boolean =>
  connection.type === GITHUB_CONNECTION_TYPE;

/** A connection row, with its JSON columns read. */
export interface StoredConnection {
  readonly id: string;
  readonly pluginId: string;
  readonly type: string;
  readonly label: string;
  readonly displayName: string;
  /** The provider's stable id for the account, which a reconnect compares. */
  readonly accountId: string;
  readonly status: ConnectionStatus;
  readonly statusDetail: string | undefined;
  readonly labels: ReadonlyArray<string>;
  readonly config: Record<string, Schema.Json>;
  /**
   * The user's own poll interval for each feed, in seconds, keyed by feed
   * name. A feed missing from it is polled at its plugin's default.
   */
  readonly feedIntervals: Readonly<Record<string, number>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Everything a new connection row holds. */
export interface NewConnection {
  readonly pluginId: string;
  readonly type: string;
  readonly label: string;
  readonly displayName: string;
  readonly accountId: string;
  readonly labels: ReadonlyArray<string>;
  readonly config: Record<string, Schema.Json>;
  readonly at: string;
}

/** The columns an update may set. An absent field is left unchanged. */
export interface ConnectionEdit {
  readonly label?: string;
  readonly labels?: ReadonlyArray<string>;
  readonly config?: Record<string, Schema.Json>;
  readonly feedIntervals?: Readonly<Record<string, number>>;
  readonly displayName?: string;
  readonly status?: ConnectionStatus;
  /** `null` clears the detail, as when the status goes back to `connected`. */
  readonly statusDetail?: string | null;
}

/** A field a connection listing can be sorted by. */
export type ConnectionSortField = "createdAt" | "label";

/**
 * A listing request: the filters, the page size, the cursor and the sort keys.
 * `sort` holds the keys most significant first, with their directions
 * resolved.
 */
export interface ConnectionListRequest {
  readonly type: string | undefined;
  readonly status: ConnectionStatus | undefined;
  readonly limit: number;
  readonly cursor: string | undefined;
  readonly sort: Arr.NonEmptyReadonlyArray<ResolvedSortKey<ConnectionSortField>>;
}

interface ConnectionRow {
  readonly id: Uint8Array;
  readonly plugin_id: string;
  readonly type: string;
  readonly label: string;
  readonly display_name: string;
  readonly account_id: string;
  readonly status: ConnectionStatus;
  readonly status_detail: string | null;
  readonly labels: string;
  readonly config: string;
  readonly feed_intervals: string;
  readonly created_at: string;
  readonly updated_at: string;
}

const COLUMNS =
  "id, plugin_id, type, label, display_name, account_id, status, status_detail, labels, config, " +
  "feed_intervals, created_at, updated_at";

/** How a connection listing sorts by each of its sortable fields. */
const CONNECTION_SORT_COLUMNS: Record<ConnectionSortField, SortColumn<StoredConnection>> = {
  createdAt: {
    column: "created_at",
    valueType: "string",
    readValue: (connection) => connection.createdAt,
  },
  label: { column: "label", valueType: "string", readValue: (connection) => connection.label },
};

/**
 * Parses a JSON column. Only this repository writes the JSON columns, so a
 * column that does not parse means the database is broken, not an error a
 * caller can act on.
 */
const parseJson = <A>(text: string): A => JSON.parse(text) as A;

const toConnection = (row: ConnectionRow): StoredConnection => ({
  id: uuidToString(row.id),
  pluginId: row.plugin_id,
  type: row.type,
  label: row.label,
  displayName: row.display_name,
  accountId: row.account_id,
  status: row.status,
  statusDetail: row.status_detail ?? undefined,
  labels: parseJson<ReadonlyArray<string>>(row.labels),
  config: parseJson<Record<string, Schema.Json>>(row.config),
  feedIntervals: parseJson<Record<string, number>>(row.feed_intervals),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const one = (id: string): Effect.Effect<Option.Option<StoredConnection>, SqlError> =>
    Effect.map(
      sql<ConnectionRow>`SELECT ${sql.literal(COLUMNS)} FROM connections
                         WHERE id = ${uuidFromString(id)}`,
      (rows) => Option.fromNullishOr(rows[0]).pipe(Option.map(toConnection)),
    );

  return {
    one,

    /**
     * Returns a map from Connection id to its qualified type, using one query.
     * An id with no Connection is missing from the map.
     */
    readTypes: (
      ids: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyMap<string, string>, SqlError> =>
      ids.length === 0
        ? Effect.succeed(new Map())
        : Effect.map(
            sql<{ readonly id: Uint8Array; readonly type: string }>`
              SELECT id, type FROM connections WHERE id IN ${sql.in(ids.map(uuidFromString))}
            `,
            (rows) => new Map(rows.map((row) => [uuidToString(row.id), row.type])),
          ),

    insert: (connection: NewConnection): Effect.Effect<StoredConnection, SqlError> =>
      Effect.gen(function* () {
        const id = mintUuid();
        yield* sql`
          INSERT INTO connections
            (id, plugin_id, type, label, display_name, account_id, status, status_detail, labels,
             config, created_at, updated_at)
          VALUES
            (${id}, ${connection.pluginId}, ${connection.type}, ${connection.label},
             ${connection.displayName}, ${connection.accountId}, 'connected', ${null},
             ${JSON.stringify(connection.labels)}, ${JSON.stringify(connection.config)},
             ${connection.at}, ${connection.at})
        `;
        return {
          id: uuidToString(id),
          pluginId: connection.pluginId,
          type: connection.type,
          label: connection.label,
          displayName: connection.displayName,
          accountId: connection.accountId,
          status: "connected",
          statusDetail: undefined,
          labels: connection.labels,
          config: connection.config,
          feedIntervals: {},
          createdAt: connection.at,
          updatedAt: connection.at,
        };
      }),

    /** Applies an update and sets `updated_at`. Only the columns the update sets are written. */
    update: (id: string, edit: ConnectionEdit, at: string): Effect.Effect<void, SqlError> => {
      const sets = [sql`updated_at = ${at}`];
      if (edit.label !== undefined) sets.push(sql`label = ${edit.label}`);
      if (edit.labels !== undefined) sets.push(sql`labels = ${JSON.stringify(edit.labels)}`);
      if (edit.config !== undefined) sets.push(sql`config = ${JSON.stringify(edit.config)}`);
      if (edit.feedIntervals !== undefined) {
        sets.push(sql`feed_intervals = ${JSON.stringify(edit.feedIntervals)}`);
      }
      if (edit.displayName !== undefined) sets.push(sql`display_name = ${edit.displayName}`);
      if (edit.status !== undefined) sets.push(sql`status = ${edit.status}`);
      if (edit.statusDetail !== undefined) sets.push(sql`status_detail = ${edit.statusDetail}`);
      return Effect.asVoid(
        sql`UPDATE connections SET ${sql.csv(sets)} WHERE id = ${uuidFromString(id)}`,
      );
    },

    /**
     * Sets the status and its detail, and `updated_at`, but only while the
     * current status is one of `from`. Returns whether the row changed.
     *
     * The ingest loops write status from a fiber that runs beside the user's
     * own changes. The condition stops a loop from overwriting a change it
     * did not see, such as the user disabling the Connection while a poll
     * was failing.
     */
    changeStatusFrom: (
      id: string,
      from: ReadonlyArray<ConnectionStatus>,
      status: ConnectionStatus,
      detail: string | null,
      at: string,
    ): Effect.Effect<boolean, SqlError> =>
      Effect.map(
        sql<{ readonly id: Uint8Array }>`
          UPDATE connections SET status = ${status}, status_detail = ${detail}, updated_at = ${at}
          WHERE id = ${uuidFromString(id)} AND status IN ${sql.in(from)}
          RETURNING id
        `,
        (rows) => rows.length > 0,
      ),

    /** Lists every connection whose status is one of `statuses`, oldest first. */
    listByStatus: (
      statuses: ReadonlyArray<ConnectionStatus>,
    ): Effect.Effect<ReadonlyArray<StoredConnection>, SqlError> =>
      Effect.map(
        sql<ConnectionRow>`SELECT ${sql.literal(COLUMNS)} FROM connections
                           WHERE status IN ${sql.in(statuses)} ORDER BY created_at, id`,
        (rows) => rows.map(toConnection),
      ),

    /** Removes the row. Its secrets are removed by the caller, in the same transaction. */
    delete: (id: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`DELETE FROM connections WHERE id = ${uuidFromString(id)}`),

    /** Lists every connection one plugin owns, oldest first, for its `ConnectionsRuntime`. */
    ofPlugin: (pluginId: string): Effect.Effect<ReadonlyArray<StoredConnection>, SqlError> =>
      Effect.map(
        sql<ConnectionRow>`SELECT ${sql.literal(COLUMNS)} FROM connections
                           WHERE plugin_id = ${pluginId} ORDER BY created_at, id`,
        (rows) => rows.map(toConnection),
      ),

    /**
     * Returns one page of connections, filtered by type and status when those
     * are given, in the order of the request's sort keys. Fails with a
     * `CursorError` if the cursor is invalid.
     */
    list: (
      request: ConnectionListRequest,
    ): Effect.Effect<Page<StoredConnection>, CursorError | SqlError> =>
      Effect.gen(function* () {
        const { keyset, order, encodeNextCursor } = yield* prepareKeysetListing(
          sql,
          "connection.query",
          request.sort,
          CONNECTION_SORT_COLUMNS,
          "id",
          request.cursor,
        );
        const byType = request.type === undefined ? sql`` : sql`AND type = ${request.type}`;
        const byStatus = request.status === undefined ? sql`` : sql`AND status = ${request.status}`;
        const rows = yield* sql<ConnectionRow>`
          SELECT ${sql.literal(COLUMNS)} FROM connections
          WHERE 1 = 1 ${byType} ${byStatus} AND ${keyset}
          ${order} LIMIT ${request.limit + 1}
        `;
        return yield* buildPage(
          rows,
          request.limit,
          (page) => Effect.succeed(page.map(toConnection)),
          encodeNextCursor,
        );
      }),
  };
});

/** The connection repository, used by the connection service, `./runtime` and other domains. */
export const connectionRepository = make;
