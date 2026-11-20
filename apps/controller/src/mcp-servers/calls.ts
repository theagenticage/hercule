/**
 * The calls the MCP Gateway makes to outside MCP servers: calling one tool of
 * one server, and ending the upstream MCP sessions of a Session Token (spec 21
 * sections 3.5, 3.6, 3.10, 5.1, 5.3 and 5.6).
 *
 * Upstream MCP sessions live in memory, one per Session Token and server, and
 * the first call that needs one opens it. A session is replaced when the
 * server's `revision` or its Connection's `credentialsGeneration` moved since
 * it opened. It is closed when the gateway says its token no longer serves the
 * server (`closeUpstreamSessionsExcept`), or, when something else replaced it,
 * once the calls that were using it have ended. A committed change that takes
 * a server's destination away (the server is deleted or switched off, or its
 * `revision` or its Connection's `credentialsGeneration` moved) closes that
 * server's sessions the same way. An opening that nothing waits for any more
 * is cancelled at once, also while its token lives. The gateway ends the calls
 * of a token that ended, so a call here never waits for that itself.
 *
 * A call is admitted by the promotion state, so a freeze waits for it, and a
 * call that arrives while the controller is not serving is refused at once.
 * One rule decides whether a call may go on (`checkBeforeSend`): the caller
 * may still make it (`McpToolCall.authorize`), the server and the tool are
 * still there as the call found them, and, last, the controller is still
 * serving. It runs before the call makes any request that starts an exchange
 * with the outside server (every request of the opening of a session, the
 * tool's request, and every one sent again), after the credentials that
 * request carries were read, because reading them can wait for a refresh, and
 * the credentials are read again when a refresh stored new ones meanwhile. It
 * also runs under the Connection's refresh permit, right before a refresh of
 * the credentials that the call causes calls the provider. A request that only
 * continues an exchange that already went out is not stopped, and carries the
 * credentials stored then.
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
import type * as SqlClient from "effect/sql/SqlClient";
import { McpSchema } from "effect/ai";
import { McpServerWarningReason } from "@hercule/protocol";
import { absorbFailures } from "../absorbing";
import {
  ConnectionCredentialsUnavailable,
  ConnectionTypes,
  type ConnectionCredentialsForUse,
  type RefreshGuard,
  type StoredConnection,
} from "../connections";
import { nowIso, RecordChanges } from "../db";
import type { Notifier } from "../notifications";
import type { PluginHost, RegisteredMcpServer } from "../plugins";
import { PromotionState } from "../promotion";
import {
  decideCallRefusal,
  describeRefusal,
  isSameDependencies,
  judgeDependencies,
  mcpServerCatalogue,
  type McpServerDependencies,
  type ServerUnavailableReason,
} from "./catalogue";
import type { StoredMcpServer, StoredMcpTool } from "./repository";
import { buildFailureEdit, mcpServerState, type StateBasis } from "./state";
import {
  buildStatusFromFailure,
  buildStatusFromUnavailable,
  openUpstream,
  runWithCredentials,
  UpstreamError,
  type OpenedUpstream,
  type PrepareSend,
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

/** What `callTool` takes. */
export interface McpToolCall {
  /** The hash of the caller's Session Token: one upstream MCP session per scope and server. */
  readonly upstreamScope: string;
  readonly serverId: string;
  /** The tool's original name, as the server lists it. */
  readonly tool: string;
  readonly arguments: Readonly<Record<string, unknown>> | undefined;
  /**
   * Part of the rule that runs before every request that starts an exchange
   * with the outside server, and under the Connection's refresh permit right
   * before a refresh calls the provider (see the top of this file). When it
   * fails, nothing more is sent, and `callTool` fails with that refusal.
   */
  readonly authorize: Effect.Effect<void, McpCallRefused>;
}

/** How long a whole call may take: opening the upstream session, the refresh, the retry and the tool. */
export const McpCallDeadline = Context.Reference<Duration.Duration>(
  "hercule/controller/mcp-servers/McpCallDeadline",
  { defaultValue: () => Duration.seconds(60) },
);

/** What the agent reads when a call could not read the database. */
const DATABASE_UNREADABLE_ANSWER = "Hercule could not read its own database. Try the call again.";

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
  /** Ends with the open session, or the reason it could not be opened. */
  readonly opening: Deferred.Deferred<OpenedUpstream, UpstreamError>;
  /** Completing it cancels an opening that has not ended. */
  readonly cancelOpening: Deferred.Deferred<void>;
  readonly scope: Scope.Closeable;
  /** How many calls hold the slot, from before they wait for it to open until they end. */
  users: number;
  /** The session opened. */
  opened: boolean;
  /** The slot is no longer the one new calls use. */
  removed: boolean;
  closed: boolean;
}

