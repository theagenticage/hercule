/**
 * Reads and writes the `mcp_servers` table. It handles rows only: who may
 * write, what a write announces and what a write needs to check first are the
 * service's decisions.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import type { McpServerStatus } from "@hercule/contract";
import { mintUuid, uuidFromString, uuidToString } from "../db";

/**
 * One tool as the MCP server listed it. The gateway answers `tools/list` from
 * these, so the schemas are kept whole. Clients only see the name, the title
 * and the description.
 */
export interface StoredMcpTool {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: Schema.Json;
  readonly outputSchema?: Schema.Json;
  readonly annotations?: Schema.Json;
}

/**
 * Where an MCP Server comes from, as its row stores it (spec 21 section 2):
 *
 * - `plugin`: a plugin's contribution, reached with one of its Connections.
 * - `url`: an address the user gave, reached with the server's own sign-in.
 *   `url` is the address as the URL parser writes it, and the one requests go to.
 *   `normalizedUrl` is the key that makes two spellings of one address
 *   count as one server. `signIn` is what the server holds now, and
 *   `signInOffered` is what the server said it accepts when it refused a
 *   request without one, or `null` while that has not happened.
 */
export type McpServerStoredSource =
  | {
      readonly kind: "plugin";
      /** The plugin's MCP server contribution, qualified (`sentry/sentry`). */
      readonly contributionId: string;
      readonly connectionId: string;
      /** The Connection's `accountId` when the server was created. */
      readonly accountId: string;
    }
  | {
      readonly kind: "url";
      readonly url: string;
      readonly normalizedUrl: string;
      readonly signIn: "none" | "token" | "oauth";
      readonly signInOffered: "oauth" | "token" | null;
    };

/**
 * An MCP Server row without its stored tool definitions, which can be several
 * MiB. A reader that only judges whether the server can serve takes this.
 */
