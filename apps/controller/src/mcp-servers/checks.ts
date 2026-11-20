/**
 * The check of an MCP Server: it lists the server's tools from the outside
 * server and writes the outcome as the server's status (spec 21 sections 5.1,
 * 5.3 and 5.4).
 *
 * At most one check runs per server. A request that comes while a check runs
 * makes it run once more when it ends, because the request may be about
 * something the running check has already read.
 */
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import type { McpSchema } from "effect/ai";
import { absorbFailures } from "../absorbing";
import {
  ConnectionTypes,
  connectionRepository,
  type ConnectionCredentialsForUse,
  type ConnectionCredentialsUnavailable,
} from "../connections";
import { nowIso } from "../db";
import { Notifier } from "../notifications";
import { PluginHost, type RegisteredMcpServer } from "../plugins";
import { PromotionState } from "../promotion";
import type { McpServerEdit, StoredMcpServer, StoredMcpTool } from "./repository";
import { mcpServerRepository } from "./repository";
import { computeBackoffMillis, DAILY_CHECK_MILLIS, readBasis, writeServerState } from "./state";
import { MAX_UPSTREAM_MESSAGE_BYTES, openUpstream, type UpstreamError } from "./upstream";

/**
 * Asks for a new list of an MCP Server's tools from the outside server. The
 * MCP Server service calls it after the commit of a create, a switch on, or a
 * "check now", and the Connection follower after a reconnect.
 */
export class McpServerChecks extends Context.Service<
  McpServerChecks,
  {
    /**
     * Requests a new list of this server's tools, soon, and returns at once.
     * The result is written to the server later and announced on the
     * `mcpServer` live topic. Never fails: a check that cannot run sets the
     * server's status instead.
     */
    readonly request: (id: string) => Effect.Effect<void>;
    /**
     * Requests a check of every enabled server whose next check is due or not
     * planned yet, except those with a check running or waiting. Fails only
     * when the database cannot be read.
     */
    readonly requestDue: Effect.Effect<void, SqlError>;
  }
>()("hercule/controller/mcp-servers/McpServerChecks") {}

/** How long listing the tools may take, from the first request to the last page. */
const LIST_DEADLINE = Duration.seconds(60);

/** What a check found out. */
type CheckResult =
  | {
      readonly _tag: "ready";
      readonly tools: ReadonlyArray<StoredMcpTool>;
      readonly revision: string;
    }
  | {
      readonly _tag: "failed";
      readonly status: "unreachable" | "error" | "needs-sign-in";
      readonly detail: string;
      /** What made the status, when it is the plugin or the Connection and not the server. */
      readonly cause: "plugin" | "connection" | null;
    };

const failed = (
  status: "unreachable" | "error" | "needs-sign-in",
  detail: string,
  cause: "plugin" | "connection" | null = null,
): CheckResult => ({ _tag: "failed", status, detail, cause });

/** Copies a tool as plain JSON, keeping the whole definition so the gateway can serve it. */
const toStoredTool = (tool: McpSchema.Tool): StoredMcpTool =>
  JSON.parse(
    JSON.stringify({
      name: tool.name,
      title: tool.title,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      annotations: tool.annotations,
    }),
  ) as StoredMcpTool;

/**
 * Builds the edit that stores a check's outcome. A success stores the tools
 * and resets the schedule to a day. A server that cannot be reached backs off
 * (spec 21 section 5.3). Any other failure waits a day.
 */
