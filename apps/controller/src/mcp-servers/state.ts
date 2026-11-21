/**
 * How an MCP Server's status is written when something other than the user
 * changes it: a check that ended, or the follower of the server's Connection
 * and plugin.
 *
 * `mcpServerState` captures what the writes need once, and both writers go
 * through it, so the rules that matter live in one place: a check's result is
 * dropped when anything newer happened, and a Notification is raised once per
 * episode of trouble, in the same transaction as the write (spec 21 sections
 * 5.3 and 5.5).
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { announce, nowIso, withTransaction } from "../db";
import { Notifier } from "../notifications";
import { PromotionState } from "../promotion";
import {
  isSameDependencies,
  judgeDependencies,
  mcpServerCatalogue,
  type McpServerDependencies,
} from "./catalogue";
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
const computeBackoffMillis = (failedChecks: number): number =>
  BACKOFF_MILLIS[Math.min(Math.max(failedChecks, 1), BACKOFF_MILLIS.length) - 1] as number;

/**
 * Builds the edit that stores a failure of a server: a failed check, or a
 * failure of a call that is about the whole server (spec 21 section 5.3). A
 * server that cannot be reached backs off: the failures in a row are counted
 * and the next check is planned by `computeBackoffMillis`. Any other failure
 * waits a day. The tools are left as they were. `protocolVersion` is the MCP
 * revision whose handshake worked, when one did.
 */
export const buildFailureEdit = (
  server: Pick<StoredMcpServer, "failedChecks">,
  failure: {
    readonly status: "unreachable" | "error" | "needs-sign-in";
    readonly detail: string;
    readonly cause?: "plugin" | "connection" | null;
  },
  at: string,
  protocolVersion?: string,
): McpServerEdit => {
  const planAfter = (millis: number): string => new Date(Date.parse(at) + millis).toISOString();
  const revisionEdit = protocolVersion === undefined ? {} : { protocolVersion };
  if (failure.status === "unreachable") {
    const failedChecks = server.failedChecks + 1;
    return {
      status: "unreachable",
      statusDetail: failure.detail,
      statusCause: null,
      failedChecks,
      nextCheckAt: planAfter(computeBackoffMillis(failedChecks)),
      ...revisionEdit,
    };
  }
  return {
    status: failure.status,
    statusDetail: failure.detail,
    statusCause: failure.cause ?? null,
    failedChecks: 0,
    nextCheckAt: planAfter(DAILY_CHECK_MILLIS),
    ...revisionEdit,
  };
};

/** Returns the id of the plugin that offers a contribution: `sentry/sentry` is offered by `sentry`. */
export const parsePluginId = (contributionId: string): string =>
  contributionId.slice(0, contributionId.indexOf("/"));

/**
 * What a state write was based on: the server's `revision` and the
 * dependencies the writer read before it decided. The write happens only if
 * the server still has this revision and its Connection and plugin are still
 * as they were: a user change, a reconnect, a switched-off Connection or a
 * stopped plugin since then makes the result stale.
 */
export interface StateBasis {
  readonly revision: number;
  readonly dependencies: McpServerDependencies;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const servers = yield* mcpServerRepository;
  const notifier = yield* Notifier;
  const promotion = yield* PromotionState;

  const { readDependencies } = yield* mcpServerCatalogue;

