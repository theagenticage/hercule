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
import type { ServerAvailability } from "./left-out";

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

/** An MCP Server row, with its JSON column read. */
export interface StoredMcpServer {
  readonly id: string;
  readonly name: string;
  /** The plugin's MCP server contribution, qualified (`sentry/sentry`). */
  readonly contributionId: string;
  readonly connectionId: string;
  /** The Connection's `accountId` when the server was created. */
  readonly accountId: string;
  readonly enabled: boolean;
  readonly status: McpServerStatus;
  readonly statusDetail: string | null;
  /**
   * Why the status is what it is, when the cause is the Connection or the
   * plugin and not the server. `null` when the status is the server's own.
   */
  readonly statusCause: string | null;
  readonly tools: ReadonlyArray<StoredMcpTool>;
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

/** What a server depends on outside its own row, by id. */
export interface McpServerDependencyIds {
  readonly id: string;
  readonly connectionId: string;
  /** The plugin's MCP server contribution, qualified (`sentry/sentry`). */
  readonly contributionId: string;
}

/** What a new server row holds. The status starts as `checking` and the switch as on. */
export interface NewMcpServer {
  readonly name: string;
  readonly contributionId: string;
  readonly connectionId: string;
  readonly accountId: string;
  readonly connectionGeneration: number;
  readonly at: string;
}

interface McpServerRow {
  readonly id: Uint8Array;
  readonly name: string;
  readonly contribution_id: string;
  readonly connection_id: Uint8Array;
  readonly account_id: string;
  readonly enabled: number;
  readonly status: McpServerStatus;
  readonly status_detail: string | null;
  readonly status_cause: string | null;
  readonly tools: string;
  readonly checked_at: string | null;
  readonly protocol_version: string | null;
  readonly revision: number;
  readonly connection_generation: number;
  readonly notified_status: McpServerStatus | null;
  readonly next_check_at: string | null;
  readonly failed_checks: number;
  readonly created_at: string;
  readonly updated_at: string;
}

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
  readonly notifiedStatus?: McpServerStatus | null;
  readonly nextCheckAt?: string | null;
  readonly failedChecks?: number;
  /** Raises `revision`, which ends the result of any check that started before. */
  readonly bumpRevision?: true;
}

const COLUMNS =
  "id, name, contribution_id, connection_id, account_id, enabled, status, status_detail, " +
  "status_cause, tools, checked_at, protocol_version, revision, connection_generation, " +
  "notified_status, next_check_at, failed_checks, created_at, updated_at";

/**
 * Converts a row to a server. Only this repository writes the `tools` column,
 * so a column that does not parse means the database is broken, not an error
 * a caller can act on.
 */
const toServer = (row: McpServerRow): StoredMcpServer => ({
  id: uuidToString(row.id),
  name: row.name,
  contributionId: row.contribution_id,
  connectionId: uuidToString(row.connection_id),
  accountId: row.account_id,
  enabled: row.enabled === 1,
  status: row.status,
  statusDetail: row.status_detail,
  statusCause: row.status_cause,
  tools: JSON.parse(row.tools) as ReadonlyArray<StoredMcpTool>,
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

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const readById = (id: string): Effect.Effect<Option.Option<StoredMcpServer>, SqlError> =>
    Effect.map(
      sql<McpServerRow>`SELECT ${sql.literal(COLUMNS)} FROM mcp_servers
                        WHERE id = ${uuidFromString(id)}`,
      (rows) => Option.map(Option.fromNullishOr(rows[0]), toServer),
    );

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

    /**
     * Returns the switch and the status of each server that exists, by its id,
     * in one query and without the tool definitions. A session's start reads
     * it to decide which servers it can call. An id that no server has is left
     * out of the map.
     */
    readAvailability: (
      ids: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyMap<string, ServerAvailability>, SqlError> =>
      ids.length === 0
        ? Effect.succeed(new Map())
        : Effect.map(
            sql<{
              readonly id: Uint8Array;
              readonly enabled: number;
              readonly status: McpServerStatus;
            }>`SELECT id, enabled, status FROM mcp_servers
               WHERE id IN ${sql.in(ids.map(uuidFromString))}`,
            (rows) =>
              new Map(
                rows.map((row) => [
                  uuidToString(row.id),
                  { enabled: row.enabled === 1, status: row.status },
                ]),
              ),
          ),

    /** Returns every server, sorted by name and then by id. */
    list: (): Effect.Effect<ReadonlyArray<StoredMcpServer>, SqlError> =>
      Effect.map(
        sql<McpServerRow>`SELECT ${sql.literal(COLUMNS)} FROM mcp_servers
                          ORDER BY name, id`,
        (rows) => rows.map(toServer),
      ),

    /**
     * Returns the Connection and the plugin contribution of every server,
     * without the tool definitions the other reads decode.
     */
    listDependencyIds: (): Effect.Effect<ReadonlyArray<McpServerDependencyIds>, SqlError> =>
      Effect.map(
        sql<{
          readonly id: Uint8Array;
          readonly connection_id: Uint8Array;
          readonly contribution_id: string;
        }>`SELECT id, connection_id, contribution_id FROM mcp_servers`,
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

    /** Inserts a server that is on, in status `checking`, with no tools, and returns it. */
    insert: (server: NewMcpServer): Effect.Effect<StoredMcpServer, SqlError> =>
      Effect.gen(function* () {
        const id = mintUuid();
        yield* sql`
          INSERT INTO mcp_servers
            (id, name, contribution_id, connection_id, account_id, enabled, status,
             connection_generation, created_at, updated_at)
          VALUES
            (${id}, ${server.name}, ${server.contributionId},
             ${uuidFromString(server.connectionId)}, ${server.accountId}, 1, 'checking',
             ${server.connectionGeneration}, ${server.at}, ${server.at})
        `;
        return {
          id: uuidToString(id),
          name: server.name,
          contributionId: server.contributionId,
          connectionId: server.connectionId,
          accountId: server.accountId,
          enabled: true,
          status: "checking",
          statusDetail: null,
          statusCause: null,
          tools: [],
          checkedAt: null,
          protocolVersion: null,
          revision: 0,
          connectionGeneration: server.connectionGeneration,
          notifiedStatus: null,
          nextCheckAt: null,
          failedChecks: 0,
          createdAt: server.at,
          updatedAt: server.at,
        };
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
