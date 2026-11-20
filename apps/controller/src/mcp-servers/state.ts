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
import { connectionRepository, type StoredConnection } from "../connections";
import { announce, withTransaction } from "../db";
import { Notifier } from "../notifications";
import { PluginHost, type RegisteredMcpServer } from "../plugins";
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

/** Returns the id of the plugin that offers a contribution: `sentry/sentry` is offered by `sentry`. */
export const parsePluginId = (contributionId: string): string =>
  contributionId.slice(0, contributionId.indexOf("/"));

/** Whether the plugin that offers a server's contribution can serve it. */
export type PluginState =
  | { readonly _tag: "active"; readonly contribution: RegisteredMcpServer }
  | { readonly _tag: "switched-off"; readonly pluginName: string }
  | { readonly _tag: "missing" };

/**
 * What a server depends on outside its own row: its Connection and its
 * plugin. A check or the follower reads it before it decides, and
 * `writeServerState` reads it again before it writes.
 */
export interface McpServerDependencies {
  /** `undefined` when the Connection no longer exists. */
  readonly connection: StoredConnection | undefined;
  readonly plugin: PluginState;
}

/** Reads the Connection and the plugin of a server as they are now. */
export const readDependencies = (
  server: Pick<StoredMcpServer, "connectionId" | "contributionId">,
): Effect.Effect<McpServerDependencies, SqlError, SqlClient.SqlClient | PluginHost> =>
  Effect.gen(function* () {
    const connections = yield* connectionRepository;
    const plugins = yield* PluginHost;
    const connection = Option.getOrUndefined(yield* connections.one(server.connectionId));
    const found = yield* plugins.findMcpServer(server.contributionId);
    if (Option.isNone(found)) return { connection, plugin: { _tag: "missing" } };
    const { pluginId } = found.value;
    if (yield* plugins.isActive(pluginId)) {
      return { connection, plugin: { _tag: "active", contribution: found.value } };
    }
    const pluginName =
      (yield* plugins.loaded()).find((plugin) => plugin.id === pluginId)?.displayName ?? pluginId;
    return { connection, plugin: { _tag: "switched-off", pluginName } };
  });

/**
 * Tells whether two readings of the dependencies are the same for a server:
 * the same plugin state, and the same Connection with the same status and
 * credentials generation.
 */
export const isSameDependencies = (
  before: McpServerDependencies,
  now: McpServerDependencies,
): boolean =>
  before.plugin._tag === now.plugin._tag &&
  before.connection?.status === now.connection?.status &&
  before.connection?.credentialsGeneration === now.connection?.credentialsGeneration;

/** What a server shows when its plugin or its Connection cannot serve it. */
export interface Unusable {
  readonly _tag: "unusable";
  readonly status: "error" | "needs-sign-in";
  readonly detail: string;
  readonly cause: "plugin" | "connection";
}

/** A server whose plugin is active and whose Connection exists and is not `needs-reauth` or `disabled`. */
export interface Usable {
  readonly _tag: "usable";
  readonly contribution: RegisteredMcpServer;
  readonly connection: StoredConnection;
}

/**
 * Judges whether a server's plugin and Connection can serve it. When they
 * cannot, returns what the server shows: its plugin is missing or switched
 * off, or its Connection is gone, `disabled` or `needs-reauth`. The check and
 * the follower both use it, so they show the same words.
 */
export const judgeDependencies = ({
  plugin,
  connection,
}: McpServerDependencies): Usable | Unusable => {
  switch (plugin._tag) {
    case "missing":
      return {
        _tag: "unusable",
        status: "error",
        detail: "The plugin that offered this server is not in this build",
        cause: "plugin",
      };
    case "switched-off":
      return {
        _tag: "unusable",
        status: "error",
        detail: `The ${plugin.pluginName} plugin is switched off`,
        cause: "plugin",
      };
    case "active":
      break;
  }
  if (connection === undefined) {
    return {
      _tag: "unusable",
      status: "error",
      detail: "The Connection of this server is gone",
      cause: "connection",
    };
  }
  if (connection.status === "disabled") {
    return {
      _tag: "unusable",
      status: "error",
      detail: `The Connection ${connection.label} is switched off`,
      cause: "connection",
    };
  }
  if (connection.status === "needs-reauth") {
    return {
      _tag: "unusable",
      status: "needs-sign-in",
      detail: `Reconnect ${connection.label} in Settings > Connections`,
      cause: "connection",
    };
  }
  return { _tag: "usable", contribution: plugin.contribution, connection };
};

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