  /**
   * Writes an edit to a server that is still as `current`, and keeps the
   * Notification episode (`notified_status`) in the same transaction:
   *
   * - entering `unreachable` or `error` with no episode open raises one
   *   `core.mcp-server-failed` Notification and opens the episode;
   * - going to `ready` ends the episode;
   * - every other status leaves it as it is, so one episode raises one
   *   Notification however its status moves between `unreachable` and `error`.
   *
   * `updated_at` moves, and the write is announced on the `mcpServer` live
   * topic, only when it changes what the record shows: its status, detail,
   * tools or last check time. A write that only reschedules or counts failures
   * leaves both alone. `at` is the instant of the write. Must run inside a
   * transaction.
   */
  const applyEdit = (
    current: StoredMcpServer,
    edit: McpServerEdit,
    at: string,
  ): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
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
          subject: [{ kind: "mcpServer", id: current.id }],
        });
      }

      const shown =
        (status !== undefined && status !== current.status) ||
        (edit.statusDetail !== undefined && edit.statusDetail !== current.statusDetail) ||
        (edit.tools !== undefined &&
          JSON.stringify(edit.tools) !== JSON.stringify(current.tools)) ||
        (edit.checkedAt !== undefined && edit.checkedAt !== current.checkedAt);
      yield* servers.update(
        current.id,
        { ...edit, ...(notifiedStatus === undefined ? {} : { notifiedStatus }) },
        shown ? at : undefined,
      );
      if (shown) {
        yield* announce({ _tag: "record", topic: "mcpServer", id: current.id, kind: "updated" });
      }
    });

  /**
   * Reads the server and returns it when `basis` still holds: the server exists,
   * is enabled, still has `basis`'s revision, and its Connection and plugin are
   * still as `basis`'s dependencies. Returns `None` otherwise. Reads only.
   */
  const readServerWhileBasisHolds = (
    id: string,
    basis: StateBasis,
  ): Effect.Effect<Option.Option<StoredMcpServer>, SqlError> =>
    Effect.gen(function* () {
      const found = yield* servers.readById(id);
      if (Option.isNone(found)) return found;
      const current = found.value;
      if (!current.enabled || current.revision !== basis.revision) return Option.none();
      if (!isSameDependencies(basis.dependencies, yield* readDependencies(current))) {
        return Option.none();
      }
      return found;
    });

  return {
    readDependencies,
    readServerWhileBasisHolds,

    /**
     * Marks a server due for a check at `at`, so the loop that runs the checks
     * checks it again, when it is enabled and its plugin and Connection can
     * serve it. Does nothing otherwise. A check whose result was dropped calls
     * it: when the server and its destination are still usable, nothing else
     * is sure to ask for the check that the dropped one would have been.
     */
    markDueWhenUsable: (id: string, at: string): Effect.Effect<void, SqlError> =>
      withTransaction(
        sql,
        Effect.gen(function* () {
          const found = yield* servers.readById(id);
          if (Option.isNone(found) || !found.value.enabled) return;
          const judged = judgeDependencies(yield* readDependencies(found.value));
          if (judged._tag === "usable") yield* servers.update(id, { nextCheckAt: at }, undefined);
        }),
      ),

    /**
     * Writes the outcome of a check to a server, unless something newer
     * happened, and returns whether it was written. It is dropped when the
     * server is gone, switched off, no longer has `basis`'s revision, or its
     * Connection or plugin differ from `basis`'s dependencies. `applyEdit`
     * explains the Notification and the announcement. `at` is the instant of
     * the write, so the caller can compute `nextCheckAt` from it.
     */
    writeCheckResult: (
      id: string,
      basis: StateBasis,
      edit: McpServerEdit,
      at: string,
    ): Effect.Effect<boolean, SqlError> =>
      withTransaction(
        sql,
        Effect.gen(function* () {
          const found = yield* readServerWhileBasisHolds(id, basis);
          if (Option.isNone(found)) return false;
          yield* applyEdit(found.value, edit, at);
          return true;
        }),
      ),

    /**
     * Brings a server in step with its Connection and plugin, when they differ,
     * and returns whether the caller should wake the checks. It reads the
     * server and what it depends on, decides and writes in one transaction,
     * admitted by the promotion state, so nothing can change the server in
     * between and no result needs a second try. Does nothing for a server that
     * is gone or switched off.
     *
     * - Plugin or Connection unusable: the server takes the status that cause
     *   gives it, written as `applyEdit` explains. The revision moves, so that
     *   a check that started before cannot write its older result over it.
     * - Reconnected, or a cause that is gone: the old cause is cleared, the
     *   failed checks and the backoff end, and the next check is marked due in
     *   the same write, so the check still happens when the caller's wake is
     *   lost to a stop. The status and its detail stay until that check writes
     *   its result: a later check never goes back to `checking` (spec 21
     *   section 5.3). Returns `true`.
     * - A status the server earned itself (no cause) is left alone.
     */
    followDependencies: (id: string): Effect.Effect<boolean, SqlError> =>
      promotion.whenServing(
        withTransaction(
          sql,
          Effect.gen(function* () {
            const found = yield* servers.readById(id);
            if (Option.isNone(found) || !found.value.enabled) return false;
            const server = found.value;
            const judged = judgeDependencies(yield* readDependencies(server));
            const at = yield* nowIso;
            if (judged._tag === "unusable") {
              const differs =
                server.status !== judged.status ||
                server.statusDetail !== judged.detail ||
                server.statusCause !== judged.cause;
              if (differs) {
                yield* applyEdit(
                  server,
                  {
                    status: judged.status,
                    statusDetail: judged.detail,
                    statusCause: judged.cause,
                    bumpRevision: true,
                  },
                  at,
                );
              }
              return false;
            }
            const reconnected =
              judged.connection.credentialsGeneration !== server.connectionGeneration;
            if (!reconnected && server.statusCause === null) return false;
            yield* applyEdit(
              server,
              {
                bumpRevision: true,
                failedChecks: 0,
                nextCheckAt: at,
                ...(reconnected
                  ? { connectionGeneration: judged.connection.credentialsGeneration }
                  : {}),
                ...(server.statusCause === null ? {} : { statusCause: null }),
              },
              at,
            );
            return true;
          }),
        ),
      ),
  };
});

/** Reads and writes the status of MCP Servers, as `mcpServerState` builds it. */
export const mcpServerState = make;
