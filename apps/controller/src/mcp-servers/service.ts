/**
 * The MCP Server operations: `mcpServer.query`, `read`, `create`, `update`,
 * `delete` and `check` (spec 11 section 2, spec 21 section 2).
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
  type McpServerUpdateInput,
  type NotFound,
  type Validation,
} from "@hercule/contract";
import { currentStamp, requireGrant } from "../actor";
import { connectionRepository } from "../connections";
import { nowIso, withTransaction } from "../db";
import { AuditLog } from "../events";
import { PluginHost } from "../plugins";
import { McpServerChecks } from "./checks";
import { McpServerListHolders } from "./list-holders";
import { mcpServerRepository, type StoredMcpServer } from "./repository";

/** What `update` takes: the server and the fields to change. */
export type UpdateInput = McpServerUpdateInput & { readonly id: string };

const NO_SUCH_SERVER = "no such MCP server; `hercule mcp-server list` shows the servers there are";

/** Returns the public record of a stored server, with each tool cut down to its summary. */
const toRecord = (server: StoredMcpServer): McpServer => ({
  id: server.id,
  name: server.name,
  source: {
    kind: "plugin",
    contributionId: server.contributionId,
    connectionId: server.connectionId,
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
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const servers = yield* mcpServerRepository;
  const connections = yield* connectionRepository;
  const plugins = yield* PluginHost;
  const audit = yield* AuditLog;
  const checks = yield* McpServerChecks;
  const listHolders = yield* McpServerListHolders;

  const readOrFail = (id: string): Effect.Effect<StoredMcpServer, NotFound | SqlError> =>
    Effect.flatMap(
      servers.readById(id),
      Option.match({
        onNone: () => Effect.fail(createNotFoundError(NO_SUCH_SERVER)),
        onSome: Effect.succeed,
      }),
    );

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
     * Creates a server from a plugin's contribution and one of the plugin's
     * Connections, switched on and in status `checking`, and returns it. The
     * first list of its tools is requested after the commit. Fails with:
     *
     * - `Validation` when no plugin offers the contribution, or the
     *   Connection does not exist or is not of the contribution's Connection
     *   type;
     * - `Conflict`, naming the existing server, when the contribution already
     *   has a server for the Connection's external account.
     *
     * The name is the one given, or else the contribution's own word.
     */
    create: (
      input: McpServerCreateInput,
    ): Effect.Effect<McpServer, Forbidden | Validation | Conflict | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("mcpServer.create");
        const { contributionId, connectionId, name } = input.source;
        const created = yield* withTransaction(
          sql,
          Effect.gen(function* () {
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
            const existing = yield* servers.findByContributionAndAccount(
              contributionId,
              connection.value.accountId,
            );
            if (Option.isSome(existing)) {
              return yield* Effect.fail(
                createConflictError(
                  `This account already has an MCP server for ${contributionId}: ${existing.value.name} (${existing.value.id}). Use that server, or delete it first with \`hercule mcp-server delete ${existing.value.id}\`.`,
                ),
              );
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
          }),
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
     * Deletes a server and removes it from every Project's and Session's list,
     * in one transaction. Fails with `NotFound` when there is no such server.
     */
    delete: (id: string): Effect.Effect<Record<string, never>, Forbidden | NotFound | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("mcpServer.delete");
        yield* withTransaction(
          sql,
          Effect.gen(function* () {
            yield* readOrFail(id);
            yield* listHolders.removeServer(id);
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
  };
});

/** The MCP Server operations. */
export class McpServerService extends Context.Service<
  McpServerService,
  Effect.Success<typeof make>
>()("hercule/controller/mcp-servers/McpServerService") {}

export const McpServerServiceLayer = Layer.effect(McpServerService)(make);
