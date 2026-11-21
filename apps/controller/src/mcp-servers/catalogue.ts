/**
 * The catalogue view of MCP Servers: each server read together with the
 * Connection and the plugin it depends on, and the verdicts the rest of the
 * controller draws from those facts (spec 21 sections 3.3, 3.6 and 3.8).
 *
 * Three readers ask different questions about the same facts, so each has its
 * own verdict, and each is a function of the view alone:
 *
 * - `isServable`: whether `tools/list` shows the server;
 * - `decideCallRefusal`: whether a call may go to the server now, and what the
 *   agent reads when it may not;
 * - `decideLeftOutReason` (`left-out.ts`): why a session's start left it out.
 *
 * The verdicts agree on every case they share and differ in two on purpose:
 *
 * - `isServable` lists a server whose Connection needs sign-in, and one whose
 *   Connection is of the wrong type, while calls to them are refused and a
 *   start leaves them out;
 * - a start puts `checking` before the causes in the Connection and the
 *   plugin, which a call does not.
 */
import type { McpServerLeftOutReason } from "@hercule/protocol";
import * as Effect from "effect/Effect";
import type { SqlError } from "effect/sql/SqlError";
import { connectionRepository, type StoredConnection } from "../connections";
import { PluginHost, type RegisteredMcpServer } from "../plugins";
import {
  mcpServerRepository,
  type McpServerColumns,
  type StoredMcpServer,
  type StoredMcpServerAvailability,
} from "./repository";

/**
 * Whether the plugin that offers a server's contribution can serve it. A
 * plugin that is `switched-off` is enabled by nobody, and one that
 * `failed-to-start` is enabled but its activation failed. The two need
 * different words, because the user's remedy is different.
 */
export type PluginState =
  | { readonly _tag: "active"; readonly contribution: RegisteredMcpServer }
  | { readonly _tag: "switched-off"; readonly pluginName: string }
  | { readonly _tag: "failed-to-start"; readonly pluginName: string }
  | { readonly _tag: "missing" };

/**
 * What a server depends on outside its own row: its Connection and its
 * plugin. A check reads it before it decides, and `writeCheckResult` reads it
 * again before it writes.
 */
