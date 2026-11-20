/**
 * How an MCP Server's status is written when something other than the user
 * changes it: a check that ended, or the follower of the server's Connection
 * and plugin.
 *
 * Both write through `writeServerState`, so the rules that matter live in one
 * place: a result is dropped when anything newer happened, and a Notification
 * is raised once per episode of trouble, in the same transaction as the write
 * (spec 21 sections 5.3 and 5.5).
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { announce, withTransaction } from "../db";
import { Notifier } from "../notifications";
import { mcpServerRepository, type McpServerEdit, type StoredMcpServer } from "./repository";

const MINUTE_MILLIS = 60 * 1000;

/** How long a server waits for its next check after a success, or a failure that is not a lost connection. */
export const DAILY_CHECK_MILLIS = 24 * 60 * MINUTE_MILLIS;

/** The waits after the first, second, third and fourth failed check in a row. */
const BACKOFF_MILLIS = [
  1 * MINUTE_MILLIS,
  5 * MINUTE_MILLIS,
  15 * MINUTE_MILLIS,
  60 * MINUTE_MILLIS,
];

/**
 * Returns how long a server that could not be reached waits before the next
 * check. `failedChecks` counts the failed checks in a row, this one included:
 * 1 minute after the first, then 5 minutes, 15 minutes, 1 hour, and every hour
 * after that (spec 21 section 5.3).
 */
export const computeBackoffMillis = (failedChecks: number): number =>
  BACKOFF_MILLIS[Math.min(Math.max(failedChecks, 1), BACKOFF_MILLIS.length) - 1] as number;

/**
 * What a state write was based on. The write happens only if the server still
 * has this `revision` and `connectionGeneration`: a user change or a reconnect
 * since then makes the result stale.
 */
export interface StateBasis {
  readonly revision: number;
  readonly connectionGeneration: number;
}

/** Returns the basis of a result computed from this server as it is now. */
export const readBasis = (server: StoredMcpServer): StateBasis => ({
  revision: server.revision,
  connectionGeneration: server.connectionGeneration,
});

/**
 * Writes an edit to a server, unless something newer happened, and returns
 * whether it was written. It is dropped when the server is gone, switched off,
 * or no longer has `basis`'s revision or connection generation.
 *
 * In the same transaction it keeps the Notification episode (`notified_status`):
 *
 * - entering `unreachable` or `error` with no episode open raises one
 *   `core.mcp-server-failed` Notification and opens the episode;
 * - going to `ready` ends the episode;
 * - every other status leaves it as it is, so one episode raises one
 *   Notification however its status moves between `unreachable` and `error`.
 *
 * After the commit it announces the server on the `mcpServer` live topic when
 * its status, its detail, its tools or its last check time changed. `at` is the
 * instant of the write, so the caller can compute `nextCheckAt` from it.
 */
export const writeServerState = (
  id: string,
  basis: StateBasis,
  edit: McpServerEdit,
  at: string,
): Effect.Effect<boolean, SqlError, SqlClient.SqlClient | Notifier> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const servers = yield* mcpServerRepository;
    const notifier = yield* Notifier;
    return yield* withTransaction(
      sql,
      Effect.gen(function* () {
        const found = yield* servers.readById(id);
        if (Option.isNone(found)) return false;
        const current = found.value;
        if (
          !current.enabled ||
          current.revision !== basis.revision ||
          current.connectionGeneration !== basis.connectionGeneration
        ) {
          return false;
        }

        const status = edit.status;
        let notifiedStatus = edit.notifiedStatus;
        if (status === "ready") {
          notifiedStatus = null;
        } else if (
          (status === "unreachable" || status === "error") &&
          current.notifiedStatus === null
        ) {
          notifiedStatus = status;
          yield* notifier.createCoreNotification({
            kind: "core.mcp-server-failed",
            title:
              status === "unreachable"
                ? `MCP server ${current.name} is unreachable`
                : `MCP server ${current.name} has an error`,
            ...(edit.statusDetail === undefined || edit.statusDetail === null
              ? {}
              : { body: edit.statusDetail }),
            subject: [{ kind: "mcpServer", id }],
          });
        }

        yield* servers.update(
          id,
          { ...edit, ...(notifiedStatus === undefined ? {} : { notifiedStatus }) },
          at,
        );

        const shown =
          (status !== undefined && status !== current.status) ||
          (edit.statusDetail !== undefined && edit.statusDetail !== current.statusDetail) ||
          (edit.tools !== undefined &&
            JSON.stringify(edit.tools) !== JSON.stringify(current.tools)) ||
          (edit.checkedAt !== undefined && edit.checkedAt !== current.checkedAt);
        if (shown) yield* announce({ _tag: "record", topic: "mcpServer", id, kind: "updated" });
        return true;
      }),
    );
  });
