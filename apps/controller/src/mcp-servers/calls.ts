/**
 * The calls the MCP Gateway makes to outside MCP servers: reading which
 * servers it may serve, calling one tool of one server, and ending the
 * upstream MCP sessions of a Session Token (spec 21 sections 3.5, 3.6, 3.10,
 * 5.1, 5.3 and 5.6).
 *
 * Upstream MCP sessions live in memory, one per Session Token and server, and
 * the first call that needs one opens it. A session is replaced when the
 * server's `revision` or its Connection's `credentialsGeneration` moved since
 * it opened. It is closed when its token ends, or, when something else
 * replaced it, once the calls that were using it have ended.
 *
 * A call is admitted by the promotion state, so a freeze waits for it, and a
 * call that arrives while the controller is not serving is refused at once.
 */
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as SqlClient from "effect/sql/SqlClient";
import { McpSchema, type McpClientError } from "effect/ai";
import { McpServerWarningReason } from "@hercule/protocol";
import { absorbFailures } from "../absorbing";
import {
  ConnectionTypes,
  type ConnectionCannotRefresh,
  type ConnectionCredentialsForUse,
  type ConnectionCredentialsUnavailable,
} from "../connections";
import { nowIso } from "../db";
import { Notifier } from "../notifications";
import { PluginHost, type RegisteredMcpServer } from "../plugins";
import { PromotionState } from "../promotion";
import { mcpServerRepository, type StoredMcpServer, type StoredMcpTool } from "./repository";
import {
  buildFailureEdit,
  judgeDependencies,
  readDependencies,
  readServerWhileBasisHolds,
  writeServerState,
  type StateBasis,
} from "./state";
import {
  CurrentUpstreamCallTrace,
  openUpstream,
  UpstreamError,
  type OpenedUpstream,
  type UpstreamCallTrace,
} from "./upstream";

/**
 * A call through the gateway did not reach the server, or got no answer from
 * it. `reason` says why, in the words a client maps to a button. `message` is
 * one fixed line the agent can act on, and never holds what the server or the
 * provider sent. `controllerNotServing` is set when the call was refused
 * because the controller is frozen or sealed: then `message` is the
 * promotion gate's own text.
 */
export class McpCallRefused extends Schema.TaggedError<McpCallRefused>()("McpCallRefused", {
  reason: McpServerWarningReason,
  message: Schema.String,
  controllerNotServing: Schema.optionalKey(Schema.Boolean),
}) {}

/**
 * A server as the gateway serves it: its record with the full tool
 * definitions, and whether it may be served now. `servable` is true when the
 * server is switched on, has a stored tool list (`checkedAt` is set), its
 * plugin is active, and its Connection exists and is not switched off. A server
 * that is servable but not `ready` is still served: its calls are refused with
 * its status (spec 21 section 3.3).
 */
export interface ServedMcpServer {
  readonly server: StoredMcpServer;
  readonly servable: boolean;
}

/** What `callTool` takes. */
export interface McpToolCall {
  /** The hash of the caller's Session Token: one upstream MCP session per scope and server. */
  readonly upstreamScope: string;
  readonly serverId: string;
  /** The tool's original name, as the server lists it. */
  readonly tool: string;
  readonly arguments: Readonly<Record<string, unknown>> | undefined;
  /**
   * Runs immediately before the call's request is sent upstream, the first
   * time and every time it is sent again. When it fails, nothing more is
   * sent, and `callTool` fails with that refusal.
   */
  readonly authorize: Effect.Effect<void, McpCallRefused>;
}

/** How long a whole call may take: opening the upstream session, the refresh, the retry and the tool. */
export const McpCallDeadline = Context.Reference<Duration.Duration>(
  "hercule/controller/mcp-servers/McpCallDeadline",
  { defaultValue: () => Duration.seconds(60) },
);

/** The answer to the agent when the server answers a call with HTTP 403. */
const FORBIDDEN_ANSWER = "the server refused this call (HTTP 403)";

/** The answer to the agent when the server's answer was over the size cap. */
const TOO_LARGE_ANSWER = "the answer was larger than 4 MiB";

/**
 * One upstream MCP session of a Session Token to a server, from the moment a
 * call decides to open it. It is the handle calls hold, so a call that finds
 * the session expired replaces only the one it used, and never a newer one.
 */
