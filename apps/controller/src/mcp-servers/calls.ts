/**
 * The calls the MCP Gateway makes to outside MCP servers: calling one tool of
 * one server, and ending the upstream MCP sessions of a Session Token (spec 21
 * sections 3.5, 3.6, 3.10, 5.1, 5.3 and 5.6).
 *
 * Upstream MCP sessions live in memory, one per Session Token and server, and
 * the first call that needs one opens it. A session is replaced when the
 * server's `revision` or the `generation` of its credentials (for a plugin
 * server, its Connection's `credentialsGeneration`) moved since it opened. It
 * is closed once the calls that use it have ended, when the gateway says its
 * token no longer serves the server (`closeUpstreamSessionsExcept`), when
 * something else replaced it, or when a committed change took the server's
 * destination away. An opening that nothing waits for any more is cancelled
 * at once, also while its token lives. The gateway stops the calls of a token
 * that ended, so a call here never waits for that itself.
 *
 * The gateway admits a call through the promotion state, so a freeze waits
 * for it. This file admits nothing around the whole call: each exchange with
 * the outside server is admitted on its own (`upstream.ts`), and a call that
 * arrives while the controller is not serving is refused at once. One rule decides whether a call may go on (`checkBeforeSend`): the caller
 * may still make it (`McpToolCall.authorize`), the server and the tool are
 * still there as the call found them, and, last, the controller is serving.
 * It runs before every request that starts an exchange with the outside
 * server (each request of the opening of a session, the tool's request and
 * every one sent again), after the credentials that request carries were read,
 * and again when a refresh stored new ones meanwhile. It also runs under the
 * Connection's refresh permit, right before a refresh that the call causes
 * calls the provider. A request that only continues an exchange that already
 * went out is not stopped, and carries the credentials stored then.
 */
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
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
import { ConnectionTypes, type RefreshGuard } from "../connections";
import { nowIso, RecordChanges } from "../db";
import type { Notifier } from "../notifications";
import type { PluginHost } from "../plugins";
import { PromotionState } from "../promotion";
import type { Secrets } from "../secrets";
import {
  readCredentialsGeneration,
  resolveServerAccess,
  type ServerCredentials,
  type ServerCredentialsUnavailable,
  type UpstreamCredentials,
  type UsableAccess,
} from "./access";
import {
  decideCallRefusal,
  describeRefusal,
  isSameDependencies,
  mcpServerCatalogue,
  type McpServerDependencies,
  type ServerUnavailableReason,
} from "./catalogue";
import type { StoredMcpServer, StoredMcpTool } from "./repository";
import { mcpServerSignIns } from "./sign-ins";
import { buildFailureEdit, mcpServerState, type StateBasis } from "./state";
import {
  buildStatusFromFailure,
  decideSignInOffered,
  openUpstream,
  runWithCredentials,
  UPSTREAM_WORK_DEADLINE,
  UpstreamError,
  type ExchangeBroken,
  type OpenedUpstream,
  type PrepareSend,
  type ToolCallProgress,
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
   * The caller's part of the rule at the top of this file. When it fails,
   * nothing more is sent, and `callTool` fails with that refusal.
   */
  readonly authorize: Effect.Effect<void, McpCallRefused>;
}

/** What the agent reads when a call could not read the database. */
const DATABASE_UNREADABLE_ANSWER = "Hercule could not read its own database. Try the call again.";

/**
 * Returns the line the agent reads when the call's own request went out and
 * then something failed, so the call may have run. `what` says what failed.
 * It asks the agent to check with the user first, because sending the call
 * again could do its work twice.
 */