/**
 * Reads the server and returns it when `basis` still holds: the server exists,
 * is enabled, still has `basis`'s revision, and its Connection and plugin are
 * still as `basis`'s dependencies. Returns `None` otherwise. Reads only.
 */
export const readServerWhileBasisHolds = (
  id: string,
  basis: StateBasis,
): Effect.Effect<Option.Option<StoredMcpServer>, SqlError, SqlClient.SqlClient | PluginHost> =>
  Effect.gen(function* () {
    const servers = yield* mcpServerRepository;
    const found = yield* servers.readById(id);
    if (Option.isNone(found)) return found;
    const current = found.value;
    if (!current.enabled || current.revision !== basis.revision) return Option.none();
    if (!isSameDependencies(basis.dependencies, yield* readDependencies(current))) {
      return Option.none();
    }
    return found;
  });

/**
 * Marks a server due for a check at `at`, so the scheduler checks it again,
 * when it is enabled and its plugin and Connection can serve it. Does nothing
 * otherwise. A check whose result was dropped calls it: when the server and
 * its destination are still usable, nothing else is sure to ask for the
 * check that the dropped one would have been.
 */
export const markDueWhenUsable = (
  id: string,
  at: string,
): Effect.Effect<void, SqlError, SqlClient.SqlClient | PluginHost> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const servers = yield* mcpServerRepository;
    yield* withTransaction(
      sql,
      Effect.gen(function* () {
        const found = yield* servers.readById(id);
        if (Option.isNone(found) || !found.value.enabled) return;
        const judged = judgeDependencies(yield* readDependencies(found.value));
        if (judged._tag === "usable") yield* servers.update(id, { nextCheckAt: at }, undefined);
      }),
    );
  });

/**
 * Writes an edit to a server, unless something newer happened, and returns
 * whether it was written. It is dropped when the server is gone, switched off,
 * no longer has `basis`'s revision, or its Connection or plugin differ from
 * `basis`'s dependencies.
 *
 * In the same transaction it keeps the Notification episode (`notified_status`):
 *
 * - entering `unreachable` or `error` with no episode open raises one
 *   `core.mcp-server-failed` Notification and opens the episode;
 * - going to `ready` ends the episode;
 * - every other status leaves it as it is, so one episode raises one
 *   Notification however its status moves between `unreachable` and `error`.
 *
 * `updated_at` moves, and the write is announced on the `mcpServer` live topic,
 * only when it changes what the record shows: its status, detail, tools or last
 * check time. A write that only reschedules or counts failures leaves both
 * alone. `at` is the instant of the write, so the caller can compute
 * `nextCheckAt` from it.
 */
export const writeServerState = (
  id: string,
  basis: StateBasis,
  edit: McpServerEdit,
  at: string,
): Effect.Effect<boolean, SqlError, SqlClient.SqlClient | Notifier | PluginHost> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const servers = yield* mcpServerRepository;
    const notifier = yield* Notifier;
    return yield* withTransaction(
      sql,
      Effect.gen(function* () {
        const found = yield* readServerWhileBasisHolds(id, basis);
        if (Option.isNone(found)) return false;
        const current = found.value;

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

        const shown =
          (status !== undefined && status !== current.status) ||
          (edit.statusDetail !== undefined && edit.statusDetail !== current.statusDetail) ||
          (edit.tools !== undefined &&
            JSON.stringify(edit.tools) !== JSON.stringify(current.tools)) ||
          (edit.checkedAt !== undefined && edit.checkedAt !== current.checkedAt);
        yield* servers.update(
          id,
          { ...edit, ...(notifiedStatus === undefined ? {} : { notifiedStatus }) },
          shown ? at : undefined,
        );
        if (shown) yield* announce({ _tag: "record", topic: "mcpServer", id, kind: "updated" });
        return true;
      }),
    );
  });