/**
 * Converts a tool definition the controller stored into the client's `Tool`.
 * Fails when the stored definition does not fit it.
 */
const decodeTool = (stored: StoredMcpTool) => Schema.decodeUnknownEffect(McpSchema.Tool)(stored);

/** What a call needs to know about the server it goes to, as the database holds it now. */
interface Destination {
  readonly server: StoredMcpServer;
  readonly dependencies: McpServerDependencies;
  readonly contribution: RegisteredMcpServer;
  readonly connection: StoredConnection;
  /** The tool's definition as it is stored now. */
  readonly tool: McpSchema.Tool;
}

const buildNotServingRefusal = (message: string): McpCallRefused =>
  new McpCallRefused({ reason: "error", message, controllerNotServing: true });

const make = Effect.gen(function* () {
  const catalogue = yield* mcpServerCatalogue;
  const state = yield* mcpServerState;
  const connectionTypes = yield* ConnectionTypes;
  const promotion = yield* PromotionState;
  const recordChanges = yield* RecordChanges;
  const httpClient = yield* HttpClient.HttpClient;
  const serviceScope = yield* Effect.scope;

  /** Refuses at once, with the promotion gate's own text, unless the controller is serving. */
  const refuseUnlessServing = promotion.refuseUnlessServing.pipe(
    Effect.mapError((error) => buildNotServingRefusal(error.error.message)),
  );

  /**
   * Reads a Connection's credentials as they are stored now, for a request
   * that only continues an exchange that already went out, and for the DELETE
   * that ends an upstream session. It never starts a refresh while the
   * controller is not serving, and it runs no check of a caller. Fails with an
   * `UpstreamError` that has reason `not-serving` for that case, and `refused`
   * when the credentials cannot be read.
   */
  const readCurrentCredentials = (connectionId: string): PrepareSend =>
    connectionTypes
      .readCredentialsForUse(
        connectionId,
        Effect.mapError(
          promotion.refuseUnlessServing,
          (error) =>
            new ConnectionCredentialsUnavailable({
              reason: "not-serving",
              message: error.error.message,
            }),
        ),
      )
      .pipe(
        Effect.mapError(
          (error) =>
            new UpstreamError({
              reason: error.reason === "not-serving" ? "not-serving" : "refused",
              message:
                error.reason === "not-serving"
                  ? error.message
                  : "The Connection's credentials could not be read",
            }),
        ),
      );

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
   * Ends the slot's session when it is no longer the one new calls use and
   * nothing still uses it. An open session is closed, and its DELETE is best
   * effort, only sent while the controller is serving. A session that is still
   * opening is cancelled, and the opening's own exit closes it.
   */
  const closeWhenDone = (slot: UpstreamSlot): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (slot.closed || !slot.removed || slot.users > 0) return Effect.void;
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
    prepareSend: PrepareSend,
  ) =>
    openUpstream({
      contribution,
      credentials,
      firstRevision,
      prepareSend,
      readCurrentCredentials: readCurrentCredentials(slot.connectionId),
    }).pipe(
      Effect.provideService(Scope.Scope, slot.scope),
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.provideService(PromotionState, promotion),
      Effect.raceFirst(Effect.andThen(Deferred.await(slot.cancelOpening), Effect.interrupt)),
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          if (Exit.isSuccess(exit)) {
            slot.opened = true;
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
   * replaced. `prepareSend` prepares each request of the opening. Call
   * `releaseSlot` when the call is done with it.
   */
  const holdSlot = (
    upstreamScope: string,
    destination: Destination,
    credentials: ConnectionCredentialsForUse,
    prepareSend: PrepareSend,
  ): Effect.Effect<UpstreamSlot> =>
    Effect.gen(function* () {
      const { server, connection, contribution } = destination;
      const existing = slots.get(upstreamScope)?.get(server.id);
      const usable =
        existing !== undefined &&
        existing.serverRevision === server.revision &&
        existing.credentialsGeneration === connection.credentialsGeneration;
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
        credentialsGeneration: connection.credentialsGeneration,
        opening: Deferred.makeUnsafe(),
        cancelOpening: Deferred.makeUnsafe(),
        scope: Scope.makeUnsafe(),
        users: 1,
        opened: false,
        removed: false,
        closed: false,
      };
      const byServer = slots.get(upstreamScope) ?? new Map<string, UpstreamSlot>();
      byServer.set(server.id, slot);
      slots.set(upstreamScope, byServer);
      // The old session ends without holding up this call.
      if (existing !== undefined) yield* Effect.forkIn(closeWhenDone(existing), serviceScope);
      yield* Effect.forkIn(
        openSlot(slot, contribution, credentials, server.protocolVersion, prepareSend),
        serviceScope,
      );
      return slot;
    });

  /**
   * Lets go of the slot. When it is still opening and this was the last call
   * waiting for it, the opening is cancelled and the slot is removed, because
   * a session nobody waits for would open for nothing, whatever the state of
   * its token. An open session stays, for the next call of the token.
   */
  const releaseSlot = (slot: UpstreamSlot): Effect.Effect<void> =>
    Effect.suspend(() => {
      slot.users -= 1;
      if (slot.users === 0 && !slot.opened) forgetSlot(slot);
      return closeWhenDone(slot);
    });

  /**
   * Closes the upstream sessions a token holds for every server that is not
   * in `keptServerIds`, once the calls that use them have ended. With none
   * kept, the token's every session ends. The gateway calls it with the
   * servers the token is served now, and with none once the token ended, after
   * it stopped the token's calls.
   */
  const closeUpstreamSessionsExcept = (
    upstreamScope: string,
    keptServerIds: ReadonlySet<string>,
  ): Effect.Effect<void> =>
    Effect.suspend(() => {
      const ended = [...(slots.get(upstreamScope)?.values() ?? [])].filter(
        (slot) => !keptServerIds.has(slot.serverId),
      );
      for (const slot of ended) forgetSlot(slot);
      return Effect.forEach(ended, closeWhenDone, { concurrency: "unbounded", discard: true });
    });

  /**
   * Closes the upstream sessions of the given servers that no longer fit
   * them: a server was deleted or switched off, or its `revision` or its
   * Connection's `credentialsGeneration` moved since a session opened. Calls
   * that still use a session finish with it first.
   */
  const closeSessionsThatLostDestination = (serverIds: ReadonlySet<string>) =>
    Effect.gen(function* () {
      const views = yield* catalogue.readViews([...serverIds]);
      for (const byServer of [...slots.values()]) {
        for (const slot of [...byServer.values()]) {
          if (!serverIds.has(slot.serverId)) continue;
          const view = views.get(slot.serverId);
          const lost =
            view === undefined ||
            !view.server.enabled ||
            view.server.revision !== slot.serverRevision ||
            view.dependencies.connection?.credentialsGeneration !== slot.credentialsGeneration;
          if (!lost) continue;
          forgetSlot(slot);
          yield* closeWhenDone(slot);
        }
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
        const pending = yield* changes.takePending;
        const changed = new Set(pending.map((change) => change.id));
        const affected = new Set<string>();
        for (const byServer of slots.values()) {
          for (const slot of byServer.values()) {
            if (changed.has(slot.serverId) || changed.has(slot.connectionId)) {
              affected.add(slot.serverId);
            }
          }
        }
        if (affected.size === 0) continue;
        yield* absorbFailures(
          "Closing the upstream MCP sessions of the servers that changed",
          closeSessionsThatLostDestination(affected),
        );
      }
    }),
    serviceScope,
  );

  yield* Effect.addFinalizer(() =>
    Effect.forEach([...slots.keys()], (scope) => closeUpstreamSessionsExcept(scope, new Set()), {
      discard: true,
    }),
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
        yield* state.writeCheckResult(
          server.id,
          basis,
          buildFailureEdit(server, { status, detail }, at),
          at,
        );
      }),
    );

  /**
   * Runs one call to the end: checks the server, takes the upstream session,
   * sends the call, and when the server answers 401 to the call's own request
   * refreshes the Connection's credentials and sends it once more.
   */
  const runCall = (input: McpToolCall): Effect.Effect<McpSchema.CallToolResult, McpCallRefused> =>
    Effect.gen(function* () {
      const refuse = (
        reason: ServerUnavailableReason | "timed-out",
        name: string,
        message?: string,
      ) =>
        Effect.fail(
          new McpCallRefused({
            reason,
            message:
              message ??
              (reason === "timed-out"
                ? `${name} did not answer in time. Try again later.`
                : describeRefusal(reason, name)),
          }),
        );

      /**
       * Reads the server, its plugin and its Connection as they are now, and
       * refuses unless the call may go to them (`decideCallRefusal`) and the
       * server still lists the tool.
       */
      const readDestination: Effect.Effect<Destination, McpCallRefused> = Effect.gen(function* () {
        const views = yield* catalogue
          .readViews([input.serverId])
          .pipe(
            Effect.mapError(
              () => new McpCallRefused({ reason: "error", message: DATABASE_UNREADABLE_ANSWER }),
            ),
          );
        const view = views.get(input.serverId);
        if (view === undefined) {
          return yield* refuse("error", "This server", "This MCP server no longer exists.");
        }
        const { server, dependencies } = view;
        const refusal = decideCallRefusal(view);
        if (refusal !== null) return yield* new McpCallRefused(refusal);
        const judged = judgeDependencies(dependencies);
        if (judged._tag !== "usable") {
          return yield* Effect.die(`MCP server ${server.id} is usable but has no plugin`);
        }
        const stored = server.tools.find((tool) => tool.name === input.tool);
        if (stored === undefined) {
          return yield* refuse("error", server.name, "The server does not list this tool.");
        }
        const tool = yield* decodeTool(stored).pipe(
          Effect.mapError(
            () =>
              new McpCallRefused({
                reason: "error",
                message: describeRefusal("error", server.name),
              }),
          ),
        );
        return {
          server,
          dependencies,
          contribution: judged.contribution,
          connection: judged.connection,
          tool,
        };
      });

      const buildChangedMessage = (expected: Destination): string =>
        `${expected.server.name} was changed while the call ran. Try the call again.`;

      /**
       * Refuses unless the caller may still make the call and the destination
       * is still there. With `expected`, the destination must also be the one
       * the call began with: the same `revision`, plugin state, and Connection
       * status and generation. Returns the destination as it is now.
       */
      const checkDestination = (
        expected: Destination | undefined,
      ): Effect.Effect<Destination, McpCallRefused> =>
        Effect.gen(function* () {
          yield* input.authorize;
          const now = yield* readDestination;
          if (
            expected !== undefined &&
            (now.server.revision !== expected.server.revision ||
              !isSameDependencies(expected.dependencies, now.dependencies))
          ) {
            return yield* refuse("error", expected.server.name, buildChangedMessage(expected));
          }
          return now;
        });

      /** The rule at the top of this file: `checkDestination`, and, checked last, that the controller is serving. */
      const checkBeforeSend = (
        expected: Destination | undefined,
      ): Effect.Effect<Destination, McpCallRefused> =>
        Effect.gen(function* () {
          const now = yield* checkDestination(expected);
          // Last, so that nothing slow stands between this check and the send.
          yield* refuseUnlessServing;
          return now;
        });

      const first = yield* checkBeforeSend(undefined);
      const { server, contribution, connection } = first;
      const name = server.name;
      const basis: StateBasis = { revision: server.revision, dependencies: first.dependencies };

      // Why a check before a send or a refresh refused it. The client can only
      // fail with its own error, and a refresh only with the Connection's, so
      // the reason is kept here for the code that returns the refusal.
      let refusal: McpCallRefused | undefined;
      const keepRefusal = (refused: McpCallRefused) =>
        Effect.sync(() => {
          refusal = refused;
        });

      /**
       * Runs under the Connection's refresh permit, right before a refresh
       * calls the provider: the rule of `checkBeforeSend`.
       */
      const guardRefresh: RefreshGuard = checkBeforeSend(first).pipe(
        Effect.asVoid,
        Effect.catch((refused) =>
          keepRefusal(refused).pipe(
            Effect.andThen(
              Effect.fail(
                new ConnectionCredentialsUnavailable({
                  reason: "refused",
                  message: "The caller's check refused the refresh",
                }),
              ),
            ),
          ),
        ),
      );

      /** Returns the refusal that a failure to give credentials means for this call. */
      const buildUnavailableRefusal = (error: ConnectionCredentialsUnavailable): McpCallRefused => {
        if (error.reason === "refused") {
          return (
            refusal ?? new McpCallRefused({ reason: "error", message: buildChangedMessage(first) })
          );
        }
        const { status } = buildStatusFromUnavailable(error, connection, contribution.displayName);
        return new McpCallRefused({ reason: status, message: describeRefusal(status, name) });
      };

      /**
       * Prepares a request that starts an exchange: reads the Connection's
       * credentials as they are now, and only then runs the rule of
       * `checkBeforeSend`, so a wait for credentials never lets an older check
       * stand. The request carries the credentials it returns, which are read
       * again when a refresh stored new ones meanwhile. When the rule refuses,
       * the refusal is kept and the request is not sent.
       */
      const prepareSend: PrepareSend = Effect.gen(function* () {
        while (true) {
          // Read before the credentials, so that a refresh that stores new
          // ones in between shows as a different version, never as the same.
          const version = yield* connectionTypes.readCredentialsVersion(server.connectionId);
          const credentials = yield* connectionTypes
            .readCredentialsForUse(server.connectionId, guardRefresh)
            .pipe(Effect.mapError(buildUnavailableRefusal));
          yield* checkDestination(first);
          // A refresh does not move the Connection's `credentialsGeneration`,
          // so a refresh that stored new tokens while the check above ran is
          // found by the version of the stored credentials. Then they are read
          // again, because they are no longer the current ones.
          const stored = yield* connectionTypes.readCredentialsVersion(server.connectionId);
          if (stored !== version) continue;
          yield* refuseUnlessServing;
          return credentials;
        }
      }).pipe(
        Effect.catch((refused) =>
          keepRefusal(refused).pipe(
            Effect.andThen(
              Effect.fail(new UpstreamError({ reason: "refused", message: refused.message })),
            ),
          ),
        ),
      );

      // Every credential value any attempt of this call sent, on any upstream
      // session, so a value from the handshake or from a rejected attempt is
      // removed from the answer of a later one. It lives as long as the call.
      const sentValues = new Set<string>();

      /**
       * Sends the call once, on the upstream MCP session of this token. Every
       * request that starts an exchange prepares itself with `prepareSend`,
       * which reads the credentials and checks again at that moment.
       * `credentials` only build the address of an opening.
       */
      const attempt = (credentials: ConnectionCredentialsForUse) =>
        Effect.acquireUseRelease(
          holdSlot(input.upstreamScope, first, credentials, prepareSend),
          (slot) =>
            Effect.flatMap(Deferred.await(slot.opening), (opened) =>
              opened
                .callTool({
                  tool: first.tool,
                  arguments: input.arguments,
                  prepareSend,
                  readCurrentCredentials: readCurrentCredentials(server.connectionId),
                  sentValues,
                })
                .pipe(
                  // Nothing else may use this session; the next call opens a new one.
                  Effect.tapErrorTag("SessionExpired", () => Effect.sync(() => forgetSlot(slot))),
                ),
            ),
          releaseSlot,
        );

      /** Sends the call, and once more on a new session when the server expired the one it used. */
      const sendReplacingExpiredSession = (credentials: ConnectionCredentialsForUse) =>
        attempt(credentials).pipe(
          Effect.catchTag("SessionExpired", () => attempt(credentials)),
          Effect.catchTag("SessionExpired", () =>
            Effect.fail(
              new UpstreamError({
                reason: "protocol",
                message: "The server ended the MCP session",
              }),
            ),
          ),
        );

      /** Refuses the call, and writes the status when the failure is about the whole server. */
      const refuseUpstreamFailure = (failure: UpstreamError) =>
        Effect.gen(function* () {
          switch (failure.reason) {
            case "timeout":
              return yield* refuse("timed-out", name);
            case "too-large":
              return yield* refuse("error", name, `${name}: ${TOO_LARGE_ANSWER}.`);
            case "not-serving":
              return yield* Effect.fail(buildNotServingRefusal(failure.message));
            case "refused": {
              if (refusal !== undefined) return yield* Effect.fail(refusal);
              // Another call's checks refused the opening this call waited
              // for. Its own checks give this call's reason.
              yield* checkBeforeSend(first);
              return yield* refuse("error", name, buildChangedMessage(first));
            }
            default: {
              const { status, detail } = buildStatusFromFailure(failure, contribution.displayName);
              yield* writeFailure(server, basis, status, detail);
              return yield* refuse(status, name);
            }
          }
        });

      return yield* runWithCredentials({
        connections: connectionTypes,
        connectionId: server.connectionId,
        guardRefresh,
        action: sendReplacingExpiredSession,
      }).pipe(
        Effect.catchTags({
          UpstreamError: refuseUpstreamFailure,
          ConnectionCredentialsUnavailable: (error) => Effect.fail(buildUnavailableRefusal(error)),
          ExchangeBroken: () =>
            refuse(
              "error",
              name,
              `The call was sent to ${name}, but the exchange with it broke, so the call may have run. Check before trying it again.`,
            ),
        }),
      );
    });

  const callTool = (input: McpToolCall): Effect.Effect<McpSchema.CallToolResult, McpCallRefused> =>
    Effect.flatMap(McpCallDeadline, (deadline) =>
      promotion
        .admit(
          Effect.flatMap(
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
          ),
        )
        .pipe(
          Effect.catch((error) =>
            error instanceof McpCallRefused
              ? Effect.fail(error)
              : Effect.fail(buildNotServingRefusal(error.error.message)),
          ),
        ),
    );

  return { callTool, closeUpstreamSessionsExcept };
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
