/**
 * The `connections` table. Rows only: the credential references live in
 * `secrets` and are composed in by whoever hands a connection out.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { ConnectionStatus } from "@hydra/plugin-host";
import type { SortDirection } from "@hydra/contract";
import {
  decodeCursor,
  encodeCursor,
  keysetOver,
  mintUuid,
  pageOf,
  uuidFromString,
  uuidToString,
  type CursorError,
  type CursorScope,
  type Page,
  type PageRequest,
} from "../db";

/** A connection row, with its JSON columns read. */
export interface StoredConnection {
  readonly id: string;
  readonly pluginId: string;
  readonly type: string;
  readonly label: string;
  readonly displayName: string;
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
  readonly labels: ReadonlyArray<string>;
  readonly config: Record<string, Schema.Json>;
  readonly at: string;
}

/** The columns an edit may set. An absent one is left as it was. */
export interface ConnectionEdit {
  readonly label?: string;
  readonly labels?: ReadonlyArray<string>;
  readonly config?: Record<string, Schema.Json>;
  readonly displayName?: string;
  readonly status?: ConnectionStatus;
  /** `null` clears the detail, which is what going back to `connected` does. */
  readonly statusDetail?: string | null;
}

/** The column a keyset walk orders by. */
export type ConnectionSortField = "createdAt" | "label";

/** What a listing asks for: which connections, and the keyset parameters. */
export interface ConnectionListRequest extends PageRequest {
  readonly type: string | undefined;
  readonly status: ConnectionStatus | undefined;
  readonly field: ConnectionSortField;
}

interface ConnectionRow {
  readonly id: Uint8Array;
  readonly plugin_id: string;
  readonly type: string;
  readonly label: string;
  readonly display_name: string;
  readonly status: ConnectionStatus;
  readonly status_detail: string | null;
  readonly labels: string;
  readonly config: string;
  readonly created_at: string;
  readonly updated_at: string;
}

const COLUMNS =
  "id, plugin_id, type, label, display_name, status, status_detail, labels, config, " +
  "created_at, updated_at";

const SORT_COLUMN: Record<ConnectionSortField, string> = {
  createdAt: "created_at",
  label: "label",
};

const scopeOf = (field: ConnectionSortField, direction: SortDirection): CursorScope => ({
  op: "connection.query",
  field,
  direction,
});

/**
 * The JSON columns are written by this repository alone, so a column that does
 * not parse is a broken database rather than something a caller can act on.
 */
const jsonOf = <A>(text: string): A => JSON.parse(text) as A;

const toConnection = (row: ConnectionRow): StoredConnection => ({
  id: uuidToString(row.id),
  pluginId: row.plugin_id,
  type: row.type,
  label: row.label,
  displayName: row.display_name,
  status: row.status,
  statusDetail: row.status_detail ?? undefined,
  labels: jsonOf<ReadonlyArray<string>>(row.labels),
  config: jsonOf<Record<string, Schema.Json>>(row.config),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const sortKeyOf = (connection: StoredConnection, field: ConnectionSortField): string =>
  field === "label" ? connection.label : connection.createdAt;

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

    insert: (connection: NewConnection): Effect.Effect<StoredConnection, SqlError> =>
      Effect.gen(function* () {
        const id = mintUuid();
        yield* sql`
          INSERT INTO connections
            (id, plugin_id, type, label, display_name, status, status_detail, labels, config,
             created_at, updated_at)
          VALUES
            (${id}, ${connection.pluginId}, ${connection.type}, ${connection.label},
             ${connection.displayName}, 'connected', ${null},
             ${JSON.stringify(connection.labels)}, ${JSON.stringify(connection.config)},
             ${connection.at}, ${connection.at})
        `;
        return {
          id: uuidToString(id),
          pluginId: connection.pluginId,
          type: connection.type,
          label: connection.label,
          displayName: connection.displayName,
          status: "connected",
          statusDetail: undefined,
          labels: connection.labels,
          config: connection.config,
          createdAt: connection.at,
          updatedAt: connection.at,
        };
      }),

    /** Applies an edit. Only the columns the edit names are written. */
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

    /** Every connection of these types, oldest first. The runtime surface's view. */
    ofTypes: (
      types: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyArray<StoredConnection>, SqlError> =>
      types.length === 0
        ? Effect.succeed([])
        : Effect.map(
            sql<ConnectionRow>`SELECT ${sql.literal(COLUMNS)} FROM connections
                               WHERE type IN ${sql.in(types)} ORDER BY created_at, id`,
            (rows) => rows.map(toConnection),
          ),

    list: (
      request: ConnectionListRequest,
    ): Effect.Effect<Page<StoredConnection>, CursorError | SqlError> =>
      Effect.gen(function* () {
        const scope = scopeOf(request.field, request.direction);
        const after =
          request.cursor === undefined
            ? undefined
            : yield* decodeCursor(request.cursor, scope, "string");
        const byType = request.type === undefined ? sql`` : sql`AND type = ${request.type}`;
        const byStatus = request.status === undefined ? sql`` : sql`AND status = ${request.status}`;
        const { keyset, order } = keysetOver(
          sql,
          [SORT_COLUMN[request.field], "id"],
          after === undefined ? undefined : [after[0], uuidFromString(after[1])],
          request.direction,
        );
        const rows = yield* sql<ConnectionRow>`
          SELECT ${sql.literal(COLUMNS)} FROM connections
          WHERE 1 = 1 ${byType} ${byStatus} AND ${keyset}
          ${order} LIMIT ${request.limit + 1}
        `;
        return yield* pageOf(
          rows,
          request.limit,
          (page) => Effect.succeed(page.map(toConnection)),
          (last) => encodeCursor(scope, sortKeyOf(last, request.field), last.id),
        );
      }),
  };
});

/** Everything the connection service and the plugin host read and write. */
export const connectionRepository = make;