export interface StoredMcpServerAvailability {
  readonly id: string;
  readonly name: string;
  readonly source: McpServerStoredSource;
  readonly enabled: boolean;
  readonly status: McpServerStatus;
  readonly statusDetail: string | null;
  /**
   * Why the status is what it is, when the cause is the Connection or the
   * plugin and not the server. `null` when the status is the server's own.
   */
  readonly statusCause: string | null;
  readonly checkedAt: string | null;
  readonly protocolVersion: string | null;
  /**
   * Goes up with every change that makes a running check's result stale or
   * ends upstream sessions. A check writes its result only if it is unchanged.
   */
  readonly revision: number;
  /** The Connection's `credentialsGeneration` the server was last checked against. */
  readonly connectionGeneration: number;
  /** The status an open Notification episode is for, or `null`. */
  readonly notifiedStatus: McpServerStatus | null;
  readonly nextCheckAt: string | null;
  readonly failedChecks: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** What a plugin server depends on outside its own row, by id. */
export interface McpServerDependencyIds {
  readonly id: string;
  readonly connectionId: string;
  /** The plugin's MCP server contribution, qualified (`sentry/sentry`). */
  readonly contributionId: string;
}

/** What a new plugin server row holds. The status starts as `checking` and the switch as on. */
export interface NewMcpServer {
  readonly name: string;
  readonly contributionId: string;
  readonly connectionId: string;
  readonly accountId: string;
  readonly connectionGeneration: number;
  readonly at: string;
}

/**
 * What a new server row added by URL holds. The status starts as `checking`
 * and the switch as on. `signIn` is `token` when the caller stores a pasted
 * token with the row, and `none` otherwise. A server only gets `oauth` by
 * signing in.
 */
export interface NewUrlMcpServer {
  readonly name: string;
  readonly url: string;
  readonly normalizedUrl: string;
  readonly signIn: "none" | "token";
  readonly at: string;
}

/**
 * The columns that hold a row's source. The table's CHECK guarantees that a
 * row has the columns of its kind and none of the other's, so the two shapes
 * are the only ones a read can find.
 */
type McpServerSourceColumns =
  | {
      readonly source_kind: "plugin";
      readonly contribution_id: string;
      readonly connection_id: Uint8Array;
      readonly account_id: string;
      readonly url: null;
      readonly normalized_url: null;
      readonly sign_in: null;
      readonly sign_in_offered: null;
    }
  | {
      readonly source_kind: "url";
      readonly contribution_id: null;
      readonly connection_id: null;
      readonly account_id: null;
      readonly url: string;
      readonly normalized_url: string;
      readonly sign_in: "none" | "token" | "oauth";
      readonly sign_in_offered: "oauth" | "token" | null;
    };

type McpServerRowWithoutTools = McpServerSourceColumns & {
  readonly id: Uint8Array;
  readonly name: string;
  readonly enabled: number;
  readonly status: McpServerStatus;
  readonly status_detail: string | null;
  readonly status_cause: string | null;
  readonly checked_at: string | null;
  readonly protocol_version: string | null;
  readonly revision: number;
  readonly connection_generation: number;
  readonly notified_status: McpServerStatus | null;
  readonly next_check_at: string | null;
  readonly failed_checks: number;
  readonly created_at: string;
  readonly updated_at: string;
};

type McpServerRow = McpServerRowWithoutTools & { readonly tools: string };

/** An MCP Server row, with its JSON column read. */
export interface StoredMcpServer extends StoredMcpServerAvailability {
  readonly tools: ReadonlyArray<StoredMcpTool>;
}

/** Which columns a read of many servers fetches: `without-tools` leaves out the tool definitions. */
export type McpServerColumns = "with-tools" | "without-tools";

/**
 * The columns an update may set. An absent field is left unchanged, and a
 * `null` clears a nullable column.
 */
export interface McpServerEdit {
  readonly status?: McpServerStatus;
  readonly statusDetail?: string | null;
  readonly statusCause?: string | null;
  /** The full tool definitions of a successful list. Only a success writes them. */
  readonly tools?: ReadonlyArray<StoredMcpTool>;
  readonly checkedAt?: string;
  readonly protocolVersion?: string;
  readonly connectionGeneration?: number;
  /**
   * What a server added by URL said it accepts when it refused a request
   * without a sign-in. Only a server added by URL has the column set.
   */
  readonly signInOffered?: "oauth" | "token";
  readonly notifiedStatus?: McpServerStatus | null;
  readonly nextCheckAt?: string | null;
  readonly failedChecks?: number;
  /** Raises `revision`, which ends the result of any check that started before. */
  readonly bumpRevision?: true;
}

const COLUMNS_WITHOUT_TOOLS =
  "id, name, source_kind, contribution_id, connection_id, account_id, url, normalized_url, " +
  "sign_in, sign_in_offered, enabled, status, status_detail, " +
  "status_cause, checked_at, protocol_version, revision, connection_generation, " +
  "notified_status, next_check_at, failed_checks, created_at, updated_at";
const COLUMNS = `${COLUMNS_WITHOUT_TOOLS}, tools`;

/** Builds the server a new row holds: on, `checking`, with no tools and no check yet. */
const buildNewServer = (
  id: Uint8Array,
  name: string,
  source: McpServerStoredSource,
  connectionGeneration: number,
  at: string,
): StoredMcpServer => ({
  id: uuidToString(id),
  name,
  source,
  enabled: true,
  status: "checking",
  statusDetail: null,
  statusCause: null,
  tools: [],
  checkedAt: null,
  protocolVersion: null,
  revision: 0,
  connectionGeneration,
  notifiedStatus: null,
  nextCheckAt: null,
  failedChecks: 0,
  createdAt: at,
  updatedAt: at,
});

/** Converts the source columns of a row to its source. */
const toStoredSource = (row: McpServerSourceColumns): McpServerStoredSource =>
  row.source_kind === "plugin"
    ? {
        kind: "plugin",
        contributionId: row.contribution_id,
        connectionId: uuidToString(row.connection_id),
        accountId: row.account_id,
      }
    : {
        kind: "url",
        url: row.url,
        normalizedUrl: row.normalized_url,
        signIn: row.sign_in,
        signInOffered: row.sign_in_offered,
      };

/** Converts a row to a server without its tool definitions. */
const toServerAvailability = (row: McpServerRowWithoutTools): StoredMcpServerAvailability => ({
  id: uuidToString(row.id),
  name: row.name,
  source: toStoredSource(row),
  enabled: row.enabled === 1,
  status: row.status,
  statusDetail: row.status_detail,
  statusCause: row.status_cause,
  checkedAt: row.checked_at,
  protocolVersion: row.protocol_version,
  revision: row.revision,
  connectionGeneration: row.connection_generation,
  notifiedStatus: row.notified_status,
  nextCheckAt: row.next_check_at,
  failedChecks: row.failed_checks,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/**
 * Converts a row to a server. Only this repository writes the `tools` column,
 * so a column that does not parse means the database is broken, not an error
 * a caller can act on.
 */
const toServer = (row: McpServerRow): StoredMcpServer => ({
  ...toServerAvailability(row),
  tools: JSON.parse(row.tools) as ReadonlyArray<StoredMcpTool>,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const readById = (id: string): Effect.Effect<Option.Option<StoredMcpServer>, SqlError> =>
    Effect.map(
      sql<McpServerRow>`SELECT ${sql.literal(COLUMNS)} FROM mcp_servers
                        WHERE id = ${uuidFromString(id)}`,
      (rows) => Option.map(Option.fromNullishOr(rows[0]), toServer),
    );

  /**
   * Returns each server that exists, by its id, in one query. An id that no
   * server has is left out of the map. With `without-tools` the query does
   * not fetch the tool definitions. `tools` is the last column of the table
   * (migration 0125), and SQLite keeps a long value in overflow pages after
   * the columns before it, so this query never reads those pages, however long
   * the stored lists are.
   */
  function readMany(
    ids: ReadonlyArray<string>,
    columns: "with-tools",
  ): Effect.Effect<ReadonlyMap<string, StoredMcpServer>, SqlError>;
  function readMany(
    ids: ReadonlyArray<string>,
    columns: "without-tools",
  ): Effect.Effect<ReadonlyMap<string, StoredMcpServerAvailability>, SqlError>;
  function readMany(
    ids: ReadonlyArray<string>,
    columns: McpServerColumns,
  ): Effect.Effect<ReadonlyMap<string, StoredMcpServerAvailability>, SqlError>;
  function readMany(
    ids: ReadonlyArray<string>,
    columns: McpServerColumns,
  ): Effect.Effect<ReadonlyMap<string, StoredMcpServerAvailability>, SqlError> {
    if (ids.length === 0) return Effect.succeed(new Map());
    const withTools = columns === "with-tools";
    return Effect.map(
      sql<McpServerRow>`SELECT ${sql.literal(withTools ? COLUMNS : COLUMNS_WITHOUT_TOOLS)}
                        FROM mcp_servers WHERE id IN ${sql.in(ids.map(uuidFromString))}`,
      (rows) =>
        new Map(
          rows.map((row) => [
            uuidToString(row.id),
            withTools ? toServer(row) : toServerAvailability(row),
          ]),
        ),
    );
  }

  return {
    readById,

    /**
     * Returns the name of each server that exists, by its id, in one query. An
     * id that no server has is left out of the map.
     */
    readNames: (
      ids: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyMap<string, string>, SqlError> =>
      ids.length === 0
        ? Effect.succeed(new Map())
        : Effect.map(
            sql<{ readonly id: Uint8Array; readonly name: string }>`
              SELECT id, name FROM mcp_servers WHERE id IN ${sql.in(ids.map(uuidFromString))}`,
            (rows) => new Map(rows.map((row) => [uuidToString(row.id), row.name])),
          ),

    readMany,

    /** Returns every server, sorted by name and then by id. */
    list: (): Effect.Effect<ReadonlyArray<StoredMcpServer>, SqlError> =>
      Effect.map(
        sql<McpServerRow>`SELECT ${sql.literal(COLUMNS)} FROM mcp_servers
                          ORDER BY name, id`,
        (rows) => rows.map(toServer),
      ),

    /**
     * Returns the Connection and the plugin contribution of every plugin
     * server, without the tool definitions the other reads decode. A server
     * added by URL has neither and is left out.
     */
    listDependencyIds: (): Effect.Effect<ReadonlyArray<McpServerDependencyIds>, SqlError> =>
      Effect.map(
        sql<{
          readonly id: Uint8Array;
          readonly connection_id: Uint8Array;
          readonly contribution_id: string;
        }>`SELECT id, connection_id, contribution_id FROM mcp_servers
           WHERE source_kind = 'plugin'`,
        (rows) =>
          rows.map((row) => ({
            id: uuidToString(row.id),
            connectionId: uuidToString(row.connection_id),
            contributionId: row.contribution_id,
          })),
      ),

    /** Returns the servers reached with this Connection, sorted by name and then by id. */
    listByConnection: (
      connectionId: string,
    ): Effect.Effect<ReadonlyArray<StoredMcpServer>, SqlError> =>
      Effect.map(
        sql<McpServerRow>`SELECT ${sql.literal(COLUMNS)} FROM mcp_servers
                          WHERE connection_id = ${uuidFromString(connectionId)}
                          ORDER BY name, id`,
        (rows) => rows.map(toServer),
      ),

    /**
     * Returns the enabled servers whose next check is due at `now`, or that
     * have none planned yet, sorted by id.
     */
    listDueForCheck: (now: string): Effect.Effect<ReadonlyArray<StoredMcpServer>, SqlError> =>
      Effect.map(
        sql<McpServerRow>`SELECT ${sql.literal(COLUMNS)} FROM mcp_servers
                          WHERE enabled = 1 AND (next_check_at IS NULL OR next_check_at <= ${now})
                          ORDER BY id`,
        (rows) => rows.map(toServer),
      ),

    /** Returns the server of this contribution and external account, if there is one. */
    findByContributionAndAccount: (
      contributionId: string,
      accountId: string,
    ): Effect.Effect<Option.Option<StoredMcpServer>, SqlError> =>
      Effect.map(
        sql<McpServerRow>`SELECT ${sql.literal(COLUMNS)} FROM mcp_servers
                          WHERE contribution_id = ${contributionId} AND account_id = ${accountId}`,
        (rows) => Option.map(Option.fromNullishOr(rows[0]), toServer),
      ),

    /** Returns the server added by URL whose normalized address is this one, if there is one. */
    findByNormalizedUrl: (
      normalizedUrl: string,
    ): Effect.Effect<Option.Option<StoredMcpServer>, SqlError> =>
      Effect.map(
        sql<McpServerRow>`SELECT ${sql.literal(COLUMNS)} FROM mcp_servers
                          WHERE normalized_url = ${normalizedUrl}`,
        (rows) => Option.map(Option.fromNullishOr(rows[0]), toServer),
      ),

    /** Inserts a plugin server that is on, in status `checking`, with no tools, and returns it. */
    insert: (server: NewMcpServer): Effect.Effect<StoredMcpServer, SqlError> =>
      Effect.gen(function* () {
        const id = mintUuid();
        yield* sql`
          INSERT INTO mcp_servers
            (id, name, source_kind, contribution_id, connection_id, account_id, enabled,
             status, connection_generation, created_at, updated_at)
          VALUES
            (${id}, ${server.name}, 'plugin', ${server.contributionId},
             ${uuidFromString(server.connectionId)}, ${server.accountId}, 1, 'checking',
             ${server.connectionGeneration}, ${server.at}, ${server.at})
        `;
        return buildNewServer(
          id,
          server.name,
          {
            kind: "plugin",
            contributionId: server.contributionId,
            connectionId: server.connectionId,
            accountId: server.accountId,
          },
          server.connectionGeneration,
          server.at,
        );
      }),

    /**
     * Inserts a server added by URL that is on, in status `checking`, with no
     * tools, and returns it. Fails with a `SqlError` when another server has
     * the same `normalizedUrl`. The caller stores the server's sign-in.
     */
    insertUrl: (server: NewUrlMcpServer): Effect.Effect<StoredMcpServer, SqlError> =>
      Effect.gen(function* () {
        const id = mintUuid();
        yield* sql`
          INSERT INTO mcp_servers
            (id, name, source_kind, url, normalized_url, sign_in, enabled, status,
             created_at, updated_at)
          VALUES
            (${id}, ${server.name}, 'url', ${server.url}, ${server.normalizedUrl},
             ${server.signIn}, 1, 'checking', ${server.at}, ${server.at})
        `;
        return buildNewServer(
          id,
          server.name,
          {
            kind: "url",
            url: server.url,
            normalizedUrl: server.normalizedUrl,
            signIn: server.signIn,
            signInOffered: null,
          },
          0,
          server.at,
        );
      }),

    /**
     * Writes the user's switch and raises `revision`, so a check that started
     * before the change cannot write its result.
     *
     * Switching on also puts the status back to `checking`, clears its detail
     * and its cause, resets the failed checks, and marks the next check as due
     * at `at`: the old result no longer holds, and the check must happen even
     * when the request for it is lost. Switching off leaves the status as it is.
     */
    writeEnabled: (id: string, enabled: boolean, at: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(
        enabled
          ? sql`
            UPDATE mcp_servers
            SET enabled = 1, status = 'checking', status_detail = NULL, status_cause = NULL,
                failed_checks = 0, next_check_at = ${at},
                revision = revision + 1, updated_at = ${at}
            WHERE id = ${uuidFromString(id)}
          `
          : sql`
            UPDATE mcp_servers
            SET enabled = 0, revision = revision + 1, updated_at = ${at}
            WHERE id = ${uuidFromString(id)}
          `,
      ),

    /**
     * Records that a pasted token was stored for a server added by URL, and
     * prepares the server to be checked with it: `signIn` becomes `token`, the
     * failed checks end, the next check is due at `at` so it happens even when
     * the request for it is lost, and `revision` goes up, so a check that
     * started with the old sign-in cannot write its result and upstream
     * sessions opened with it end.
     *
     * A server that is on goes back to `checking` with no detail. A server
     * that is off keeps its status and detail, because no check runs for it:
     * switching it on (`writeEnabled`) puts it to `checking` then.
     */
    writeTokenSignIn: (id: string, at: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(
        sql`
          UPDATE mcp_servers
          SET sign_in = 'token',
              status = CASE WHEN enabled = 1 THEN 'checking' ELSE status END,
              status_detail = CASE WHEN enabled = 1 THEN NULL ELSE status_detail END,
              failed_checks = 0, next_check_at = ${at},
              revision = revision + 1, updated_at = ${at}
          WHERE id = ${uuidFromString(id)}
        `,
      ),

    /**
     * Prepares a server whose user asked for a check now: resets its failed
     * checks, marks its next check as due at `at`, so the check happens even
     * when the request for it is lost, and raises `revision`, so a check that
     * is running cannot write its older result over the reset. It changes
     * nothing the record shows.
     */
    resetSchedule: (id: string, at: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(
        sql`
          UPDATE mcp_servers
          SET failed_checks = 0, next_check_at = ${at}, revision = revision + 1
          WHERE id = ${uuidFromString(id)}
        `,
      ),

    /**
     * Applies an edit. Only the columns the edit sets are written. `updatedAt`
     * is the new `updated_at`; `undefined` leaves it, for an edit that changes
     * nothing the record shows.
     */
    update: (
      id: string,
      edit: McpServerEdit,
      updatedAt: string | undefined,
    ): Effect.Effect<void, SqlError> => {
      const sets = updatedAt === undefined ? [] : [sql`updated_at = ${updatedAt}`];
      if (edit.status !== undefined) sets.push(sql`status = ${edit.status}`);
      if (edit.statusDetail !== undefined) sets.push(sql`status_detail = ${edit.statusDetail}`);
      if (edit.statusCause !== undefined) sets.push(sql`status_cause = ${edit.statusCause}`);
      if (edit.tools !== undefined) sets.push(sql`tools = ${JSON.stringify(edit.tools)}`);
      if (edit.checkedAt !== undefined) sets.push(sql`checked_at = ${edit.checkedAt}`);
      if (edit.protocolVersion !== undefined) {
        sets.push(sql`protocol_version = ${edit.protocolVersion}`);
      }
      if (edit.connectionGeneration !== undefined) {
        sets.push(sql`connection_generation = ${edit.connectionGeneration}`);
      }
      if (edit.signInOffered !== undefined) {
        sets.push(sql`sign_in_offered = ${edit.signInOffered}`);
      }
      if (edit.notifiedStatus !== undefined)
        sets.push(sql`notified_status = ${edit.notifiedStatus}`);
      if (edit.nextCheckAt !== undefined) sets.push(sql`next_check_at = ${edit.nextCheckAt}`);
      if (edit.failedChecks !== undefined) sets.push(sql`failed_checks = ${edit.failedChecks}`);
      if (edit.bumpRevision === true) sets.push(sql`revision = revision + 1`);
      if (sets.length === 0) return Effect.void;
      return Effect.asVoid(
        sql`UPDATE mcp_servers SET ${sql.csv(sets)} WHERE id = ${uuidFromString(id)}`,
      );
    },

    /** Deletes the server. Nothing happens when there is no such server. */
    remove: (id: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`DELETE FROM mcp_servers WHERE id = ${uuidFromString(id)}`),
  };
});

/** Reads and writes the `mcp_servers` table. */
export const mcpServerRepository = make;
