/**
 * The check of an MCP Server: it lists the server's tools from the outside
 * server and writes the outcome as the server's status (spec 21 sections 5.1,
 * 5.3 and 5.4).
 *
 * What is due is written in the database, in the server's `next_check_at`.
 * Whatever wants a check writes that and then wakes the loop. The loop reads
 * the due servers and starts a check for each one that has none running, so
 * at most one check runs per server. When a check ends the loop looks again,
 * because a request that came while it ran may be about something the check
 * had already read. The loop also looks once in a while by itself, which
 * finds the work no wake announced: the daily check, and a wake lost to a
 * restart.
 *
 * A check is background work admitted by the promotion state: it does not
 * start while the controller is frozen or sealed, and a freeze waits for it to
 * end. So a check never waits on a freeze while it talks to the outside
 * server, and a freeze never turns into an `unreachable` status.
 */
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
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
import type { Notifier } from "../notifications";
import type { PluginHost, RegisteredMcpServer } from "../plugins";
import { PromotionState } from "../promotion";
import { judgeDependencies, type McpServerDependencies } from "./catalogue";
import { removeCredentialValues } from "./credential-values";
import type { McpServerEdit, StoredMcpServer, StoredMcpTool } from "./repository";
import { mcpServerRepository } from "./repository";
import { computeBackoffMillis, DAILY_CHECK_MILLIS, mcpServerState } from "./state";
import {
  buildStatusFromFailure,
  MAX_UPSTREAM_MESSAGE_BYTES,
  openUpstream,
  runWithCredentials,
  type UpstreamError,
} from "./upstream";

/**
 * Runs the checks of MCP Servers: a check lists a server's tools from the
 * outside server. The MCP Server service calls `wake` after the commit of a
 * create, a switch on, or a "check now", and the Connection follower after a
 * reconnect.
 */
export class McpServerChecks extends Context.Service<
  McpServerChecks,
  {
    /**
     * Makes the loop look for due checks now, and returns at once. Call it
     * after the commit that marked a server due, never inside the
     * transaction. Wakes that come close together make one look.
     */
    readonly wake: Effect.Effect<void>;
    /**
     * Runs the loop for as long as its fiber lives, and never returns. It
     * looks for due servers at once, after every `wake`, after every check
     * that ended without a failure of the database, and after `backstop` has
     * passed with none of these. A check's result is written to the server
     * and announced on the `mcpServer` live topic. A check that cannot run
     * sets the server's status instead. A check that fails because the
     * database does is logged, and tried again at the next look.
     */
    readonly run: (backstop: Duration.Duration) => Effect.Effect<never>;
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

/** What a check fails with when the server changed after the check started, so its outcome is dropped. */
const CHECK_SUPERSEDED = { _tag: "CheckSuperseded" } as const;

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
 * and resets the schedule to a day. A server that cannot be reached backs off
 * (spec 21 section 5.3). Any other failure waits a day. A failure also stores
 * the revision whose handshake worked, when one did.
 */
const buildEdit = (
  server: StoredMcpServer,
  result: Exclude<CheckResult, { readonly _tag: "discarded" }>,
  at: string,
  worked: WorkedRevision,
): McpServerEdit => {
  const atMillis = Date.parse(at);
  const revisionEdit = worked.current === null ? {} : { protocolVersion: worked.current };
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
      ...revisionEdit,
    };
  }
  return {
    status: result.status,
    statusDetail: result.detail,
    statusCause: result.cause,
    failedChecks: 0,
    nextCheckAt: planAfter(DAILY_CHECK_MILLIS),
    ...revisionEdit,
  };
};

