/**
 * Reads and writes the `connections` table. It handles rows only: credentials
 * live in the `secrets` table, and the caller that returns a connection adds
 * their references.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { ConnectionStatus } from "@hercule/plugin-host";
import { GITHUB_CONNECTION_TYPE } from "@hercule/contract";
import {
  decodeCursor,
  encodeCursor,
  buildKeyset,
  mintUuid,
  buildPage,
  uuidFromString,
  uuidToString,
  type CursorError,
  type CursorScope,
  type Page,
  type ResolvedSortKey,
  type SortableField,
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
  readonly displayName?: string;
  readonly status?: ConnectionStatus;
  /** `null` clears the detail, as when the status goes back to `connected`. */
  readonly statusDetail?: string | null;
}

/** A field a connection listing can be sorted by. */
export type ConnectionSortField = "createdAt" | "label";

/**
 * A listing request: the filters, the page size, the cursor and the sort keys.
 * `sort` holds at least one key, most significant first, with its direction
 * resolved.
 */
export interface ConnectionListRequest {
  readonly type: string | undefined;
  readonly status: ConnectionStatus | undefined;
  readonly limit: number;
  readonly cursor: string | undefined;
  readonly sort: ReadonlyArray<ResolvedSortKey<ConnectionSortField>>;
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
  readonly created_at: string;
  readonly updated_at: string;
}

const COLUMNS =
  "id, plugin_id, type, label, display_name, account_id, status, status_detail, labels, config, " +
  "created_at, updated_at";

/**
 * How a connection listing sorts by each sortable field:
 *
 * - `column` is the column the query orders by;
 * - `valueType` is the type of that column's value in a cursor, which
 *   `decodeCursor` checks;
 * - `readValue` reads that value from a connection, for the cursor of the
 *   next page.
 */
const CONNECTION_SORT_COLUMNS: Record<ConnectionSortField, SortableField<StoredConnection>> = {
  createdAt: {
    column: "created_at",
    valueType: "string",
    readValue: (connection) => connection.createdAt,
  },
  label: { column: "label", valueType: "string", readValue: (connection) => connection.label },
};

const buildCursorScope = (
  sort: ReadonlyArray<ResolvedSortKey<ConnectionSortField>>,
): CursorScope => ({ op: "connection.query", sort });

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
      if (edit.displayName !== undefined) sets.push(sql`display_name = ${edit.displayName}`);
      if (edit.status !== undefined) sets.push(sql`status = ${edit.status}`);
      if (edit.statusDetail !== undefined) sets.push(sql`status_detail = ${edit.statusDetail}`);
      return Effect.asVoid(
        sql`UPDATE connections SET ${sql.csv(sets)} WHERE id = ${uuidFromString(id)}`,
      );
    },

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
        const scope = buildCursorScope(request.sort);
        const after =
          request.cursor === undefined
            ? undefined
            : yield* decodeCursor(
                request.cursor,
                scope,
                request.sort.map(({ field }) => CONNECTION_SORT_COLUMNS[field].valueType),
              );
        const byType = request.type === undefined ? sql`` : sql`AND type = ${request.type}`;
        const byStatus = request.status === undefined ? sql`` : sql`AND status = ${request.status}`;
        const { keyset, order } = buildKeyset(
          sql,
          request.sort.map(({ field, direction }) => ({
            column: CONNECTION_SORT_COLUMNS[field].column,
            direction,
          })),
          ["id"],
          after === undefined ? undefined : [...after.values, uuidFromString(after.id)],
        );
        const rows = yield* sql<ConnectionRow>`
          SELECT ${sql.literal(COLUMNS)} FROM connections
          WHERE 1 = 1 ${byType} ${byStatus} AND ${keyset}
          ${order} LIMIT ${request.limit + 1}
        `;
        return yield* buildPage(
          rows,
          request.limit,
          (page) => Effect.succeed(page.map(toConnection)),
          (last) =>
            encodeCursor(
              scope,
              request.sort.map(({ field }) => CONNECTION_SORT_COLUMNS[field].readValue(last)),
              last.id,
            ),
        );
      }),
  };
});

/** The connection repository, used by the connection service, `./runtime` and other domains. */
export const connectionRepository = make;