interface UpstreamSlot {
  readonly upstreamScope: string;
  readonly serverId: string;
  /** The server's `revision` when the slot was made. */
  readonly serverRevision: number;
  /** The Connection's `credentialsGeneration` when the slot was made. */
  readonly credentialsGeneration: number;
  /** Ends with the open session, or the reason it could not be opened. */
  readonly opening: Deferred.Deferred<OpenedUpstream, UpstreamError>;
  readonly scope: Scope.Closeable;
  /** How many calls hold the slot, from before they wait for it to open until they end. */
  users: number;
  /** The session opened. */
  opened: boolean;
  /** The slot is no longer the one new calls use. */
  removed: boolean;
  /** The session is closed whatever still uses it: its Session Token ended. */
  forced: boolean;
  closed: boolean;
}

/**
 * Converts a tool definition the controller stored into the client's `Tool`.
 * Fails when the stored definition does not fit it.
 */
const decodeTool = (stored: StoredMcpTool) => Schema.decodeUnknownEffect(McpSchema.Tool)(stored);

/** A call found its upstream MCP session expired: the server answered 404 for it, so the call did not run. */
interface SessionExpired {
  readonly _tag: "SessionExpired";
}

/** A call lost its upstream MCP session because the session was closed under it. */
interface CutOff {
  readonly _tag: "CutOff";
}

type AttemptFailure = McpCallRefused | UpstreamError | SessionExpired | CutOff;

/** Builds the answer to the agent for a call whose server or tool failed it. */
const buildErrorResult = (text: string): McpSchema.CallToolResult =>
  new McpSchema.CallToolResult({ content: [{ type: "text", text }], isError: true });