const describeMayHaveRun = (target: string, what: string): string =>
  `The call was sent to ${target}, but ${what}, so the call may have run. Ask the user before trying it again.`;

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
  /** The record that held the server's credentials when the slot was made (`ServerCredentials.credentialsRecordId`). */
  readonly credentialsRecordId: string;
  /** The server's `revision` when the slot was made. */
  readonly serverRevision: number;
  /** The credentials' `generation` when the slot was made. */
  readonly credentialsGeneration: number;
  /** Ends with the open session, or the reason it could not be opened. */
  readonly opening: Deferred.Deferred<OpenedUpstream, UpstreamError>;
  /** Completing it cancels an opening that has not ended. */
  readonly cancelOpening: Deferred.Deferred<void>;
  readonly scope: Scope.Closeable;
  /** The credential values the session's requests sent, also when it failed to open or expired. */
  readonly sentValues: Set<string>;
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
  readonly access: UsableAccess;
  /** The tool's definition as it is stored now. */
  readonly tool: McpSchema.Tool;
}

const buildNotServingRefusal = (message: string): McpCallRefused =>
  new McpCallRefused({ reason: "error", message, controllerNotServing: true });

const make = Effect.gen(function* () {
  const catalogue = yield* mcpServerCatalogue;
  const state = yield* mcpServerState;
  const connectionTypes = yield* ConnectionTypes;
  const signIns = yield* mcpServerSignIns;
  const promotion = yield* PromotionState;
  const recordChanges = yield* RecordChanges;
  const httpClient = yield* HttpClient.HttpClient;
  const serviceScope = yield* Effect.scope;

  /** Refuses at once, with the promotion gate's own text, unless the controller is serving. */
  const refuseUnlessServing = promotion.refuseUnlessServing.pipe(
    Effect.mapError((error) => buildNotServingRefusal(error.error.message)),
  );

  /**
   * Reads a server's credentials as they are stored now, for a request that
   * only continues an exchange that already went out, and for the DELETE that
   * ends an upstream session. It never refreshes them, because neither
   * request belongs to a call that may still ask the provider for anything,
   * and it runs no check of a caller. Fails with an `UpstreamError` that has
   * reason `refused` when the credentials cannot be read.
   */
  const readCurrentCredentials = (credentials: ServerCredentials): PrepareSend =>
    Effect.mapError(
      credentials.readWithoutRefresh,
      () =>
        new UpstreamError({
          reason: "refused",
          message: "The server's credentials could not be read",
        }),
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
    access: UsableAccess,
    credentials: UpstreamCredentials,
    firstRevision: string | null,
    prepareSend: PrepareSend,
  ) =>
    openUpstream({
      endpoint: access.endpoint,
      credentials,
      firstRevision,
      prepareSend,
      readCurrentCredentials: readCurrentCredentials(access.credentials),
      sentValues: slot.sentValues,
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
   * server, or an older `generation` of its credentials, is replaced.
   * `prepareSend` prepares each request of the opening. Call `releaseSlot`
   * when the call is done with it.
   */
  const holdSlot = (
    upstreamScope: string,
    destination: Destination,
    credentials: UpstreamCredentials,
    prepareSend: PrepareSend,
  ): Effect.Effect<UpstreamSlot> =>
    Effect.gen(function* () {
      const { server, access } = destination;
      const existing = slots.get(upstreamScope)?.get(server.id);
      const usable =
        existing !== undefined &&
        existing.serverRevision === server.revision &&
        existing.credentialsGeneration === access.credentials.generation;
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
        credentialsRecordId: access.credentials.credentialsRecordId,
        serverRevision: server.revision,
        credentialsGeneration: access.credentials.generation,
        opening: Deferred.makeUnsafe(),
        cancelOpening: Deferred.makeUnsafe(),
        scope: Scope.makeUnsafe(),
        sentValues: new Set(),
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
        openSlot(slot, access, credentials, server.protocolVersion, prepareSend),
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
   * Closes the upstream sessions that no longer fit their server after the
   * records `changed` changed: the server was deleted or switched off, or its
   * `revision` or the `generation` of its credentials moved since a session
   * opened. Calls that still use a session finish with it first.
   */
  const closeSessionsThatLostDestination = (changed: ReadonlySet<string>) =>
    Effect.gen(function* () {
      const touched = [...slots.values()]
        .flatMap((byServer) => [...byServer.values()])
        .filter((slot) => changed.has(slot.serverId) || changed.has(slot.credentialsRecordId));
      if (touched.length === 0) return;
      const views = yield* catalogue.readViews(
        touched.map((slot) => slot.serverId),
        "without-tools",
      );
      for (const slot of touched) {
        const view = views.get(slot.serverId);
        const lost =
          view === undefined ||
          !view.server.enabled ||
          view.server.revision !== slot.serverRevision ||
          readCredentialsGeneration(view) !== slot.credentialsGeneration;
        if (!lost) continue;
        forgetSlot(slot);
        yield* closeWhenDone(slot);
      }
    });

  // Subscribe before anything can open a session, so no change is missed. A
  // change to a server's own row, or to the record that holds its credentials
  // (a plugin server's Connection), is what can take its destination away; the
  // follower writes a plugin that stops as a change to the server's row.
  const changes = yield* recordChanges.subscribe(["mcpServer", "connection"]);
  yield* Effect.forkIn(
    Effect.forever(
      Effect.flatMap(changes.takePending, (pending) =>
        absorbFailures(
          "Closing the upstream MCP sessions of the servers that changed",
          closeSessionsThatLostDestination(new Set(pending.map((change) => change.id))),
        ),
      ),
    ),
    serviceScope,
  );

  yield* Effect.addFinalizer(() =>
    Effect.forEach([...slots.keys()], (scope) => closeUpstreamSessionsExcept(scope, new Set()), {
      discard: true,
    }),
  );

  /**
   * Writes a failure that is about the whole server as its status, with what a
   * server added by URL offers as a sign-in when the failure is an HTTP 401,
   * unless something newer happened.
   */
  const writeFailure = (
    server: StoredMcpServer,
    basis: StateBasis,
    status: "unreachable" | "error" | "needs-sign-in",
    detail: string,
    signInOffered: "oauth" | "token" | undefined,
  ): Effect.Effect<void> =>
    absorbFailures(
      `Writing the status of MCP server ${server.id} after a call failed`,
      Effect.gen(function* () {
        const at = yield* nowIso;
        yield* state.writeCheckResult(
          server.id,
          basis,
          buildFailureEdit(
            server,
            { status, detail, ...(signInOffered === undefined ? {} : { signInOffered }) },
            at,
          ),
          at,
        );
      }),
    );

  /**
   * Runs one call to the end: checks the server, takes the upstream session,
   * sends the call, and when the server answers 401 to the call's own request
   * refreshes the server's credentials and sends it once more.
   */
  const runCall = (
    input: McpToolCall,
    progress: ToolCallProgress,
  ): Effect.Effect<McpSchema.CallToolResult, McpCallRefused> =>
    Effect.gen(function* () {
      const refuse = (reason: ServerUnavailableReason | "timed-out", message: string) =>
        Effect.fail(new McpCallRefused({ reason, message }));

      /**
       * Reads the server and what it depends on as they are now, and refuses
       * unless the call may go to it (`decideCallRefusal`) and the server still
       * lists the tool. Resolves how to reach the server here, because a call
       * is about to send.
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
          return yield* refuse("error", "This MCP server no longer exists.");
        }
        const { server, dependencies } = view;
        const refusal = decideCallRefusal(view);
        if (refusal !== null) return yield* new McpCallRefused(refusal);
        const access = resolveServerAccess(view, connectionTypes, signIns);
        if (access._tag !== "usable") {
          return yield* Effect.die(
            `MCP server ${server.id} passed the call verdict but is unusable`,
          );
        }
        const stored = server.tools.find((tool) => tool.name === input.tool);
        if (stored === undefined) {
          return yield* refuse(
            "error",
            `The MCP server "${server.name}" no longer offers this tool.`,
          );
        }
        const tool = yield* decodeTool(stored).pipe(
          Effect.mapError(
            () =>
              new McpCallRefused({
                reason: "error",
                message: describeRefusal("error", server),
              }),
          ),
        );
        return { server, dependencies, access, tool };
      });

      const buildChangedMessage = (expected: Destination): string =>
        `${expected.server.name} was changed while the call ran. Try the call again.`;

      /**
       * Refuses unless the caller may still make the call and the destination
       * is still there. With `expected`, the destination must also be the one
       * the call began with: the same `revision` and the same dependencies
       * (`isSameDependencies`). Returns the destination as it is now.
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
            return yield* refuse("error", buildChangedMessage(expected));
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
      const { server, access } = first;
      const { credentials: serverCredentials } = access;
      const name = server.name;
      const basis: StateBasis = { revision: server.revision, dependencies: first.dependencies };

      /**
       * Runs right before a refresh calls the provider, under the refresh
       * permit of a Connection: the rule of `checkBeforeSend`.
       */
      const guardRefresh: RefreshGuard<McpCallRefused> = Effect.asVoid(checkBeforeSend(first));

      /** Returns the refusal that a failure to give credentials means for this call. */
      const buildUnavailableRefusal = (error: ServerCredentialsUnavailable): McpCallRefused =>
        new McpCallRefused({
          reason: error.status,
          message: describeRefusal(error.status, server),
        });

      /**
       * Prepares a request that starts an exchange: reads the server's
       * credentials as they are now, and only then runs the rule of
       * `checkBeforeSend`, so a wait for credentials never lets an older check
       * stand. The request carries the credentials it returns, which are read
       * again when a refresh stored new ones meanwhile. When the rule refuses,
       * the request is not sent and the call fails with the refusal.
       */
      const prepareSend: PrepareSend<McpCallRefused> = Effect.gen(function* () {
        while (true) {
          // Read before the credentials, so that a refresh that stores new
          // ones in between shows as a different version, never as the same.
          const version = yield* serverCredentials.readVersion;
          const credentials = yield* serverCredentials
            .readForUse(guardRefresh)
            .pipe(
              Effect.mapError((error) =>
                error instanceof McpCallRefused ? error : buildUnavailableRefusal(error),
              ),
            );
          yield* checkDestination(first);
          // A refresh does not move the credentials' `generation`, so a refresh
          // that stored new tokens while the check above ran is found by the
          // version of the stored credentials. Then they are read again,
          // because they are no longer the current ones.
          const stored = yield* serverCredentials.readVersion;
          if (stored !== version) continue;
          yield* refuseUnlessServing;
          return credentials;
        }
      });

      /**
       * The same preparation for the requests that open a session, which
       * several calls can share. A refusal there ends the opening as a
       * request that was not sent; each call that waited for the opening then
       * runs its own checks for its own refusal (`refuseUpstreamFailure`).
       */
      const prepareOpeningSend: PrepareSend = Effect.mapError(
        prepareSend,
        (refused) => new UpstreamError({ reason: "refused", message: refused.message }),
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
      const attempt = (credentials: UpstreamCredentials) =>
        Effect.acquireUseRelease(
          holdSlot(input.upstreamScope, first, credentials, prepareOpeningSend),
          (slot) =>
            Effect.flatMap(Deferred.await(slot.opening), (opened) =>
              opened
                .callTool({
                  tool: first.tool,
                  arguments: input.arguments,
                  prepareSend,
                  progress,
                  sentValues,
                })
                .pipe(
                  // Nothing else may use this session, whether or not the tool
                  // can be sent again; the next call opens a new one.
                  Effect.tapError((error) =>
                    error._tag === "SessionExpired" ||
                    (error._tag === "ExchangeBroken" && error.sessionExpired)
                      ? Effect.sync(() => forgetSlot(slot))
                      : Effect.void,
                  ),
                ),
            ),
          // The values this session sent go on with the call, so an answer of a
          // session that replaces it is cleaned of them too.
          (slot) =>
            Effect.andThen(
              Effect.sync(() => {
                for (const value of slot.sentValues) sentValues.add(value);
              }),
              releaseSlot(slot),
            ),
        );

      // A call replaces an upstream session the server expired once, however
      // many times it sends again after a refresh.
      let replacedSession = false;

      /** Sends the call, and once more on a new session when the server expired the one it used. */
      const sendReplacingExpiredSession = (
        credentials: UpstreamCredentials,
      ): Effect.Effect<McpSchema.CallToolResult, UpstreamError | McpCallRefused | ExchangeBroken> =>
        attempt(credentials).pipe(
          Effect.catchTag("SessionExpired", () => {
            if (replacedSession) {
              return Effect.fail(
                new UpstreamError({
                  reason: "protocol",
                  message: "The server ended the MCP session",
                }),
              );
            }
            replacedSession = true;
            return sendReplacingExpiredSession(credentials);
          }),
        );

      /** Refuses the call, and writes the status when the failure is about the whole server. */
      const refuseUpstreamFailure = (failure: UpstreamError) =>
        Effect.gen(function* () {
          switch (failure.reason) {
            case "timeout":
              return yield* progress.toolPostSent
                ? refuse("timed-out", describeMayHaveRun(name, `${name} did not answer in time`))
                : refuse("timed-out", `${name} did not answer in time. Try again later.`);
            case "too-large":
              return yield* refuse("error", `${name}: ${TOO_LARGE_ANSWER}.`);
            case "not-serving":
              return yield* Effect.fail(buildNotServingRefusal(failure.message));
            case "refused": {
              // The checks refused the opening this call started or waited
              // for. This call's own checks give its reason.
              yield* checkBeforeSend(first);
              return yield* refuse("error", buildChangedMessage(first));
            }
            default: {
              const { status, detail } = buildStatusFromFailure(failure, serverCredentials);
              yield* writeFailure(
                server,
                basis,
                status,
                detail,
                decideSignInOffered(failure, server.source.kind),
              );
              return yield* progress.toolPostSent && status === "unreachable"
                ? refuse(status, describeMayHaveRun(name, `${name} could not be reached`))
                : refuse(status, describeRefusal(status, server));
            }
          }
        });

      return yield* runWithCredentials({
        credentials: serverCredentials,
        guardRefresh,
        action: sendReplacingExpiredSession,
      }).pipe(
        Effect.catchTags({
          UpstreamError: refuseUpstreamFailure,
          ServerCredentialsUnavailable: (error) => Effect.fail(buildUnavailableRefusal(error)),
          ExchangeBroken: () =>
            refuse("error", describeMayHaveRun(name, "the exchange with it broke")),
        }),
      );
    });

  const callTool = (input: McpToolCall): Effect.Effect<McpSchema.CallToolResult, McpCallRefused> =>
    Effect.suspend(() => {
      const progress: ToolCallProgress = { toolPostSent: false };
      return Effect.flatMap(
        Effect.timeoutOption(runCall(input, progress), UPSTREAM_WORK_DEADLINE),
        Option.match({
          onNone: () =>
            Effect.fail(
              new McpCallRefused({
                reason: "timed-out",
                message: progress.toolPostSent
                  ? describeMayHaveRun("the server", "the call did not finish in time")
                  : "The call took too long. Try again later.",
              }),
            ),
          onSome: Effect.succeed,
        }),
      );
    });

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
  | SqlClient.SqlClient
  | ConnectionTypes
  | PluginHost
  | PromotionState
  | Notifier
  | RecordChanges
  | Secrets
> = Layer.effect(McpServerCalls)(make).pipe(Layer.provide(FetchHttpClient.layer));
