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
import { ConnectionTypes, type RefreshGuard } from "../connections";
import { nowIso } from "../db";
import type { Notifier } from "../notifications";
import type { PluginHost } from "../plugins";
import { PromotionState } from "../promotion";
import type { Secrets } from "../secrets";
import { resolveServerAccess, type UpstreamCredentials, type UpstreamEndpoint } from "./access";
import type { McpServerDependencies } from "./catalogue";
import type { McpServerEdit, StoredMcpServer, StoredMcpTool } from "./repository";
import { mcpServerRepository } from "./repository";
import { mcpServerSignIns } from "./sign-ins";
import { buildFailureEdit, DAILY_CHECK_MILLIS, mcpServerState } from "./state";
import {
  buildStatusFromFailure,
  MAX_TOOL_DEFINITIONS_BYTES,
  openUpstream,
  runWithCredentials,
  toStoredTool,
  TOOL_LIST_TOO_LARGE,
  UPSTREAM_WORK_DEADLINE,
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

/**
 * How long a whole check may take: opening the upstream MCP session, the
 * refresh, the retry and the listing. It is `UPSTREAM_WORK_DEADLINE` and
 * ends before a freeze gives up waiting for running work, so a server that
 * hangs during a check never fails a freeze. Tests set a shorter one.
 */
export const McpServerCheckDeadline = Context.Reference<Duration.Duration>(
  "hercule/controller/mcp-servers/McpServerCheckDeadline",
  { defaultValue: (): Duration.Duration => UPSTREAM_WORK_DEADLINE },
);

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
      /** What a server added by URL said it accepts when it refused the request, when it did. */
      readonly signInOffered: "oauth" | "token" | null;
    };

/** What a check fails with when the server changed after the check started, so its outcome is dropped. */
const CHECK_SUPERSEDED = { _tag: "CheckSuperseded" } as const;

const buildFailedResult = (
  status: "unreachable" | "error" | "needs-sign-in",
  detail: string,
  cause: "plugin" | "connection" | null = null,
  signInOffered: "oauth" | "token" | null = null,
): CheckResult => ({ _tag: "failed", status, detail, cause, signInOffered });

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
): McpServerEdit =>
  result._tag === "ready"
    ? {
        status: "ready",
        statusDetail: null,
        statusCause: null,
        tools: result.tools,
        checkedAt: at,
        protocolVersion: result.revision,
        failedChecks: 0,
        nextCheckAt: new Date(Date.parse(at) + DAILY_CHECK_MILLIS).toISOString(),
      }
    : buildFailureEdit(server, result, at, worked.current ?? undefined);

const make = Effect.gen(function* () {
  const servers = yield* mcpServerRepository;
  const state = yield* mcpServerState;
  const connectionTypes = yield* ConnectionTypes;
  const signIns = yield* mcpServerSignIns;
  const promotion = yield* PromotionState;
  const httpClient = yield* HttpClient.HttpClient;

  /**
   * Lists the tools once, on a short-lived client of its own, and fails with
   * an `UpstreamError` when the listing takes longer than `deadline`. Records
   * the revision whose handshake worked in `worked`, before it lists, so the
   * revision is known when the listing fails.
   */
  const listTools = (
    endpoint: UpstreamEndpoint,
    credentials: UpstreamCredentials,
    worked: WorkedRevision,
    firstRevision: string | null,
    deadline: Duration.Duration,
  ): Effect.Effect<
    { readonly tools: ReadonlyArray<McpSchema.Tool>; readonly revision: string },
    UpstreamError
  > =>
    Effect.scoped(
      Effect.gen(function* () {
        const opened = yield* openUpstream({ endpoint, credentials, firstRevision });
        worked.current = opened.revision;
        return { tools: yield* opened.listTools(deadline), revision: opened.revision };
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
   * credentials, so it starts only if the server, its revision and what it
   * depends on are still as the check found them. That is checked before the
   * refresh after a rejection, and again under the Connection's refresh
   * permit, right before every request to the provider, because the check may
   * wait a long time for the permit. Otherwise the outcome is `discarded`, and
   * the credentials are left alone.
   *
   * The whole evaluation is bound by `McpServerCheckDeadline`. A check that
   * is still running then ends `unreachable`, like any server that does not
   * answer in time. A refresh that has started still runs to its own end.
   */
  const evaluate = (
    server: StoredMcpServer,
    dependencies: McpServerDependencies,
    worked: WorkedRevision,
  ): Effect.Effect<CheckResult, SqlError> =>
    Effect.gen(function* () {
      // Resolved here, at use, because the check is about to send.
      const access = resolveServerAccess({ server, dependencies }, connectionTypes, signIns);
      if (access._tag === "unusable") {
        return buildFailedResult(access.status, access.detail, access.cause);
      }
      const deadline = yield* McpServerCheckDeadline;

      const checkBasisHolds = Effect.flatMap(
        state.readServerWhileBasisHolds(server.id, { revision: server.revision, dependencies }),
        Option.match({ onNone: () => Effect.fail(CHECK_SUPERSEDED), onSome: () => Effect.void }),
      );
      const guardRefresh: RefreshGuard<typeof CHECK_SUPERSEDED> = checkBasisHolds.pipe(
        Effect.catchTag("SqlError", Effect.die),
      );

      return yield* runWithCredentials({
        credentials: access.credentials,
        // The retry after a refresh starts with the revision that worked.
        action: (credentials) =>
          listTools(
            access.endpoint,
            credentials,
            worked,
            worked.current ?? server.protocolVersion,
            deadline,
          ),
        checkRefreshAllowed: checkBasisHolds,
        guardRefresh,
      }).pipe(
        Effect.timeoutOption(deadline),
        Effect.map(
          Option.match({
            onNone: (): CheckResult =>
              buildFailedResult("unreachable", "The server did not answer in time"),
            onSome: ({ tools, revision }): CheckResult => {
              const stored = tools.map(toStoredTool);
              // The listing stops early when the server's definitions pass the
              // limit (`limitToolListing`). The list is measured again here,
              // as it is stored, because removing credentials from it can make
              // it longer.
              return new TextEncoder().encode(JSON.stringify(stored)).length >
                MAX_TOOL_DEFINITIONS_BYTES
                ? buildFailedResult("error", TOOL_LIST_TOO_LARGE)
                : { _tag: "ready", tools: stored, revision };
            },
          }),
        ),
        Effect.catchTags({
          UpstreamError: (failure) => {
            const { status, detail, signInOffered } = buildStatusFromFailure(
              failure,
              access.credentials,
            );
            return Effect.succeed(buildFailedResult(status, detail, null, signInOffered));
          },
          ServerCredentialsUnavailable: ({ status, detail, cause }) =>
            Effect.succeed(buildFailedResult(status, detail, cause)),
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
  SqlClient.SqlClient | ConnectionTypes | PluginHost | PromotionState | Notifier | Secrets
> = Layer.effect(McpServerChecks)(make).pipe(Layer.provide(FetchHttpClient.layer));
