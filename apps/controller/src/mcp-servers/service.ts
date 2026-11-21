/**
 * The MCP Server operations: `mcpServer.query`, `read`, `create`, `update`,
 * `delete`, `check` and `setToken` (spec 11 section 2, spec 21 section 2).
 *
 * Every write runs in one transaction with its audit entry, stamps the
 * caller as the actor, and announces the server on the `mcpServer` live topic
 * through that entry. A new list of the server's tools is requested after the
 * commit, never inside it, because a check waits on an outside server.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import {
  createConflictError,
  createInvalidStateError,
  createNotFoundError,
  createValidationError,
  type Conflict,
  type Forbidden,
  type InvalidState,
  type McpServer,
  type McpServerCreateInput,
  type McpServerSetTokenInput,
  type McpServerUpdateInput,
  type NotFound,
  type Validation,
} from "@hercule/contract";
import { currentStamp, requireGrant } from "../actor";
import { connectionRepository } from "../connections";
import { nowIso, withTransaction } from "../db";
import { AuditLog } from "../events";
import { PluginHost } from "../plugins";
import {
  buildDefaultServerName,
  findPluginOnOrigin,
  parseServerAddress,
  type ServerAddress,
} from "./addresses";
import { mcpServerCatalogue, type PluginState } from "./catalogue";
import { McpServerChecks } from "./checks";
import { McpServerListHolders } from "./list-holders";
import { mcpServerRepository, type StoredMcpServer } from "./repository";
import { mcpServerSignIns } from "./sign-ins";

/** What `update` takes: the server and the fields to change. */
export type UpdateInput = McpServerUpdateInput & { readonly id: string };

/** What `setToken` takes: the server and the token. */
export type SetTokenInput = McpServerSetTokenInput & { readonly id: string };

/** The source a `create` is given, of either kind. */
type CreateSource = McpServerCreateInput["source"];

const NO_SUCH_SERVER = "no such MCP server; `hercule mcp-server list` shows the servers there are";

/** Returns the public record of a stored server, with each tool cut down to its summary. */
const toRecord = (server: StoredMcpServer): McpServer => {
  const { source } = server;
  return {
    id: server.id,
    name: server.name,
    source:
      source.kind === "plugin"
        ? {
            kind: "plugin",
            contributionId: source.contributionId,
            connectionId: source.connectionId,
          }
        : {
            kind: "url",
            url: source.url,
            signIn: source.signIn,
            signInOffered: source.signInOffered,
          },
    enabled: server.enabled,
    status: server.status,
    statusDetail: server.statusDetail,
    tools: server.tools.map((tool) => ({
      name: tool.name,
      ...(tool.title === undefined ? {} : { title: tool.title }),
      description: tool.description,
    })),
    checkedAt: server.checkedAt,
    createdAt: server.createdAt,
    updatedAt: server.updatedAt,
  };
};

/**
 * Builds the refusal for a plugin server that exists already. The details
 * name the existing server, so a client can point at it.
 */
const buildPluginServerExists = (contributionId: string, existing: StoredMcpServer): Conflict =>
  createConflictError(
    `This account already has an MCP server for ${contributionId}: ${existing.name} (${existing.id}). Use that server, or delete it first with \`hercule mcp-server delete ${existing.id}\`.`,
    { reason: "mcp-server-exists", mcpServerId: existing.id },
  );

/** Builds the refusal for an address that was added before. */
const buildUrlServerExists = (existing: StoredMcpServer): Conflict =>
  createConflictError(
    `You added this server before, as ${existing.name} (${existing.id}). One address is one server: use that one, or delete it first with \`hercule mcp-server delete ${existing.id}\`.`,
    { reason: "mcp-server-exists", mcpServerId: existing.id },
  );

/**
 * Builds what the user does instead of adding a plugin's server by address,
 * by what the user has: the plugin is switched off or failed to start, or it
 * runs and the user has a Connection of its type or has none.
 */
