/**
 * The check of an MCP Server: it lists the server's tools from the outside
 * server and writes the outcome as the server's status (spec 21 sections 5.1,
 * 5.3 and 5.4).
 *
 * At most one check runs per server. A request that comes while a check runs
 * makes it run once more when it ends, because the request may be about
 * something the running check has already read.
 *
 * A check is background work admitted by the promotion state: it does not
 * start while the controller is frozen or sealed, and a freeze waits for it to
 * end. So a check never waits on a freeze while it talks to the outside
 * server, and a freeze never turns into an `unreachable` status.
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
  type ConnectionCredentialsForUse,
  type ConnectionCredentialsUnavailable,
  type StoredConnection,
} from "../connections";
import { nowIso } from "../db";
import { Notifier } from "../notifications";
import { PluginHost, type RegisteredMcpServer } from "../plugins";
import { PromotionState } from "../promotion";
import type { McpServerEdit, StoredMcpServer, StoredMcpTool } from "./repository";
import { mcpServerRepository } from "./repository";
import {
  buildFailureEdit,
  DAILY_CHECK_MILLIS,
  judgeDependencies,
  markDueWhenUsable,
  readServerWhileBasisHolds,
  readDependencies,
  writeServerState,
  type McpServerDependencies,
} from "./state";
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

/**
 * The MCP revision whose handshake worked during a check, or `null` while none
 * has. A check keeps it even when the listing fails after the handshake, so
 * the next try starts with a revision known to work.
 */
interface WorkedRevision {
  current: string | null;
}

/** What a check found out. */
type CheckResult =
  | { readonly _tag: "discarded" }
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