const buildEdit = (server: StoredMcpServer, result: CheckResult, at: string): McpServerEdit => {
  const atMillis = Date.parse(at);
  const planAfter = (millis: number): string => new Date(atMillis + millis).toISOString();
  if (result._tag === "ready") {
    return {
      status: "ready",
      statusDetail: null,
      statusCause: null,
      tools: result.tools,
      checkedAt: at,
      protocolVersion: result.revision,
      failedChecks: 0,
      nextCheckAt: planAfter(DAILY_CHECK_MILLIS),
    };
  }
  if (result.status === "unreachable") {
    const failedChecks = server.failedChecks + 1;
    return {
      status: "unreachable",
      statusDetail: result.detail,
      statusCause: null,
      failedChecks,
      nextCheckAt: planAfter(computeBackoffMillis(failedChecks)),
    };
  }
  return {
    status: result.status,
    statusDetail: result.detail,
    statusCause: result.cause,
    failedChecks: 0,
    nextCheckAt: planAfter(DAILY_CHECK_MILLIS),
  };
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const servers = yield* mcpServerRepository;
  const connections = yield* connectionRepository;
  const connectionTypes = yield* ConnectionTypes;
  const plugins = yield* PluginHost;
  const promotion = yield* PromotionState;
  const notifier = yield* Notifier;
  const httpClient = yield* HttpClient.HttpClient;
  const scope = yield* Effect.scope;

  /** Names the Connection for a person, or says "the Connection" when it is gone. */
  const readConnectionLabel = (connectionId: string): Effect.Effect<string, SqlError> =>
    Effect.map(connections.one(connectionId), (found) =>
      Option.isSome(found) ? found.value.label : "the Connection",
    );

  const describeUnavailable = (
    error: ConnectionCredentialsUnavailable,
    label: string,
  ): CheckResult => {
    switch (error.reason) {
      case "needs-sign-in":
        return failed(
          "needs-sign-in",
          `Reconnect ${label} in Settings > Connections`,
          "connection",
        );
      case "switched-off":
        return failed("error", `The Connection ${label} is switched off`, "connection");
      case "unreachable":
        return failed("unreachable", error.message);
      case "missing":
      case "invalid-config":
        return failed("error", error.message);
    }
  };

  /** Lists the tools once, on a short-lived client of its own. */
  const listTools = (
    contribution: RegisteredMcpServer,
    credentials: ConnectionCredentialsForUse,
    firstRevision: string | null,
  ): Effect.Effect<
    { readonly tools: ReadonlyArray<McpSchema.Tool>; readonly revision: string },
    UpstreamError
  > =>
    Effect.scoped(
      Effect.gen(function* () {
        const opened = yield* openUpstream({ contribution, credentials, firstRevision });
        const tools = yield* opened.client
          .listTools({ timeout: LIST_DEADLINE })
          .pipe(Effect.mapError(opened.describeFailure));
        return { tools, revision: opened.revision };
      }),
    ).pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.provideService(PromotionState, promotion),
    );

  const describeUpstreamFailure = (
    failure: UpstreamError,
    contribution: RegisteredMcpServer,
  ): CheckResult => {
    switch (failure.reason) {
      case "unreachable":
      case "timeout":
        return failed("unreachable", failure.message);
      case "unauthorized":
        return failed(
          "error",
          `${contribution.displayName}'s MCP server refused the Connection's token`,
        );
      default:
        return failed("error", failure.message);
    }
  };

  /**
   * Works out the outcome of one check. Never fails except for the database:
   * every other failure is an outcome that becomes the server's status.
   */
  const evaluate = (server: StoredMcpServer): Effect.Effect<CheckResult, SqlError> =>
    Effect.gen(function* () {
      const found = yield* plugins.findMcpServer(server.contributionId);
      if (Option.isNone(found)) {
        return failed(
          "error",
          "The plugin that offered this server is not in this build",
          "plugin",
        );
      }
      const contribution = found.value;
      if (!(yield* plugins.isActive(contribution.pluginId))) {
        const name =
          (yield* plugins.loaded()).find((plugin) => plugin.id === contribution.pluginId)
            ?.displayName ?? contribution.pluginId;
        return failed("error", `The ${name} plugin is switched off`, "plugin");
      }

      const read = yield* Effect.result(connectionTypes.readCredentialsForUse(server.connectionId));
      if (read._tag === "Failure") {
        return describeUnavailable(read.failure, yield* readConnectionLabel(server.connectionId));
      }

      let outcome = yield* Effect.result(
        listTools(contribution, read.success, server.protocolVersion),
      );
      if (outcome._tag === "Failure" && outcome.failure.reason === "unauthorized") {
        const refresh = yield* Effect.result(
          connectionTypes.refreshAfterRejection(
            server.connectionId,
            outcome.failure.sentIdentity ?? read.success.identity,
          ),
        );
        if (refresh._tag === "Failure") {
          return refresh.failure._tag === "ConnectionCannotRefresh"
            ? describeUpstreamFailure(outcome.failure, contribution)
            : describeUnavailable(refresh.failure, yield* readConnectionLabel(server.connectionId));
        }
        outcome = yield* Effect.result(
          listTools(contribution, refresh.success, server.protocolVersion),
        );
      }
      if (outcome._tag === "Failure") return describeUpstreamFailure(outcome.failure, contribution);

      const tools = outcome.success.tools.map(toStoredTool);
      if (new TextEncoder().encode(JSON.stringify(tools)).length > MAX_UPSTREAM_MESSAGE_BYTES) {
        return failed("error", "The server's tool list is larger than 4 MiB");
      }
      return { _tag: "ready", tools, revision: outcome.success.revision } satisfies CheckResult;
    });

  /**
   * Checks one server and writes the outcome, unless the server changed
   * meanwhile: then the outcome is dropped, and whatever changed it requests
   * its own check.
   */
  const checkOnce = (id: string): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      const found = yield* servers.readById(id);
      if (Option.isNone(found) || !found.value.enabled) return;
      const server = found.value;
      const result = yield* evaluate(server);
      const at = yield* nowIso;
      yield* promotion.whenServing(
        writeServerState(id, readBasis(server), buildEdit(server, result, at), at).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.provideService(Notifier, notifier),
        ),
      );
    });

  // "running": a check is in progress. "again": a request came during it.
  const inFlight = new Map<string, "running" | "again">();

  const runUntilNoRequestIsWaiting = (id: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      while (true) {
        yield* absorbFailures(`Checking MCP server ${id} failed`, checkOnce(id));
        if (inFlight.get(id) !== "again") return;
        inFlight.set(id, "running");
      }
    }).pipe(Effect.ensuring(Effect.sync(() => inFlight.delete(id))));

  const request = (id: string): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (inFlight.has(id)) {
        inFlight.set(id, "again");
        return Effect.void;
      }
      inFlight.set(id, "running");
      return Effect.asVoid(Effect.forkIn(runUntilNoRequestIsWaiting(id), scope));
    });

  return McpServerChecks.of({
    request,
    requestDue: Effect.gen(function* () {
      const due = yield* servers.listDueForCheck(yield* nowIso);
      for (const server of due) {
        if (!inFlight.has(server.id)) yield* request(server.id);
      }
    }),
  });
});

/** The MCP Server checks, reaching outside servers through `fetch`. */
export const McpServerChecksLayer: Layer.Layer<
  McpServerChecks,
  never,
  SqlClient.SqlClient | ConnectionTypes | PluginHost | PromotionState | Notifier
> = Layer.effect(McpServerChecks)(make).pipe(Layer.provide(FetchHttpClient.layer));