const buildPluginOriginAdvice = (facts: {
  readonly plugin: string;
  readonly contributionId: string;
  readonly state: PluginState["_tag"];
  readonly connection: { readonly id: string; readonly label: string } | undefined;
}): string => {
  const { plugin, contributionId, connection } = facts;
  const switchOn = "switch its server on in Settings > MCP servers";
  const connectFirst = connection === undefined ? "connect it, then " : "";
  switch (facts.state) {
    case "failed-to-start":
      return `The ${plugin} plugin failed to start: see Settings > Plugins. Once it runs, ${connectFirst}${switchOn}.`;
    case "active":
      return connection === undefined
        ? `It is reached with a ${plugin} Connection, with no second sign-in. Connect ${plugin} first in Settings > Connections, then ${switchOn}.`
        : `It is reached with your ${plugin} Connection ${connection.label}, with no second sign-in: switch it on in Settings > MCP servers, or run \`hercule mcp-server create --plugin ${contributionId} --connection ${connection.id}\`.`;
    default:
      return `The ${plugin} plugin is switched off: switch it on in Settings > Plugins, ${connection === undefined ? connectFirst : "then "}${switchOn}.`;
  }
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const servers = yield* mcpServerRepository;
  const connections = yield* connectionRepository;
  const plugins = yield* PluginHost;
  const audit = yield* AuditLog;
  const checks = yield* McpServerChecks;
  const listHolders = yield* McpServerListHolders;
  const signIns = yield* mcpServerSignIns;
  const { readPluginState } = yield* mcpServerCatalogue;

  const readOrFail = (id: string): Effect.Effect<StoredMcpServer, NotFound | SqlError> =>
    Effect.flatMap(
      servers.readById(id),
      Option.match({
        onNone: () => Effect.fail(createNotFoundError(NO_SUCH_SERVER)),
        onSome: Effect.succeed,
      }),
    );

  /**
   * Fails with a `Conflict` when a plugin offers an MCP server on the origin
   * of the address, whatever the state of that plugin: the server is made
   * from the plugin's Connection, so it has the Connection's sign-in and
   * nothing is asked of the user twice. The details and the message say what
   * to do, by what the user has:
   *
   * - an enabled Connection of the contribution's type (or else any one);
   * - no Connection, so the user connects the plugin first;
   * - a plugin that is switched off or failed to start, so the user switches
   *   it on first.
   *
   * Only contributions the plugin host knows reserve an origin. One whose
   * registration failed is not known, so its origin is free to add by address.
   */
  const refuseAddressOnPluginOrigin = (
    address: ServerAddress,
  ): Effect.Effect<void, Conflict | SqlError> =>
    Effect.gen(function* () {
      const contribution = findPluginOnOrigin(address.origin, yield* plugins.listMcpServers());
      if (contribution === undefined) return;
      const state = yield* readPluginState(contribution.id);
      const ofType = (yield* connections.ofPlugin(contribution.pluginId)).filter(
        (connection) => connection.type === contribution.connectionType,
      );
      const connection = ofType.find((one) => one.status !== "disabled") ?? ofType[0];
      return yield* Effect.fail(
        createConflictError(
          `${address.origin} is the ${contribution.displayName} MCP server. ${buildPluginOriginAdvice(
            {
              plugin: contribution.displayName,
              contributionId: contribution.id,
              state: state._tag,
              connection,
            },
          )}`,
          {
            reason: "mcp-server-on-plugin-origin",
            contributionId: contribution.id,
            connectionId: connection?.id ?? null,
            pluginEnabled: state._tag === "active",
          },
        ),
      );
    });

  /** Inserts a server of a plugin's contribution, in a transaction `create` opened. */
  const insertPluginServer = (
    source: Extract<CreateSource, { readonly kind: "plugin" }>,
  ): Effect.Effect<StoredMcpServer, Validation | Conflict | SqlError> =>
    Effect.gen(function* () {
      const { contributionId, connectionId, name } = source;
      const contribution = yield* plugins.findMcpServer(contributionId);
      if (Option.isNone(contribution)) {
        return yield* Effect.fail(
          createValidationError([
            {
              path: ["source", "contributionId"],
              message: "no plugin offers an MCP server with this id",
            },
          ]),
        );
      }
      const connection = yield* connections.one(connectionId);
      if (Option.isNone(connection)) {
        return yield* Effect.fail(
          createValidationError([
            { path: ["source", "connectionId"], message: "no such connection" },
          ]),
        );
      }
      if (connection.value.type !== contribution.value.connectionType) {
        return yield* Effect.fail(
          createValidationError([
            {
              path: ["source", "connectionId"],
              message: `this server is reached with a ${contribution.value.connectionType} connection, and this connection is a ${connection.value.type} connection`,
            },
          ]),
        );
      }
      // The lookup and the insert run in one transaction, and SQLite lets one
      // writer at a time through, so a create that committed first is always
      // seen here. The table's UNIQUE constraint on the contribution and the
      // account is only a backstop.
      const existing = yield* servers.findByContributionAndAccount(
        contributionId,
        connection.value.accountId,
      );
      if (Option.isSome(existing)) {
        return yield* Effect.fail(buildPluginServerExists(contributionId, existing.value));
      }
      const at = yield* nowIso;
      const server = yield* servers.insert({
        name: name ?? contributionId.slice(contributionId.lastIndexOf("/") + 1),
        contributionId,
        connectionId,
        accountId: connection.value.accountId,
        connectionGeneration: connection.value.credentialsGeneration,
        at,
      });
      yield* audit.append({
        kind: "mcpServer.created",
        actor: yield* currentStamp,
        record: { topic: "mcpServer", id: server.id },
        payload: { mcpServerId: server.id, contributionId, connectionId },
        at,
      });
      return server;
    });

  /**
   * Inserts a server added by address, with its token when one is given, in a
   * transaction `create` opened. The audit entry names the server by id and
   * says only that it was added by address: the address may hold a secret in
   * its query, and the token is never written anywhere but its secret.
   */
  const insertUrlServer = (
    source: Extract<CreateSource, { readonly kind: "url" }>,
  ): Effect.Effect<StoredMcpServer, Validation | Conflict | SqlError> =>
    Effect.gen(function* () {
      const address = yield* parseServerAddress(source.url);
      yield* refuseAddressOnPluginOrigin(address);
      // As in `insertPluginServer`: one transaction and one writer at a time
      // make this lookup see every committed create, and the UNIQUE
      // constraint on the address is only a backstop.
      const existing = yield* servers.findByNormalizedUrl(address.normalizedUrl);
      if (Option.isSome(existing)) return yield* Effect.fail(buildUrlServerExists(existing.value));
      const name = source.name ?? (yield* buildDefaultServerName(address));
      const at = yield* nowIso;
      const server = yield* servers.insertUrl({
        name,
        url: address.url,
        normalizedUrl: address.normalizedUrl,
        signIn: source.token === undefined ? "none" : "token",
        at,
      });
      if (source.token !== undefined) yield* signIns.storeToken(server.id, source.token);
      yield* audit.append({
        kind: "mcpServer.created",
        actor: yield* currentStamp,
        record: { topic: "mcpServer", id: server.id },
        payload: { mcpServerId: server.id, sourceKind: "url" },
        at,
      });
      return server;
    });

  return {
    /** Returns every MCP Server, sorted by name. */
    query: (): Effect.Effect<{ readonly items: ReadonlyArray<McpServer> }, Forbidden | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("mcpServer.query");
        return { items: (yield* servers.list()).map(toRecord) };
      }),

    /** Returns one MCP Server. Fails with `NotFound` when there is no such server. */
    read: (id: string): Effect.Effect<McpServer, Forbidden | NotFound | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("mcpServer.read");
        return toRecord(yield* readOrFail(id));
      }),

    /**
     * Creates a server, switched on and in status `checking`, and returns it.
     * The first list of its tools is requested after the commit. The source
     * is one of two kinds:
     *
     * - `plugin`: a plugin's contribution and one of the plugin's Connections.
     *   The name is the one given, or else the contribution's own word.
     * - `url`: an address, with an optional token that is stored as the
     *   server's sign-in before the first check. The name is the one given, or
     *   else the host's first label that is not `mcp`, `www` or `api`.
     *
     * Fails with:
     *
     * - `Validation` when no plugin offers the contribution, the Connection
     *   does not exist or is not of the contribution's Connection type, or the
     *   address is not an http or https address, holds a user name, a password
     *   or a `#fragment`, or gives no usable name;
     * - `Conflict` with `mcp-server-exists`, naming the existing server, when
     *   the contribution already has a server for the Connection's external
     *   account, or the address is one already added (two spellings of one
     *   address are one address);
     * - `Conflict` with `mcp-server-on-plugin-origin` when the address is one
     *   a plugin offers a server for.
     *
     * Two creates of one server that run at once get one server and one
     * `mcp-server-exists` refusal.
     */
    create: (
      input: McpServerCreateInput,
    ): Effect.Effect<McpServer, Forbidden | Validation | Conflict | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("mcpServer.create");
        const { source } = input;
        const created = yield* withTransaction(
          sql,
          source.kind === "plugin" ? insertPluginServer(source) : insertUrlServer(source),
        );
        yield* checks.wake;
        return toRecord(created);
      }),

    /**
     * Switches a server on or off and returns it. Switching on puts the status
     * back to `checking` and requests a new list after the commit. Switching
     * off leaves the status, because a client shows Off from `enabled`. Giving
     * the value the server already has writes nothing. Fails with `Validation`
     * when `enabled` is not given, and with `NotFound` when there is no such
     * server.
     */
    update: (
      input: UpdateInput,
    ): Effect.Effect<McpServer, Forbidden | Validation | NotFound | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("mcpServer.update");
        const { id, enabled } = input;
        if (enabled === undefined) {
          return yield* Effect.fail(
            createValidationError([{ path: ["enabled"], message: "give enabled" }]),
          );
        }
        const { server, changed } = yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const current = yield* readOrFail(id);
            if (current.enabled === enabled) return { server: current, changed: false };
            const at = yield* nowIso;
            yield* servers.writeEnabled(id, enabled, at);
            yield* audit.append({
              kind: "mcpServer.updated",
              actor: yield* currentStamp,
              record: { topic: "mcpServer", id },
              payload: { mcpServerId: id, enabled },
              at,
            });
            return { server: yield* readOrFail(id), changed: true };
          }),
        );
        if (changed && enabled) yield* checks.wake;
        return toRecord(server);
      }),

    /**
     * Deletes a server, its sign-in secrets, and its place in every Project's
     * and Session's list, in one transaction. Fails with `NotFound` when there is no such server.
     */
    delete: (id: string): Effect.Effect<Record<string, never>, Forbidden | NotFound | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("mcpServer.delete");
        yield* withTransaction(
          sql,
          Effect.gen(function* () {
            yield* readOrFail(id);
            yield* listHolders.removeServer(id);
            yield* signIns.deleteAll(id);
            yield* servers.remove(id);
            yield* audit.append({
              kind: "mcpServer.deleted",
              actor: yield* currentStamp,
              record: { topic: "mcpServer", id },
              payload: { mcpServerId: id },
            });
          }),
        );
        return {};
      }),

    /**
     * Requests a new list of the server's tools and returns at once. It also
     * resets the server's failed checks, so a server that was backing off is
     * checked again on the short waits, marks the next check as due now, so
     * the check still happens when the request is lost to a restart, and raises
     * its revision, so a check that is running cannot write its older result
     * over the reset. Fails with
     * `NotFound` when there is no such server, and with `InvalidState` when the
     * server is switched off.
     */
    check: (
      id: string,
    ): Effect.Effect<Record<string, never>, Forbidden | NotFound | InvalidState | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("mcpServer.check");
        yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const server = yield* readOrFail(id);
            if (!server.enabled) {
              return yield* Effect.fail(
                createInvalidStateError(
                  `this MCP server is switched off; switch the server on first: hercule mcp-server update ${id} --enabled true`,
                ),
              );
            }
            yield* servers.resetSchedule(id, yield* nowIso);
          }),
        );
        yield* checks.wake;
        return {};
      }),

    /**
     * Gives a server added by URL the token the user pasted, replacing every
     * sign-in secret it holds, and returns the server. The server goes back
     * to `checking` and its revision goes up, which ends the upstream
     * sessions and the running checks that used the old sign-in. A new list
     * of its tools is requested after the commit. The audit entry says the
     * sign-in is now a token and never holds the token. Fails with `NotFound`
     * when there is no such server, and with `InvalidState` for a plugin
     * server, whose credential is its Connection's.
     */
    setToken: (
      input: SetTokenInput,
    ): Effect.Effect<McpServer, Forbidden | NotFound | InvalidState | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("mcpServer.setToken");
        const { id, token } = input;
        const server = yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const current = yield* readOrFail(id);
            if (current.source.kind === "plugin") {
              const connection = yield* connections.one(current.source.connectionId);
              const reached = Option.isSome(connection)
                ? `the Connection ${connection.value.label}`
                : "a Connection of its plugin";
              return yield* Effect.fail(
                createInvalidStateError(
                  `this server is reached with ${reached}; reconnect that Connection in Settings > Connections instead`,
                ),
              );
            }
            const at = yield* nowIso;
            yield* signIns.deleteAll(id);
            yield* signIns.storeToken(id, token);
            yield* servers.writeTokenSignIn(id, at);
            yield* audit.append({
              kind: "mcpServer.updated",
              actor: yield* currentStamp,
              record: { topic: "mcpServer", id },
              payload: { mcpServerId: id, signIn: "token" },
              at,
            });
            return yield* readOrFail(id);
          }),
        );
        yield* checks.wake;
        return toRecord(server);
      }),
  };
});

/** The MCP Server operations. */
export class McpServerService extends Context.Service<
  McpServerService,
  Effect.Success<typeof make>
>()("hercule/controller/mcp-servers/McpServerService") {}

export const McpServerServiceLayer = Layer.effect(McpServerService)(make);