const buildFailedResult = (
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
 * and resets the schedule to a day. A failure is stored as `buildFailureEdit`
 * builds it, with the revision whose handshake worked, when one did.
 */
const buildEdit = (
  server: StoredMcpServer,
  result: Exclude<CheckResult, { readonly _tag: "discarded" }>,
  at: string,
  worked: WorkedRevision,
): McpServerEdit => {
  const atMillis = Date.parse(at);
  if (result._tag === "ready") {
    return {
      status: "ready",
      statusDetail: null,
      statusCause: null,
      tools: result.tools,
      checkedAt: at,
      protocolVersion: result.revision,
      failedChecks: 0,
      nextCheckAt: new Date(atMillis + DAILY_CHECK_MILLIS).toISOString(),
    };
  }
  return buildFailureEdit(server, result, at, worked.current ?? undefined);
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const servers = yield* mcpServerRepository;
  const connectionTypes = yield* ConnectionTypes;
  const plugins = yield* PluginHost;
  const promotion = yield* PromotionState;
  const notifier = yield* Notifier;
  const httpClient = yield* HttpClient.HttpClient;
  const scope = yield* Effect.scope;

  /**
   * Turns a Connection's failure to give credentials into a failed outcome.
   * The text is fixed here and never the Connection's own message, which may
   * hold what the provider sent.
   */
  const describeUnavailable = (
    error: ConnectionCredentialsUnavailable,
    contribution: RegisteredMcpServer,
    connection: StoredConnection,
  ): CheckResult => {
    switch (error.reason) {
      case "needs-sign-in":
        return buildFailedResult(
          "needs-sign-in",
          `Reconnect ${connection.label} in Settings > Connections`,
          "connection",
        );
      case "switched-off":
        return buildFailedResult(
          "error",
          `The Connection ${connection.label} is switched off`,
          "connection",
        );
      case "unreachable":
        return buildFailedResult(
          "unreachable",
          `${contribution.displayName} could not be reached to refresh the sign-in`,
        );
      case "credentials-replaced":
        // The Connection is fine: the user reconnected twice while the
        // sign-in was refreshed. The backoff checks again soon.
        return buildFailedResult(
          "unreachable",
          `The sign-in of ${connection.label} was replaced while it was being refreshed`,
        );
      case "no-credentials":
        return buildFailedResult(
          "error",
          `The Connection ${connection.label} holds no credentials: reconnect it in Settings > Connections`,
        );
      case "missing":
        return buildFailedResult("error", "The Connection of this server is missing");
      case "invalid-config":
        return buildFailedResult(
          "error",
          `The settings of ${connection.label} no longer fit its type: check them in Settings > Connections`,
        );
    }
  };

  /**
   * Lists the tools once, on a short-lived client of its own. Records the
   * revision whose handshake worked in `worked`, before it lists, so the
   * revision is known when the listing fails.
   */
  const listTools = (
    contribution: RegisteredMcpServer,
    credentials: ConnectionCredentialsForUse,
    worked: WorkedRevision,
    firstRevision: string | null,
  ): Effect.Effect<
    { readonly tools: ReadonlyArray<McpSchema.Tool>; readonly revision: string },
    UpstreamError
  > =>
    Effect.scoped(
      Effect.gen(function* () {
        const opened = yield* openUpstream({ contribution, credentials, firstRevision });
        worked.current = opened.revision;
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
        return buildFailedResult("unreachable", failure.message);
      case "unauthorized":
        return buildFailedResult(
          "error",
          `${contribution.displayName}'s MCP server refused the Connection's token`,
        );
      default:
        return buildFailedResult("error", failure.message);
    }
  };

  /**
   * Works out the outcome of one check from the dependencies read at its
   * start. Never fails except for the database: every other failure is an
   * outcome that becomes the server's status.
   *
   * When the server answers 401, the Connection's credentials are refreshed
   * and the listing is tried once more. A refresh changes the Connection, so
   * it starts only if the server, its revision and its Connection are still
   * as the check found them. Otherwise the outcome is `discarded`, and the
   * Connection is left alone.
   */
  const evaluate = (
    server: StoredMcpServer,
    dependencies: McpServerDependencies,
    worked: WorkedRevision,
  ): Effect.Effect<CheckResult, SqlError, SqlClient.SqlClient | PluginHost> =>
    Effect.gen(function* () {
      const judged = judgeDependencies(dependencies);
      if (judged._tag === "unusable")
        return buildFailedResult(judged.status, judged.detail, judged.cause);
      const { contribution, connection } = judged;
      // Checked at use, not only at create, because the credentials of a
      // Connection of another type would go to this server's origin.
      if (connection.type !== contribution.connectionType) {
        return buildFailedResult(
          "error",
          `This server needs a ${contribution.connectionType} Connection, and ${connection.label} is another type`,
        );
      }

      const read = yield* Effect.result(connectionTypes.readCredentialsForUse(server.connectionId));
      if (read._tag === "Failure")
        return describeUnavailable(read.failure, contribution, connection);

      let outcome = yield* Effect.result(
        listTools(contribution, read.success, worked, server.protocolVersion),
      );
      if (outcome._tag === "Failure" && outcome.failure.reason === "unauthorized") {
        const current = yield* readServerWhileBasisHolds(server.id, {
          revision: server.revision,
          dependencies,
        });
        if (Option.isNone(current)) return { _tag: "discarded" } satisfies CheckResult;
        const refresh = yield* Effect.result(
          connectionTypes.refreshAfterRejection(
            server.connectionId,
            outcome.failure.sentIdentity ?? read.success.identity,
          ),
        );
        if (refresh._tag === "Failure") {
          return refresh.failure._tag === "ConnectionCannotRefresh"
            ? describeUpstreamFailure(outcome.failure, contribution)
            : describeUnavailable(refresh.failure, contribution, connection);
        }
        outcome = yield* Effect.result(
          listTools(
            contribution,
            refresh.success,
            worked,
            worked.current ?? server.protocolVersion,
          ),
        );
      }
      if (outcome._tag === "Failure") return describeUpstreamFailure(outcome.failure, contribution);

      const tools = outcome.success.tools.map(toStoredTool);
      if (new TextEncoder().encode(JSON.stringify(tools)).length > MAX_UPSTREAM_MESSAGE_BYTES) {
        return buildFailedResult("error", "The server's tool list is larger than 4 MiB");
      }
      return { _tag: "ready", tools, revision: outcome.success.revision } satisfies CheckResult;
    });

  /**
   * Checks one server and writes the outcome, unless the server, its
   * Connection or its plugin changed meanwhile: then the outcome is dropped.
   * Whatever changed the server requests its own check. When the server is
   * still enabled and its Connection and plugin are usable, the dropped check
   * also marks the server due, because a change that nothing announces, such
   * as a Connection moving from `connected` to `error`, requests no check.
   */
  const checkOnce = (id: string): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      const found = yield* servers.readById(id);
      if (Option.isNone(found) || !found.value.enabled) return;
      const server = found.value;
      const dependencies = yield* readDependencies(server);
      const worked: WorkedRevision = { current: null };
      const result = yield* evaluate(server, dependencies, worked);
      const at = yield* nowIso;
      const written =
        result._tag !== "discarded" &&
        (yield* writeServerState(
          id,
          { revision: server.revision, dependencies },
          buildEdit(server, result, at, worked),
          at,
        ));
      if (!written) yield* markDueWhenUsable(id, at);
    }).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.provideService(PluginHost, plugins),
      Effect.provideService(Notifier, notifier),
    );

  // "running": a check is in progress. "again": a request came during it.
  const inFlight = new Map<string, "running" | "again">();

  const runUntilNoRequestIsWaiting = (id: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      let requestedAgain = true;
      while (requestedAgain) {
        yield* absorbFailures(
          `Checking MCP server ${id} failed`,
          promotion.whenServing(checkOnce(id)),
        );
        // Looking for a waiting request and ending the entry are one
        // synchronous step. With a step between them, a request that came in
        // between would set "again" on an entry that is then deleted, and
        // that request would be lost.
        requestedAgain = yield* Effect.sync(() => {
          if (inFlight.get(id) === "again") {
            inFlight.set(id, "running");
            return true;
          }
          inFlight.delete(id);
          return false;
        });
      }
    }).pipe(Effect.onInterrupt(() => Effect.sync(() => void inFlight.delete(id))));

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
