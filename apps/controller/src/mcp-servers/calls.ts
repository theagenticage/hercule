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
 * replaced it, once the calls that were using it have ended. A committed
 * change that takes a server's destination away (the server is deleted or
 * switched off, or its `revision` or its Connection's `credentialsGeneration`
 * moved) closes that server's sessions the same way, and an opening that
 * nothing waits for any more is cancelled.
 *
 * A call is admitted by the promotion state, so a freeze waits for it, and a
 * call that arrives while the controller is not serving is refused at once.
 * Admitted or not, a call checks before every request it makes to outside the
 * controller (the opening of a session, a refresh of the Connection's
 * credentials, the tool's request, and every request sent again) that the
 * controller is still serving, that the caller may still make the call
 * (`McpToolCall.authorize`), and that the server and the tool are still there
 * as the call found them. A request that only continues an exchange that
 * already went out is not stopped.
 */
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { McpSchema, type McpClientError } from "effect/ai";
import { McpServerWarningReason } from "@hercule/protocol";
import { absorbFailures } from "../absorbing";
import {
  ConnectionTypes,
  type ConnectionCannotRefresh,
  type ConnectionCredentialsForUse,
  type ConnectionCredentialsUnavailable,
  type StoredConnection,
} from "../connections";
import { nowIso, RecordChanges } from "../db";
import { Notifier } from "../notifications";
import { PluginHost, type RegisteredMcpServer } from "../plugins";
import { PromotionState } from "../promotion";
import { removeCredentialValues } from "./credential-values";
import { mcpServerRepository, type StoredMcpServer, type StoredMcpTool } from "./repository";
import {
  buildFailureEdit,
  isSameDependencies,
  judgeDependencies,
  readDependencies,
  writeServerState,
  type McpServerDependencies,
  type StateBasis,
} from "./state";
import {
  createUpstreamCallState,
  CurrentUpstreamCall,
  openUpstream,
  UpstreamError,
  type OpenedUpstream,
  type UpstreamCallState,
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
   * Runs immediately before every request the call makes to outside the
   * controller: the opening of the upstream session, a refresh of the
   * Connection's credentials, the tool's request, and each request sent
   * again. When it fails, nothing more is sent, and `callTool` fails with
   * that refusal. It sits beside the catalogue's own check that the server
   * and the tool are still there, at the same points.
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
  /** The Connection the server used when the slot was made. */
  readonly connectionId: string;
  /** The server's `revision` when the slot was made. */
  readonly serverRevision: number;
  /** The Connection's `credentialsGeneration` when the slot was made. */
  readonly credentialsGeneration: number;
  /**
   * Ends with the open session, or the reason it could not be opened:
   * `CutOff` when the opening was cancelled.
   */
  readonly opening: Deferred.Deferred<OpenedUpstream, UpstreamError | CutOff>;
  /** Completing it cancels an opening that has not ended. */
  readonly cancelOpening: Deferred.Deferred<void>;
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

/**
 * A call found its upstream MCP session expired, and the call did not run:
 * either the server answered 404 to the tool's own request, or the session was
 * already known to be gone and the request was never sent.
 */
interface SessionExpired {
  readonly _tag: "SessionExpired";
}

/** A call lost its upstream MCP session because the session was closed under it. */
interface CutOff {
  readonly _tag: "CutOff";
}

/**
 * A call's tool request went out and may have run, and then the exchange
 * failed in a way that must not send the tool again: a 401 or an ended MCP
 * session on the reply to a request of the server, not on the tool's own
 * request.
 */
interface ExchangeBroken {
  readonly _tag: "ExchangeBroken";
}

type AttemptFailure = McpCallRefused | UpstreamError | SessionExpired | CutOff | ExchangeBroken;

/** What a call needs to know about the server it goes to, as the database holds it now. */
interface Destination {
  readonly server: StoredMcpServer;
  readonly dependencies: McpServerDependencies;
  readonly contribution: RegisteredMcpServer;
  readonly connection: StoredConnection;
  /** The tool's definition as it is stored now. */
  readonly tool: McpSchema.Tool;
}

const CUT_OFF: CutOff = { _tag: "CutOff" };

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
  const recordChanges = yield* RecordChanges;
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

  // The calls that run, by Session Token hash. Completing a call's `Deferred`
  // ends that call, so a token that ends also ends a call that holds no
  // session yet.
  const runningCalls = new Map<string, Set<Deferred.Deferred<void>>>();

  const forgetSlot = (slot: UpstreamSlot): void => {
    slot.removed = true;
    const byServer = slots.get(slot.upstreamScope);
    if (byServer?.get(slot.serverId) !== slot) return;
    byServer.delete(slot.serverId);
    if (byServer.size === 0) slots.delete(slot.upstreamScope);
  };

  /**
   * Ends the slot's session when it is no longer the one new calls use and
   * nothing still uses it, or when it is forced shut. An open session is
   * closed, and its DELETE is best effort, only sent while the controller is
   * serving. A session that is still opening is cancelled, and the opening's
   * own exit closes it.
   */
  const closeWhenDone = (slot: UpstreamSlot): Effect.Effect<void> =>
    Effect.suspend(() => {
      const done = slot.removed && (slot.users === 0 || slot.forced);
      if (slot.closed || !done) return Effect.void;
      if (!slot.opened) return Effect.asVoid(Deferred.succeed(slot.cancelOpening, undefined));
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
    openUpstream({ contribution, credentials, firstRevision, refuseWhenNotServing: true }).pipe(
      Effect.provideService(Scope.Scope, slot.scope),
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.provideService(PromotionState, promotion),
      Effect.raceFirst(Effect.andThen(Deferred.await(slot.cancelOpening), Effect.fail(CUT_OFF))),
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
        connectionId: server.connectionId,
        serverRevision: server.revision,
        credentialsGeneration,
        opening: Deferred.makeUnsafe(),
        cancelOpening: Deferred.makeUnsafe(),
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
      for (const running of runningCalls.get(upstreamScope) ?? []) {
        Deferred.doneUnsafe(running, Effect.void);
      }
      const byServer = slots.get(upstreamScope);
      slots.delete(upstreamScope);
      const ended = [...(byServer?.values() ?? [])];
      for (const slot of ended) {
        slot.removed = true;
        slot.forced = true;
      }
      return Effect.forEach(ended, closeWhenDone, { concurrency: "unbounded", discard: true });
    });

  /**
   * Closes the one upstream session a token holds for a server, for a server
   * the token's session is no longer served. Does nothing when there is none.
   */
  const closeUpstreamSession = (upstreamScope: string, serverId: string): Effect.Effect<void> =>
    Effect.suspend(() => {
      const slot = slots.get(upstreamScope)?.get(serverId);
      if (slot === undefined) return Effect.void;
      forgetSlot(slot);
      return closeWhenDone(slot);
    });

  /**
   * Closes the upstream sessions of one server that no longer fit it: when it
   * is deleted or switched off, or its `revision` or its Connection's
   * `credentialsGeneration` moved since a session opened. Calls that still use
   * a session finish with it first.
   */
  const closeSessionsThatLostDestination = (serverId: string) =>
    Effect.gen(function* () {
      const open = [...slots.values()].flatMap((byServer) => {
        const slot = byServer.get(serverId);
        return slot === undefined ? [] : [slot];
      });
      if (open.length === 0) return;
      const found = yield* servers.readById(serverId);
      const connection = Option.isSome(found)
        ? (yield* readDependenciesOf(found.value)).connection
        : undefined;
      for (const slot of open) {
        const lost =
          Option.isNone(found) ||
          !found.value.enabled ||
          found.value.revision !== slot.serverRevision ||
          connection === undefined ||
          connection.credentialsGeneration !== slot.credentialsGeneration;
        if (!lost) continue;
        forgetSlot(slot);
        yield* closeWhenDone(slot);
      }
    });

  // Subscribe before anything can open a session, so no change is missed. A
  // change to a server's own row, or to its Connection, is what can take its
  // destination away; the follower writes a plugin that stops as a change to
  // the server's row.
  const changes = yield* recordChanges.subscribe(["mcpServer", "connection"]);
  yield* Effect.forkIn(
    Effect.gen(function* () {
      while (true) {
        const changedServers = new Set<string>();
        const changedConnections = new Set<string>();
        for (const change of yield* Queue.takeAll(changes)) {
          (change.topic === "mcpServer" ? changedServers : changedConnections).add(change.id);
        }
        const affected = new Set<string>();
        for (const byServer of slots.values()) {
          for (const slot of byServer.values()) {
            if (changedServers.has(slot.serverId) || changedConnections.has(slot.connectionId)) {
              affected.add(slot.serverId);
            }
          }
        }
        for (const serverId of affected) {
          yield* absorbFailures(
            `Closing the upstream MCP sessions of MCP server ${serverId} after it changed`,
            closeSessionsThatLostDestination(serverId),
          );
        }
      }
    }),
    serviceScope,
  );

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

  const buildNotServingRefusal = (message: string): McpCallRefused =>
    new McpCallRefused({ reason: "error", message, controllerNotServing: true });

  /** Refuses at once, with the promotion gate's own text, unless the controller is serving. */
  const refuseUnlessServing = promotion.refuseUnlessServing.pipe(
    Effect.mapError((error) => buildNotServingRefusal(error.error.message)),
  );

  /**
   * Runs one call to the end: checks the server, takes the upstream session,
   * sends the call, and when the server answers 401 to the call's own request
   * refreshes the Connection's credentials and sends it once more.
   */
  const runCall = (input: McpToolCall): Effect.Effect<McpSchema.CallToolResult, McpCallRefused> =>
    Effect.gen(function* () {
      const refuse = (reason: McpServerWarningReason, name: string, message?: string) =>
        Effect.fail(
          new McpCallRefused({ reason, message: message ?? describeRefusal(reason, name) }),
        );

      /**
       * Reads the server, its plugin and its Connection as they are now, and
       * refuses unless the call may go to them: the server exists, is
       * switched on and `ready`, its plugin and Connection can serve it, and
       * it still lists the tool.
       */
      const readDestination: Effect.Effect<Destination, McpCallRefused | SqlError> = Effect.gen(
        function* () {
          const found = yield* servers.readById(input.serverId);
          if (Option.isNone(found)) {
            return yield* refuse("error", "This server", "This MCP server no longer exists.");
          }
          const server = found.value;
          const name = server.name;
          const dependencies = yield* readDependenciesOf(server);

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
          return { server, dependencies, contribution, connection, tool };
        },
      );

      /**
       * Runs before every request the call makes to outside the controller:
       * refuses unless the controller is serving, the caller may still make
       * the call, and the destination is still there. With `expected`, the
       * destination must also be the one the call began with: the same
       * `revision`, plugin state, and Connection status and generation.
       */
      const checkBeforeSend = (
        expected: Destination | undefined,
      ): Effect.Effect<Destination, McpCallRefused | SqlError> =>
        Effect.gen(function* () {
          yield* refuseUnlessServing;
          yield* input.authorize;
          const now = yield* readDestination;
          if (
            expected !== undefined &&
            (now.server.revision !== expected.server.revision ||
              !isSameDependencies(expected.dependencies, now.dependencies))
          ) {
            return yield* refuse(
              "error",
              expected.server.name,
              `${expected.server.name} was changed while the call ran. Try the call again.`,
            );
          }
          return now;
        });

      const first = yield* checkBeforeSend(undefined);
      const { server, contribution } = first;
      const name = server.name;
      const basis: StateBasis = { revision: server.revision, dependencies: first.dependencies };
      const checkAgain = checkBeforeSend(first);

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

      // The identity of the credentials read last, for a refresh when the
      // client cannot say which credentials a rejection was about.
      let lastReadIdentity = "";
      /** Reads the Connection's credentials as they are now. Each request reads them anew, and never reuses an older reading. */
      const readCredentials = connectionTypes.readCredentialsForUse(server.connectionId).pipe(
        Effect.mapError(describeUnavailable),
        Effect.tap((read) =>
          Effect.sync(() => {
            lastReadIdentity = read.identity;
          }),
        ),
      );

      /**
       * Decides what a failure of the call means. A tool's own answer, a
       * JSON-RPC error or HTTP 403, is returned to the agent as a result. A
       * 401 or an ended MCP session sends the call again only when it was the
       * answer to the call's own request, which the server then did not run.
       */
      const decideFailure = (
        slot: UpstreamSlot,
        opened: OpenedUpstream,
        error: McpClientError.McpClientError,
        call: UpstreamCallState,
      ): Effect.Effect<
        McpSchema.CallToolResult,
        UpstreamError | SessionExpired | CutOff | ExchangeBroken
      > => {
        const reason = error.reason;
        if (slot.forced) return Effect.fail(CUT_OFF);
        if (reason._tag === "ClosedError" && reason.sessionExpired === true) {
          // Nothing else may use this session; the next call opens a new one.
          forgetSlot(slot);
          // The session is gone either because the server answered 404 to the
          // tool's own request, or because another request found it gone and
          // this one was never sent. Both leave the tool unrun. A 404 on any
          // other request of this call, sent after the tool, says nothing.
          return call.toolPostSent && call.toolPostStatus !== 404
            ? Effect.fail({ _tag: "ExchangeBroken" })
            : Effect.fail({ _tag: "SessionExpired" });
        }
        // The server's own error for this call. A failure of the client
        // itself has no code. Its text is the tool's answer, which the agent
        // needs, but never keeps a credential the call sent.
        if (reason._tag === "ProtocolError" && reason.code !== undefined) {
          return Effect.succeed(
            buildErrorResult(
              removeCredentialValues(
                reason.description ?? "The server answered the call with an error.",
                call.sentValues,
              ),
            ),
          );
        }
        if (reason._tag === "HttpError" && reason.status === 403) {
          return Effect.succeed(buildErrorResult(FORBIDDEN_ANSWER));
        }
        const failure = opened.describeFailure(error, call.sentIdentity);
        return failure.reason === "unauthorized" && call.toolPostStatus !== 401
          ? Effect.fail({ _tag: "ExchangeBroken" })
          : Effect.fail(failure);
      };

      /**
       * Sends the call once, on the upstream MCP session of this token. The
       * checks before a send run first, which also guards the opening of the
       * session, unless `alreadyChecked` is the result of one that just ran. A
       * call that waited for the session to open checks again, and reads the
       * credentials again, because it may have waited a long time.
       */
      const attempt = (
        alreadyChecked: Destination | undefined,
      ): Effect.Effect<McpSchema.CallToolResult, AttemptFailure | SqlError> =>
        Effect.gen(function* () {
          const destination = alreadyChecked ?? (yield* checkAgain);
          const credentials = yield* readCredentials;
          return yield* Effect.acquireUseRelease(
            holdSlot(
              input.upstreamScope,
              destination.server,
              destination.connection.credentialsGeneration,
              destination.contribution,
              credentials,
            ),
            (slot) =>
              Effect.gen(function* () {
                const waited = !slot.opened;
                const opened = yield* Deferred.await(slot.opening);
                const sending = waited ? yield* checkAgain : destination;
                const call = createUpstreamCallState(waited ? yield* readCredentials : credentials);
                return yield* opened.client
                  .callTool({
                    tool: sending.tool,
                    ...(input.arguments === undefined ? {} : { arguments: input.arguments }),
                  })
                  .pipe(
                    Effect.provideService(CurrentUpstreamCall, call),
                    Effect.map((result) => removeCredentialValues(result, call.sentValues)),
                    Effect.catch((error) => decideFailure(slot, opened, error, call)),
                  );
              }),
            releaseSlot,
          );
        });

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
            case "not-serving":
              return yield* Effect.fail(buildNotServingRefusal(failure.message));
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
       * the call sent. Refuses the call when it cannot. Nothing is refreshed
       * unless the call may still be made and its destination is unchanged.
       */
      const refreshAfterRejection = (failure: UpstreamError) =>
        Effect.gen(function* () {
          yield* checkAgain;
          const refreshed = yield* Effect.result(
            connectionTypes.refreshAfterRejection(
              server.connectionId,
              failure.sentIdentity ?? lastReadIdentity,
            ),
          );
          if (refreshed._tag === "Success") return;
          const error: ConnectionCredentialsUnavailable | ConnectionCannotRefresh =
            refreshed.failure;
          if (error._tag === "ConnectionCannotRefresh") {
            return yield* refuseUpstreamFailure(failure);
          }
          return yield* Effect.fail(describeUnavailable(error));
        });

      let refreshed = false;
      let replaced = false;
      let alreadyChecked: Destination | undefined = first;
      while (true) {
        const outcome = yield* Effect.result(attempt(alreadyChecked));
        alreadyChecked = undefined;
        if (outcome._tag === "Success") return outcome.success;
        const failure = outcome.failure;
        switch (failure._tag) {
          case "McpCallRefused":
          case "SqlError":
            return yield* Effect.fail(failure);
          case "CutOff":
            return yield* refuse(
              "error",
              name,
              `${name} was changed or its session ended while the call ran. Try the call again.`,
            );
          case "ExchangeBroken":
            return yield* refuse(
              "error",
              name,
              `The call was sent to ${name}, but the exchange with it broke, so the call may have run. Check before trying it again.`,
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
              yield* refreshAfterRejection(failure);
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
      // The call ends when its token ends, wherever it is: waiting for a
      // check, for a session to open, or for the server.
      const endsWithToken = Effect.suspend(() => {
        const ended = Deferred.makeUnsafe<void>();
        const running = runningCalls.get(input.upstreamScope) ?? new Set();
        running.add(ended);
        runningCalls.set(input.upstreamScope, running);
        return bounded.pipe(
          Effect.raceFirst(
            Effect.andThen(
              Deferred.await(ended),
              Effect.fail(
                new McpCallRefused({
                  reason: "error",
                  message: "This session ended, so the call was stopped.",
                }),
              ),
            ),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              running.delete(ended);
              if (running.size === 0 && runningCalls.get(input.upstreamScope) === running) {
                runningCalls.delete(input.upstreamScope);
              }
            }),
          ),
        );
      });
      return promotion
        .admit(endsWithToken)
        .pipe(
          Effect.catch((error) =>
            error instanceof McpCallRefused
              ? Effect.fail(error)
              : Effect.fail(buildNotServingRefusal(error.error.message)),
          ),
        );
    });

  return { readServedServers, callTool, closeUpstreamScope, closeUpstreamSession };
});

/** The calls of the MCP Gateway to outside MCP servers. */
export class McpServerCalls extends Context.Service<McpServerCalls, Effect.Success<typeof make>>()(
  "hercule/controller/mcp-servers/McpServerCalls",
) {}

/** The MCP Server calls, reaching outside servers through `fetch`. */
export const McpServerCallsLayer: Layer.Layer<
  McpServerCalls,
  never,
  SqlClient.SqlClient | ConnectionTypes | PluginHost | PromotionState | Notifier | RecordChanges
> = Layer.effect(McpServerCalls)(make).pipe(Layer.provide(FetchHttpClient.layer));