export interface McpServerDependencies {
  /** `undefined` when the Connection no longer exists. */
  readonly connection: StoredConnection | undefined;
  readonly plugin: PluginState;
}

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
 * off or failed to start, or its Connection is gone, `disabled` or
 * `needs-reauth`. The check and the follower both use it, so they show the
 * same words.
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
    case "failed-to-start":
      return {
        _tag: "unusable",
        status: "error",
        detail: `The ${plugin.pluginName} plugin failed to start: see Settings > Plugins`,
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

/** One MCP Server and what it depends on, read at one moment. */
export interface McpServerView<Server extends StoredMcpServerAvailability = StoredMcpServer> {
  readonly server: Server;
  readonly dependencies: McpServerDependencies;
}

/**
 * A view without the server's tool definitions. Every verdict below needs no
 * more, and a read that fetches no more stays cheap however long the stored
 * lists are.
 */
export type McpServerAvailabilityView = McpServerView<StoredMcpServerAvailability>;

/** The reasons the state of a server alone gives for refusing a call or leaving it out of a start. */
export type ServerUnavailableReason = Extract<
  McpServerLeftOutReason,
  "switched-off" | "checking" | "needs-sign-in" | "unreachable" | "error"
>;

interface Unavailable {
  readonly reason: ServerUnavailableReason;
  /** What the plugin or the Connection says is wrong, when that is the cause. */
  readonly detail?: string;
}

/**
 * Finds why the state of the server alone keeps it from serving. The first
 * that applies wins:
 *
 * 1. it is switched off;
 * 2. its plugin or Connection cannot serve it (`judgeDependencies`): `error`,
 *    or `needs-sign-in` when only the Connection needs a new sign-in;
 * 3. its Connection is not of the type its plugin's contribution needs:
 *    `error`, because the credentials would go to the wrong origin;
 * 4. its stored status is not `ready`.
 */
const findUnavailable = ({
  server,
  dependencies,
}: McpServerAvailabilityView): Unavailable | null => {
  if (!server.enabled) return { reason: "switched-off" };
  const judged = judgeDependencies(dependencies);
  if (judged._tag === "unusable") return { reason: judged.status, detail: judged.detail };
  if (judged.connection.type !== judged.contribution.connectionType) return { reason: "error" };
  return server.status === "ready" ? null : { reason: server.status };
};

/** Returns the reason `findUnavailable` finds, or `null` when the server can serve. */
export const decideUnavailableReason = (
  view: McpServerAvailabilityView,
): ServerUnavailableReason | null => findUnavailable(view)?.reason ?? null;

/**
 * Returns whether `tools/list` shows the server: it is switched on, it has a
 * stored tool list, its plugin is active and its Connection exists and is not
 * switched off. A server whose Connection needs sign-in is still shown, and a
 * call to it is refused with that reason. A server that is not `ready`, and one
 * whose Connection is of the wrong type, are shown too.
 */
export const isServable = ({ server, dependencies }: McpServerAvailabilityView): boolean => {
  if (!server.enabled || server.checkedAt === null) return false;
  const judged = judgeDependencies(dependencies);
  return judged._tag === "usable" || judged.status === "needs-sign-in";
};

/** A call that may not go to its server: why, and what the agent reads. */
export interface CallRefusal {
  readonly reason: ServerUnavailableReason;
  readonly message: string;
}

/** Returns the line the agent reads when a call to the server named `name` is refused for `reason`. */
export const describeRefusal = (reason: ServerUnavailableReason, name: string): string => {
  switch (reason) {
    case "switched-off":
      return `${name} is switched off. Ask the user to switch it on in Settings.`;
    case "checking":
      return `${name} is still being checked. Try again in a minute.`;
    case "needs-sign-in":
      return `${name} needs sign-in. Ask the user to reconnect it in Settings > Connections.`;
    case "unreachable":
      return `${name} could not be reached. Try again later.`;
    case "error":
      return `${name} has an error. Ask the user to open it in Settings and check it.`;
  }
};

/**
 * Returns why a call may not go to the server now, with the words the agent
 * reads, or `null` when it may. The reason is what `findUnavailable` finds.
 * The caller checks that the server lists the tool.
 */
export const decideCallRefusal = (view: McpServerAvailabilityView): CallRefusal | null => {
  const { name } = view.server;
  const unavailable = findUnavailable(view);
  if (unavailable === null) return null;
  const { reason, detail } = unavailable;
  return {
    reason,
    message:
      detail !== undefined && reason === "error"
        ? `${name} is not available: ${detail}.`
        : describeRefusal(reason, name),
  };
};

/** The fields of a server row that decide what it depends on. */
type DependencyIds = Pick<StoredMcpServer, "connectionId" | "contributionId">;

const make = Effect.gen(function* () {
  const servers = yield* mcpServerRepository;
  const connections = yield* connectionRepository;
  const plugins = yield* PluginHost;

  /**
   * Reads the Connection and the plugin of each server given, as they are
   * now: one query for the Connections and one read of the plugin host,
   * however many servers there are. Returns a function that gives the
   * dependencies of one of those servers.
   */
  const readDependenciesOfMany = (
    given: ReadonlyArray<DependencyIds>,
  ): Effect.Effect<(server: DependencyIds) => McpServerDependencies, SqlError> =>
    Effect.gen(function* () {
      const found = yield* connections.readMany([...new Set(given.map((one) => one.connectionId))]);
      const loaded = yield* plugins.loaded();
      const registered = yield* plugins.listMcpServers();
      const readPluginState = (contributionId: string): PluginState => {
        const contribution = registered.find((one) => one.id === contributionId);
        if (contribution === undefined) return { _tag: "missing" };
        const plugin = loaded.find((one) => one.id === contribution.pluginId);
        if (plugin?.status._tag === "active") return { _tag: "active", contribution };
        return {
          _tag: plugin?.status._tag === "errored" ? "failed-to-start" : "switched-off",
          pluginName: plugin?.displayName ?? contribution.pluginId,
        };
      };
      return (server) => ({
        connection: found.get(server.connectionId),
        plugin: readPluginState(server.contributionId),
      });
    });

  /**
   * Returns the view of each server that exists, by its id, as it is now. An
   * id that no server has is left out of the map. It costs one query for the
   * servers, one for their Connections and one read of the plugin host,
   * however many ids there are. A reader that only judges the servers asks for
   * `without-tools`, and the query then leaves the stored tool definitions
   * unread.
   */
  function readViews(
    ids: ReadonlyArray<string>,
    columns?: "with-tools",
  ): Effect.Effect<ReadonlyMap<string, McpServerView>, SqlError>;
  function readViews(
    ids: ReadonlyArray<string>,
    columns: "without-tools",
  ): Effect.Effect<ReadonlyMap<string, McpServerAvailabilityView>, SqlError>;
  function readViews(
    ids: ReadonlyArray<string>,
    columns: McpServerColumns = "with-tools",
  ): Effect.Effect<ReadonlyMap<string, McpServerAvailabilityView>, SqlError> {
    return Effect.gen(function* () {
      const found = yield* servers.readMany(ids, columns);
      const findDependencies = yield* readDependenciesOfMany([...found.values()]);
      return new Map(
        [...found].map(([id, server]) => [id, { server, dependencies: findDependencies(server) }]),
      );
    });
  }

  return {
    /** Reads the Connection and the plugin of a server as they are now. */
    readDependencies: (server: DependencyIds): Effect.Effect<McpServerDependencies, SqlError> =>
      Effect.map(readDependenciesOfMany([server]), (findDependencies) => findDependencies(server)),

    readViews,
  };
});

/**
 * Builds the catalogue view on the database and the plugin host. A service
 * builds it once, when the service is built.
 */
export const mcpServerCatalogue = make;