const make = Effect.gen(function* () {
  const servers = yield* mcpServerRepository;
  const state = yield* mcpServerState;
  const connectionTypes = yield* ConnectionTypes;
  const promotion = yield* PromotionState;
  const httpClient = yield* HttpClient.HttpClient;

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
      case "not-serving":
      case "refused":
        // Only a caller that gives the refresh a guard gets these two, and a
        // check gives none.
        return buildFailedResult("error", "The refresh of the sign-in was refused");
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
        // A server that echoes what it received, in a tool's description or
        // schema, must not hand the Connection's token on to the harness.
        // A tool whose name holds a credential value is left out instead: the
        // name is what a call sends back to the server, so rewriting it would
        // dispatch to another tool or to none.
        const kept = tools.filter(
          (tool) => removeCredentialValues(tool.name, opened.sentValues) === tool.name,
        );
        if (kept.length < tools.length) {
          yield* Effect.logWarning(
            `${contribution.displayName}'s MCP server listed ${String(tools.length - kept.length)} tool(s) whose name holds a credential value. They were left out of the stored list.`,
          );
        }
        return {
          tools: removeCredentialValues(kept, opened.sentValues),
          revision: opened.revision,
        };
      }),
    ).pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.provideService(PromotionState, promotion),
    );

  /**
   * Works out the outcome of one check from the dependencies read at its
   * start. Never fails except for the database: every other failure is an
   * outcome that becomes the server's status.
   *
   * When the server refuses the credentials, they are refreshed and the
   * listing is tried once more (`runWithCredentials`). A refresh changes the
   * Connection, so it starts only if the server, its revision and its
   * Connection are still as the check found them. Otherwise the outcome is
   * `discarded`, and the Connection is left alone.
   */
  const evaluate = (
    server: StoredMcpServer,
    dependencies: McpServerDependencies,
    worked: WorkedRevision,
  ): Effect.Effect<CheckResult, SqlError> =>
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

      return yield* runWithCredentials({
        connections: connectionTypes,
        connectionId: server.connectionId,
        // The retry after a refresh starts with the revision that worked.
        action: (credentials) =>
          listTools(contribution, credentials, worked, worked.current ?? server.protocolVersion),
        checkRefreshAllowed: Effect.flatMap(
          state.readServerWhileBasisHolds(server.id, { revision: server.revision, dependencies }),
          Option.match({ onNone: () => Effect.fail(CHECK_SUPERSEDED), onSome: () => Effect.void }),
        ),
      }).pipe(
        Effect.map(({ tools, revision }): CheckResult => {
          const stored = tools.map(toStoredTool);
          return new TextEncoder().encode(JSON.stringify(stored)).length >
            MAX_UPSTREAM_MESSAGE_BYTES
            ? buildFailedResult("error", "The server's tool list is larger than 4 MiB")
            : { _tag: "ready", tools: stored, revision };
        }),
        Effect.catchTags({
          UpstreamError: (failure) => {
            const { status, detail } = buildStatusFromFailure(failure, contribution.displayName);
            return Effect.succeed(buildFailedResult(status, detail));
          },
          ConnectionCredentialsUnavailable: (error) =>
            Effect.succeed(describeUnavailable(error, contribution, connection)),
          CheckSuperseded: () => Effect.succeed<CheckResult>({ _tag: "discarded" }),
        }),
      );
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
      const dependencies = yield* state.readDependencies(server);
      const worked: WorkedRevision = { current: null };
      const result = yield* evaluate(server, dependencies, worked);
      const at = yield* nowIso;
      const written =
        result._tag !== "discarded" &&
        (yield* state.writeCheckResult(
          id,
          { revision: server.revision, dependencies },
          buildEdit(server, result, at, worked),
          at,
        ));
      if (!written) yield* state.markDueWhenUsable(id, at);
    });

  const wakeup = Latch.makeUnsafe(false);
  // The servers with a check running. A server stays due until its check
  // writes the next time, so without this set every look would start it again.
  const checking = new Set<string>();

  /**
   * Checks one server, then frees it for the next look. A check that ended
   * without a failure wakes the loop, because a request that came while it
   * ran has left the server due. After a failure it does not: the server is
   * still due, and waking would check it again at once, for as long as the
   * failure lasts.
   */
  const checkAndRelease = (id: string): Effect.Effect<void> =>
    absorbFailures(
      `Checking MCP server ${id} failed`,
      Effect.onExit(promotion.whenServing(checkOnce(id)), (exit) =>
        Effect.sync(() => {
          checking.delete(id);
          if (Exit.isSuccess(exit)) wakeup.openUnsafe();
        }),
      ),
    );

  const startDueChecks = (scope: Scope.Scope): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      for (const server of yield* servers.listDueForCheck(yield* nowIso)) {
        if (checking.has(server.id)) continue;
        checking.add(server.id);
        yield* Effect.forkIn(checkAndRelease(server.id), scope);
      }
    });

  return McpServerChecks.of({
    wake: Effect.asVoid(wakeup.open),
    run: (backstop) =>
      Effect.scoped(
        Effect.gen(function* () {
          const scope = yield* Effect.scope;
          while (true) {
            yield* absorbFailures(
              "Looking for the MCP server checks that are due failed",
              promotion.whenServing(startDueChecks(scope)),
            );
            // The latch closes before the next look, so a wake that comes
            // after the close opens it again and is never lost.
            yield* wakeup.await.pipe(Effect.timeoutOption(backstop), Effect.andThen(wakeup.close));
          }
        }),
      ),
  });
});

/** The MCP Server checks, reaching outside servers through `fetch`. */
export const McpServerChecksLayer: Layer.Layer<
  McpServerChecks,
  never,
  SqlClient.SqlClient | ConnectionTypes | PluginHost | PromotionState | Notifier
> = Layer.effect(McpServerChecks)(make).pipe(Layer.provide(FetchHttpClient.layer));