/** Returns the line the agent reads for a refused call of the server named `name`. */
const describeRefusal = (reason: McpServerWarningReason, name: string): string => {
  switch (reason) {
    case "switched-off":
      return `${name} is switched off. Ask the user to switch it on in Settings.`;
    case "checking":
      return `${name} is still being checked. Try again in a minute.`;
    case "needs-sign-in":
      return `${name} needs sign-in. Ask the user to reconnect it in Settings > Connections.`;
    case "unreachable":
      return `${name} could not be reached. Try again later.`;
    case "timed-out":
      return `${name} did not answer in time. Try again later.`;
    default:
      return `${name} has an error. Ask the user to open it in Settings and check it.`;
  }
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const servers = yield* mcpServerRepository;
  const connectionTypes = yield* ConnectionTypes;
  const plugins = yield* PluginHost;
  const promotion = yield* PromotionState;
  const notifier = yield* Notifier;
  const httpClient = yield* HttpClient.HttpClient;
  const serviceScope = yield* Effect.scope;

  const readDependenciesOf = (server: StoredMcpServer) =>
    readDependencies(server).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.provideService(PluginHost, plugins),
    );

  const readServedServers = (ids: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const served: Array<ServedMcpServer> = [];
      for (const id of ids) {
        const found = yield* servers.readById(id);
        if (Option.isNone(found)) continue;
        const server = found.value;
        const { plugin, connection } = yield* readDependenciesOf(server);
        served.push({
          server,
          servable:
            server.enabled &&
            server.checkedAt !== null &&
            plugin._tag === "active" &&
            connection !== undefined &&
            connection.status !== "disabled",
        });
      }
      return served;
    });

  // The upstream MCP sessions: Session Token hash, then server id.
  const slots = new Map<string, Map<string, UpstreamSlot>>();

  const forgetSlot = (slot: UpstreamSlot): void => {
    slot.removed = true;
    const byServer = slots.get(slot.upstreamScope);
    if (byServer?.get(slot.serverId) !== slot) return;
    byServer.delete(slot.serverId);
    if (byServer.size === 0) slots.delete(slot.upstreamScope);
  };

  /**
   * Closes the slot's session when it is open, no longer the one new calls
   * use, and nothing still uses it, or when it is forced shut. Its DELETE is
   * best effort, and only sent while the controller is serving.
   */
  const closeWhenDone = (slot: UpstreamSlot): Effect.Effect<void> =>
    Effect.suspend(() => {
      const done = slot.removed && (slot.users === 0 || slot.forced);
      if (slot.closed || !slot.opened || !done) return Effect.void;
      slot.closed = true;
      return Scope.close(slot.scope, Exit.void);
    });

  /** Opens the slot's session and ends `opening` with the outcome. */
  const openSlot = (
    slot: UpstreamSlot,
    contribution: RegisteredMcpServer,
    credentials: ConnectionCredentialsForUse,
    firstRevision: string | null,
  ) =>
    openUpstream({ contribution, credentials, firstRevision }).pipe(
      Effect.provideService(Scope.Scope, slot.scope),
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.provideService(PromotionState, promotion),
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          if (Exit.isSuccess(exit)) {
            slot.opened = true;
            // A token that ended while the session opened loses the race: the
            // session is closed now, and its waiting calls are cut off.
            yield* closeWhenDone(slot);
          } else {
            forgetSlot(slot);
            yield* Scope.close(slot.scope, Exit.void);
          }
          yield* Deferred.done(slot.opening, exit);
        }),
      ),
    );

  /**
   * Takes hold of the session for this token and server, and starts opening
   * it when there is none. A session made for an older `revision` of the
   * server, or an older `credentialsGeneration` of its Connection, is
   * replaced. Call `releaseSlot` when the call is done with it.
   */
  const holdSlot = (
    upstreamScope: string,
    server: StoredMcpServer,
    credentialsGeneration: number,
    contribution: RegisteredMcpServer,
    credentials: ConnectionCredentialsForUse,
  ): Effect.Effect<UpstreamSlot> =>
    Effect.gen(function* () {
      const existing = slots.get(upstreamScope)?.get(server.id);
      const usable =
        existing !== undefined &&
        existing.serverRevision === server.revision &&
        existing.credentialsGeneration === credentialsGeneration;
      if (usable) {
        existing.users += 1;
        return existing;
      }
      // Nothing up to the registration below waits, so no other call can take
      // the place in the map between the check and the change.
      if (existing !== undefined) forgetSlot(existing);
      const slot: UpstreamSlot = {
        upstreamScope,
        serverId: server.id,
        serverRevision: server.revision,
        credentialsGeneration,
        opening: Deferred.makeUnsafe(),
        scope: Scope.makeUnsafe(),
        users: 1,
        opened: false,
        removed: false,
        forced: false,
        closed: false,
      };
      const byServer = slots.get(upstreamScope) ?? new Map<string, UpstreamSlot>();
      byServer.set(server.id, slot);
      slots.set(upstreamScope, byServer);
      // The old session ends without holding up this call.
      if (existing !== undefined) yield* Effect.forkIn(closeWhenDone(existing), serviceScope);
      yield* Effect.forkIn(
        openSlot(slot, contribution, credentials, server.protocolVersion),
        serviceScope,
      );
      return slot;
    });

  const releaseSlot = (slot: UpstreamSlot): Effect.Effect<void> =>
    Effect.suspend(() => {
      slot.users -= 1;
      return closeWhenDone(slot);
    });

  const closeUpstreamScope = (upstreamScope: string): Effect.Effect<void> =>
    Effect.suspend(() => {
      const byServer = slots.get(upstreamScope);
      slots.delete(upstreamScope);
      const ended = [...(byServer?.values() ?? [])];
      for (const slot of ended) {
        slot.removed = true;
        slot.forced = true;
      }
      return Effect.forEach(ended, closeWhenDone, { concurrency: "unbounded", discard: true });
    });

  yield* Effect.addFinalizer(() =>
    Effect.forEach([...slots.keys()], closeUpstreamScope, { discard: true }),
  );

  /** Writes a failure that is about the whole server as its status, unless something newer happened. */
  const writeFailure = (
    server: StoredMcpServer,
    basis: StateBasis,
    status: "unreachable" | "error",
    detail: string,
  ): Effect.Effect<void> =>
    absorbFailures(
      `Writing the status of MCP server ${server.id} after a call failed`,
      Effect.gen(function* () {
        const at = yield* nowIso;
        yield* writeServerState(
          server.id,
          basis,
          buildFailureEdit(server, { status, detail }, at),
          at,
        );
      }).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.provideService(Notifier, notifier),
        Effect.provideService(PluginHost, plugins),
      ),
    );

  /**
   * Runs one call to the end: checks the server, takes the upstream session,
   * sends the call, and when the server answers 401 refreshes the Connection's
   * credentials and sends it once more.
   */
  const runCall = (input: McpToolCall): Effect.Effect<McpSchema.CallToolResult, McpCallRefused> =>
    Effect.gen(function* () {
      const refuse = (reason: McpServerWarningReason, name: string, message?: string) =>
        Effect.fail(
          new McpCallRefused({ reason, message: message ?? describeRefusal(reason, name) }),
        );

      const found = yield* servers.readById(input.serverId);
      if (Option.isNone(found)) {
        return yield* refuse("error", "This server", "This MCP server no longer exists.");
      }
      const server = found.value;
      const name = server.name;
      const dependencies = yield* readDependenciesOf(server);
      const basis: StateBasis = { revision: server.revision, dependencies };

      if (!server.enabled) return yield* refuse("switched-off", name);
      const judged = judgeDependencies(dependencies);
      if (judged._tag === "unusable") {
        return judged.status === "needs-sign-in"
          ? yield* refuse("needs-sign-in", name)
          : yield* refuse("error", name, `${name} is not available: ${judged.detail}.`);
      }
      const { contribution, connection } = judged;
      // Checked at use, because the credentials of a Connection of another
      // type would go to this server's origin.
      if (connection.type !== contribution.connectionType) {
        return yield* refuse("error", name);
      }
      if (server.checkedAt === null || server.status === "checking") {
        return yield* refuse("checking", name);
      }
      if (server.status !== "ready") return yield* refuse(server.status, name);

      const stored = server.tools.find((tool) => tool.name === input.tool);
      if (stored === undefined) {
        return yield* refuse("error", name, "The server does not list this tool.");
      }
      const tool = yield* decodeTool(stored).pipe(
        Effect.mapError(
          () =>
            new McpCallRefused({
              reason: "error",
              message: describeRefusal("error", name),
            }),
        ),
      );

      const describeUnavailable = (error: ConnectionCredentialsUnavailable): McpCallRefused => {
        switch (error.reason) {
          case "needs-sign-in":
            return new McpCallRefused({
              reason: "needs-sign-in",
              message: describeRefusal("needs-sign-in", name),
            });
          case "unreachable":
          case "credentials-replaced":
            return new McpCallRefused({
              reason: "unreachable",
              message: describeRefusal("unreachable", name),
            });
          default:
            return new McpCallRefused({
              reason: "error",
              message: describeRefusal("error", name),
            });
        }
      };

      let credentials = yield* connectionTypes
        .readCredentialsForUse(server.connectionId)
        .pipe(Effect.mapError(describeUnavailable));

      /**
       * Decides what a failure of the call means. A tool's own answer, a
       * JSON-RPC error or HTTP 403, is returned to the agent as a result.
       */
      const decideFailure = (
        slot: UpstreamSlot,
        opened: OpenedUpstream,
        error: McpClientError.McpClientError,
        trace: UpstreamCallTrace,
      ): Effect.Effect<McpSchema.CallToolResult, UpstreamError | SessionExpired | CutOff> => {
        const reason = error.reason;
        if (slot.forced) return Effect.fail({ _tag: "CutOff" });
        if (reason._tag === "ClosedError" && reason.sessionExpired === true) {
          // Nothing else may use this session; the next call opens a new one.
          forgetSlot(slot);
          return Effect.fail({ _tag: "SessionExpired" });
        }
        // The server's own error for this call. A failure of the client
        // itself has no code.
        if (reason._tag === "ProtocolError" && reason.code !== undefined) {
          return Effect.succeed(
            buildErrorResult(reason.description ?? "The server answered the call with an error."),
          );
        }
        if (reason._tag === "HttpError" && reason.status === 403) {
          return Effect.succeed(buildErrorResult(FORBIDDEN_ANSWER));
        }
        return Effect.fail(opened.describeFailure(error, trace.sentIdentity));
      };

      /** Sends the call once, on the upstream MCP session of this token. */
      const attempt = (): Effect.Effect<McpSchema.CallToolResult, AttemptFailure> =>
        Effect.acquireUseRelease(
          holdSlot(
            input.upstreamScope,
            server,
            connection.credentialsGeneration,
            contribution,
            credentials,
          ),
          (slot) =>
            Effect.gen(function* () {
              const opened = yield* Deferred.await(slot.opening);
              opened.setCredentials(credentials);
              yield* input.authorize;
              const trace: UpstreamCallTrace = { sentIdentity: undefined };
              return yield* opened.client
                .callTool({
                  tool,
                  ...(input.arguments === undefined ? {} : { arguments: input.arguments }),
                })
                .pipe(
                  Effect.provideService(CurrentUpstreamCallTrace, trace),
                  Effect.catch((error) => decideFailure(slot, opened, error, trace)),
                );
            }),
          releaseSlot,
        );

      /** Refuses the call, and writes the status when the failure is about the whole server. */
      const refuseUpstreamFailure = (failure: UpstreamError) =>
        Effect.gen(function* () {
          switch (failure.reason) {
            case "unreachable":
              yield* writeFailure(server, basis, "unreachable", failure.message);
              return yield* refuse("unreachable", name);
            case "timeout":
              return yield* refuse("timed-out", name);
            case "too-large":
              return yield* refuse("error", name, `${name}: ${TOO_LARGE_ANSWER}.`);
            case "unauthorized":
              yield* writeFailure(
                server,
                basis,
                "error",
                `${contribution.displayName}'s MCP server refused the Connection's token`,
              );
              return yield* refuse("error", name);
            default:
              yield* writeFailure(server, basis, "error", failure.message);
              return yield* refuse("error", name);
          }
        });

      /**
       * Asks the Connection for credentials after the server refused the ones
       * the call sent, and returns them. Refuses the call when it cannot.
       * Nothing is refreshed for a server that was switched off or whose
       * destination changed since the call began.
       */
      const refreshAfterRejection = (failure: UpstreamError) =>
        Effect.gen(function* () {
          const current = yield* readServerWhileBasisHolds(server.id, basis).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.provideService(PluginHost, plugins),
          );
          if (Option.isNone(current)) {
            const now = yield* servers.readById(server.id);
            return Option.isSome(now) && !now.value.enabled
              ? yield* refuse("switched-off", name)
              : yield* refuse(
                  "error",
                  name,
                  `${name} was changed while the call ran. Try the call again.`,
                );
          }
          const refreshed = yield* Effect.result(
            connectionTypes.refreshAfterRejection(
              server.connectionId,
              failure.sentIdentity ?? credentials.identity,
            ),
          );
          if (refreshed._tag === "Success") return refreshed.success;
          const error: ConnectionCredentialsUnavailable | ConnectionCannotRefresh =
            refreshed.failure;
          if (error._tag === "ConnectionCannotRefresh") {
            return yield* refuseUpstreamFailure(failure);
          }
          return yield* Effect.fail(describeUnavailable(error));
        });

      let refreshed = false;
      let replaced = false;
      while (true) {
        const outcome = yield* Effect.result(attempt());
        if (outcome._tag === "Success") return outcome.success;
        const failure = outcome.failure;
        switch (failure._tag) {
          case "McpCallRefused":
            return yield* Effect.fail(failure);
          case "CutOff":
            return yield* refuse(
              "error",
              name,
              `${name} was changed or its session ended while the call ran. Try the call again.`,
            );
          case "SessionExpired":
            if (!replaced) {
              replaced = true;
              continue;
            }
            return yield* refuseUpstreamFailure(
              new UpstreamError({
                reason: "protocol",
                message: "The server ended the MCP session",
              }),
            );
          case "UpstreamError":
            if (failure.reason === "unauthorized" && !refreshed) {
              refreshed = true;
              credentials = yield* refreshAfterRejection(failure);
              continue;
            }
            return yield* refuseUpstreamFailure(failure);
        }
      }
    }).pipe(
      Effect.catchTag("SqlError", () =>
        Effect.fail(
          new McpCallRefused({
            reason: "error",
            message: "Hercule could not read its own database. Try the call again.",
          }),
        ),
      ),
    );

  const buildNotServingRefusal = (message: string): McpCallRefused =>
    new McpCallRefused({ reason: "error", message, controllerNotServing: true });

  const callTool = (input: McpToolCall): Effect.Effect<McpSchema.CallToolResult, McpCallRefused> =>
    Effect.flatMap(McpCallDeadline, (deadline) => {
      const bounded: Effect.Effect<McpSchema.CallToolResult, McpCallRefused> = Effect.flatMap(
        Effect.timeoutOption(runCall(input), deadline),
        Option.match({
          onNone: () =>
            Effect.fail(
              new McpCallRefused({
                reason: "timed-out",
                message: "The call took too long. Try again later.",
              }),
            ),
          onSome: Effect.succeed,
        }),
      );
      return promotion
        .admit(bounded)
        .pipe(
          Effect.catch((error) =>
            error instanceof McpCallRefused
              ? Effect.fail(error)
              : Effect.fail(buildNotServingRefusal(error.error.message)),
          ),
        );
    });

  return { readServedServers, callTool, closeUpstreamScope };
});

/** The calls of the MCP Gateway to outside MCP servers. */
export class McpServerCalls extends Context.Service<McpServerCalls, Effect.Success<typeof make>>()(
  "hercule/controller/mcp-servers/McpServerCalls",
) {}

/** The MCP Server calls, reaching outside servers through `fetch`. */
export const McpServerCallsLayer: Layer.Layer<
  McpServerCalls,
  never,
  SqlClient.SqlClient | ConnectionTypes | PluginHost | PromotionState | Notifier
> = Layer.effect(McpServerCalls)(make).pipe(Layer.provide(FetchHttpClient.layer));
