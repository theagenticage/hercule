/**
 * The MCP Gateway (spec 21 section 3): the one MCP endpoint every session's
 * harness is given, in place of the servers themselves. It knows the session
 * from its Session Token, serves the tools of the servers in that session's
 * list under its own names, and forwards each call through the catalogue.
 *
 * The route (`http/mcp.ts`) checks the method, the `Origin` header and the
 * bearer token, and hands the request to `handle`. State kept here lives in
 * memory only: per Session Token, its MCP sessions, the names it was sent, and
 * its open streams. A controller restart drops it, and a harness that names an
 * unknown MCP session gets 404 and opens a new one.
 */
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { McpSchema } from "effect/ai";
import { ControllerSealed, PromotionInProgress } from "@hercule/contract";
import { absorbFailures } from "../absorbing";
import { buildSessionStamp, type SessionActor } from "../actor";
import { PROFILE_GRANTS_TOPIC, RecordChanges, withTransaction } from "../db";
import { AuditLog } from "../events";
import { McpCallRefused, McpServerCalls, type ServedMcpServer } from "../mcp-servers";
import { SessionTokens } from "../permissions";
import { PromotionState } from "../promotion";
import { SessionService, sessionRepository } from "../sessions";
import {
  buildDiscoverResult,
  buildInitializeResult,
  buildListChangedNotification,
  buildListenResult,
  buildMethodNotFound,
  buildRpcError,
  buildRpcResult,
  buildSubscribedListChangedNotification,
  buildSubscriptionAcknowledgement,
  buildToolCallResult,
  buildToolsListResult,
  buildUnsupportedRevision,
  classifyMessage,
  MAX_REQUEST_BODY_BYTES,
  negotiateStatefulRevision,
  readStatelessRevision,
  REQUEST_CANCELLED_ERROR_CODE,
  SESSION_ID_HEADER,
  STATELESS_REVISION,
  type IncomingMessage,
  type JsonObject,
  type RequestId,
} from "./protocol";
import {
  buildMissingGrantRefusal,
  buildNotInListRefusal,
  buildNotServedRefusal,
  buildRefusalWarning,
  buildToolGoneRefusal,
  buildUnknownToolRefusal,
  claimWarning,
  type Refusal,
  type SeenWarning,
} from "./refusals";
import {
  buildProjection,
  buildToolDefinition,
  isServed,
  reserveServedTools,
  type NameReservations,
  type ServedProjection,
} from "./served";
import { buildServerSentBody, type OpenStream } from "./streams";

/** How long a Session Token with no open stream may be gone before the sweep forgets it. */
const SWEEP_INTERVAL = Duration.minutes(1);

/** The most MCP sessions one Session Token keeps. A harness that never sends DELETE loses its oldest. */
const MAX_MCP_SESSIONS_PER_TOKEN = 16;

/** The era of a client, chosen from its first message. */
type Era = "stateful" | "stateless";

/** One stateful MCP session, which `initialize` creates. */
interface McpSession {
  readonly id: string;
  /** The `tools/call` requests running now, by their JSON-RPC id, so `notifications/cancelled` can stop one. */
  readonly calls: Map<string, Fiber.Fiber<unknown, unknown>>;
}

/** What the gateway keeps for one Session Token. */
interface TokenState {
  readonly tokenHash: string;
  readonly sessionId: string;
  readonly mcpSessions: Map<string, McpSession>;
  readonly streams: Set<OpenStream>;
  /** The meaning of every name sent to this token. Replaced, never changed in place. */
  reservations: NameReservations;
  /** The fingerprint of what the token was last offered, or `undefined` before the first offer. */
  fingerprint: string | undefined;
  /** Serializes the changes of `reservations` and `fingerprint`. */
  readonly offering: Semaphore.Semaphore;
  /** When the Thread was last told about each refusal. */
  readonly warnings: Map<string, SeenWarning>;
  /** Serializes the claim of a warning and its write, so a burst of refusals writes one line. */
  readonly warning: Semaphore.Semaphore;
}

/** Who is calling: the Session Token the route resolved, and the session behind it. */
export interface McpCaller {
  readonly tokenHash: string;
  readonly actor: SessionActor;
}

/** What a call turned out to be, before anything is sent. */
type CallDecision =
  | { readonly _tag: "refused"; readonly refusal: Refusal }
  | {
      readonly _tag: "call";
      readonly serverId: string;
      readonly serverName: string;
      readonly tool: string;
    };

/** How an audited call ended. */
type CallOutcome =
  | { readonly _tag: "answered" }
  | { readonly _tag: "refused"; readonly reason: string }
  | { readonly _tag: "failed" };

const isPromotionRefusal = (error: unknown): error is ControllerSealed | PromotionInProgress =>
  error instanceof ControllerSealed || error instanceof PromotionInProgress;

const NO_STORE = { "cache-control": "no-store" } as const;

const respondJson = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: { ...NO_STORE, ...headers } });

const respondAccepted = () => HttpServerResponse.empty({ status: 202, headers: NO_STORE });

/** Answers a request the gateway cannot read or serve at the HTTP level, with a JSON-RPC error body. */
const respondRpcError = (
  status: number,
  code: number,
  message: string,
  id: RequestId | null = null,
) => respondJson(buildRpcError(id, code, message), status);

const respondSessionNotFound = () => respondRpcError(404, -32001, "Session not found");

const respondNotServing = () =>
  respondRpcError(
    503,
    McpSchema.INTERNAL_ERROR_CODE,
    "The controller is not serving right now. Try again once it is.",
  );

const toServerSentResponse = (body: Stream.Stream<Uint8Array>) =>
  HttpServerResponse.stream(body, {
    contentType: "text/event-stream",
    headers: NO_STORE,
  });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tokens = yield* SessionTokens;
  const sessions = yield* sessionRepository;
  const sessionService = yield* SessionService;
  const catalogue = yield* McpServerCalls;
  const audit = yield* AuditLog;
  const changes = yield* RecordChanges;
  const promotion = yield* PromotionState;

  const states = new Map<string, TokenState>();

  const stateOf = ({ tokenHash, actor }: McpCaller): TokenState => {
    const existing = states.get(tokenHash);
    if (existing !== undefined) return existing;
    const created: TokenState = {
      tokenHash,
      sessionId: actor.sessionId,
      mcpSessions: new Map(),
      streams: new Set(),
      reservations: new Map(),
      fingerprint: undefined,
      offering: Semaphore.makeUnsafe(1),
      warnings: new Map(),
      warning: Semaphore.makeUnsafe(1),
    };
    states.set(tokenHash, created);
    return created;
  };

  /** Reads the session's own list of servers, as the catalogue serves them now. */
  const readRecords = (sessionId: string): Effect.Effect<ReadonlyArray<ServedMcpServer>> =>
    Effect.orDie(
      Effect.flatMap(sessions.readMcpServers(sessionId), (listed) =>
        catalogue.readServedServers(listed.map((entry) => entry.mcpServerId)),
      ),
    );

  const holdsMcpUse = (actor: SessionActor): boolean => actor.profileGrants.includes("mcp.use");

  /** Builds what the session is served now, and logs tools that got no unique name. Sends and stores nothing. */
  const readProjection = (
    state: TokenState,
    actor: SessionActor,
  ): Effect.Effect<ServedProjection> =>
    Effect.gen(function* () {
      const projection = buildProjection({
        records: yield* readRecords(actor.sessionId),
        holdsMcpUse: holdsMcpUse(actor),
        reservations: state.reservations,
      });
      for (const { serverName, tool } of projection.leftOut) {
        yield* Effect.logWarning(
          `MCP gateway: the tool ${tool} of server ${serverName} got no unique name and is not offered`,
        );
      }
      return projection;
    });

  /**
   * Builds what the session is served and records it as sent: the names join
   * the token's reservations, and the fingerprint is what `list_changed`
   * compares against. One at a time per token.
   */
  const offerTools = (state: TokenState, actor: SessionActor): Effect.Effect<ServedProjection> =>
    state.offering.withPermits(1)(
      Effect.gen(function* () {
        const projection = yield* readProjection(state, actor);
        state.reservations = reserveServedTools(state.reservations, projection.tools);
        state.fingerprint = projection.fingerprint;
        return projection;
      }),
    );

  // -- Calls ----------------------------------------------------------------

  /** Reads what a call means and whether it may go on, without sending anything. */
  const decideCall = (
    state: TokenState,
    actor: SessionActor,
    toolName: string,
  ): Effect.Effect<CallDecision> =>
    Effect.gen(function* () {
      if (!holdsMcpUse(actor)) return { _tag: "refused", refusal: buildMissingGrantRefusal() };
      const records = yield* readRecords(actor.sessionId);
      // A name the gateway sent keeps its meaning. A name it never sent this
      // token, such as one a harness remembers across a controller restart, is
      // worked out from the list, because names are deterministic.
      const reserved = state.reservations.get(toolName);
      const meaning =
        reserved ??
        buildProjection({
          records,
          holdsMcpUse: true,
          reservations: state.reservations,
        }).tools.find((tool) => tool.name === toolName);
      if (meaning === undefined)
        return { _tag: "refused", refusal: buildUnknownToolRefusal(toolName) };
      const listed = records.find(({ server }) => server.name === meaning.serverName);
      if (listed === undefined) {
        return {
          _tag: "refused",
          refusal: buildNotInListRefusal(
            { id: meaning.serverId, name: meaning.serverName },
            meaning.serverName,
            meaning.tool,
          ),
        };
      }
      const { server } = listed;
      if (!isServed(listed))
        return { _tag: "refused", refusal: buildNotServedRefusal(server, meaning.tool) };
      if (!server.tools.some((tool) => tool.name === meaning.tool)) {
        return { _tag: "refused", refusal: buildToolGoneRefusal(server, meaning.tool) };
      }
      return { _tag: "call", serverId: server.id, serverName: server.name, tool: meaning.tool };
    });

  /**
   * Checks again, from the database and not from the token cache, right
   * before the catalogue sends a request upstream, that the call is still
   * allowed: the token still resolves, the profile still holds `mcp.use`, and
   * the server is still in the session's list.
   */
  const authorizeCall = (
    tokenHash: string,
    serverId: string,
  ): Effect.Effect<void, McpCallRefused> =>
    Effect.gen(function* () {
      const actor = yield* Effect.orDie(tokens.resolveUncached(tokenHash));
      if (Option.isNone(actor)) {
        return yield* new McpCallRefused({
          reason: "error",
          message: "This session has ended, so the MCP tool call was not sent.",
        });
      }
      if (!holdsMcpUse(actor.value)) {
        return yield* new McpCallRefused({
          reason: "missing-grant",
          message: buildMissingGrantRefusal().message,
        });
      }
      const listed = yield* Effect.orDie(sessions.readMcpServers(actor.value.sessionId));
      if (!listed.some((entry) => entry.mcpServerId === serverId)) {
        return yield* new McpCallRefused({
          reason: "not-in-list",
          message:
            "The MCP server is not in this Thread's list any more, so the tool call was not sent.",
        });
      }
    });

  /**
   * Tells the Thread about a refusal, unless it was told already in this turn
   * (or this minute, outside a turn). A failed write is logged and changes
   * nothing for the agent.
   */
  const warnThread = (state: TokenState, refusal: Refusal): Effect.Effect<void> =>
    absorbFailures(
      "Writing the warning about a refused MCP tool call failed",
      state.warning.withPermits(1)(
        Effect.gen(function* () {
          const turnId = yield* sessionService.readOpenTurnId(state.sessionId);
          if (!claimWarning(state.warnings, refusal, turnId, Date.now())) return;
          // `unknown-tool` names a reason only a tool name can have, so such a
          // line names no server.
          const server = refusal.reason === "unknown-tool" ? undefined : refusal.server;
          yield* sessionService.writeRuntimeWarning(
            state.sessionId,
            buildRefusalWarning(refusal),
            server === undefined || refusal.reason === "unknown-tool"
              ? undefined
              : [{ mcpServerId: server.id, reason: refusal.reason }],
          );
        }),
      ),
    );

  /** Writes the audit entry of one call. Never holds the arguments or the result. */
  const auditCall = (
    actor: SessionActor,
    server: { readonly id: string; readonly name: string } | undefined,
    tool: string | undefined,
    outcome: CallOutcome,
    durationMs: number,
  ): Effect.Effect<void> =>
    absorbFailures(
      "Writing the audit entry of an MCP tool call failed",
      withTransaction(
        sql,
        audit.append({
          kind: "mcpTool.called",
          actor: buildSessionStamp(actor.sessionId),
          payload: {
            sessionId: actor.sessionId,
            mcpServerId: server?.id ?? null,
            tool: tool ?? null,
            outcome: outcome._tag,
            ...(outcome._tag === "refused" ? { reason: outcome.reason } : {}),
            durationMs,
          },
        }),
      ),
    );

  /**
   * Handles a call the controller is frozen or sealed for: writes one line to
   * the controller's log and answers with the gate's message. Nothing is
   * written to the database, so there is no audit entry and no Thread line.
   * The one place that decision lives (spec 21 section 3.9).
   */
  const refuseWhileNotServing = (
    sessionId: string,
    decision: CallDecision,
    gate: ControllerSealed | PromotionInProgress,
  ): Effect.Effect<ToolResult> =>
    Effect.as(
      Effect.logInfo(
        `MCP gateway: refused a tool call while the controller does not serve. session ${sessionId}, ` +
          `server ${decision._tag === "call" ? decision.serverName : (decision.refusal.server?.name ?? "-")}, ` +
          `tool ${decision._tag === "call" ? decision.tool : "-"}, reason: ${gate.error.message}`,
      ),
      buildErrorResult(gate.error.message),
    );

  /**
   * Runs one `tools/call` for the session and returns its tool result. A
   * refusal is a tool result with `isError: true`. Never fails: a defect is
   * left to the caller.
   */
  const runToolCall = (
    state: TokenState,
    actor: SessionActor,
    call: { readonly name: string; readonly arguments: JsonObject | undefined },
  ): Effect.Effect<ToolResult> =>
    Effect.gen(function* () {
      const decision = yield* decideCall(state, actor, call.name);
      // Admitted, so that a freeze waits for the call and its audit entry, and
      // so that nothing here writes once the database stops accepting writes.
      return yield* promotion
        .admit(executeCall(state, actor, call, decision))
        .pipe(
          Effect.catchIf(isPromotionRefusal, (gate) =>
            refuseWhileNotServing(actor.sessionId, decision, gate),
          ),
        );
    });

  const executeCall = (
    state: TokenState,
    actor: SessionActor,
    call: { readonly name: string; readonly arguments: JsonObject | undefined },
    decision: CallDecision,
  ): Effect.Effect<ToolResult> => {
    const startedAt = Date.now();
    let server: { readonly id: string; readonly name: string } | undefined;
    let tool: string | undefined;
    // Whatever happens after the call is accepted, one entry is written: a
    // call that is interrupted or dies ends as `failed`.
    let outcome: CallOutcome = { _tag: "failed" };

    const refuse = (refusal: Refusal): Effect.Effect<ToolResult> => {
      server = refusal.server;
      tool = refusal.tool;
      outcome = { _tag: "refused", reason: refusal.reason };
      return Effect.as(warnThread(state, refusal), buildErrorResult(refusal.message));
    };

    const run =
      decision._tag === "refused"
        ? refuse(decision.refusal)
        : Effect.suspend(() => {
            server = { id: decision.serverId, name: decision.serverName };
            tool = decision.tool;
            return catalogue
              .callTool({
                upstreamScope: state.tokenHash,
                serverId: decision.serverId,
                tool: decision.tool,
                arguments: call.arguments,
                authorize: authorizeCall(state.tokenHash, decision.serverId),
              })
              .pipe(
                Effect.map((result): ToolResult => {
                  outcome = { _tag: "answered" };
                  return result as unknown as ToolResult;
                }),
                Effect.catchTag("McpCallRefused", (refused) =>
                  refuse({
                    reason: refused.reason,
                    server: { id: decision.serverId, name: decision.serverName },
                    tool: decision.tool,
                    message: refused.message,
                  }),
                ),
              );
          });

    return run.pipe(
      Effect.onExit(() =>
        Effect.uninterruptible(auditCall(actor, server, tool, outcome, Date.now() - startedAt)),
      ),
    );
  };

  // -- Streams and list changes ---------------------------------------------

  const registerStream = (state: TokenState) => (stream: OpenStream) =>
    Effect.sync(() => {
      state.streams.add(stream);
    });

  const unregisterStream = (state: TokenState) => (stream: OpenStream) =>
    Effect.sync(() => {
      state.streams.delete(stream);
    });

  const endStreams = (state: TokenState, only?: string): Effect.Effect<void> =>
    Effect.forEach(
      [...state.streams].filter((stream) => only === undefined || stream.mcpSessionId === only),
      (stream) => stream.end,
      { discard: true },
    );

  /** Forgets a Session Token that no longer resolves: ends its streams and calls, and closes its upstream sessions. */
  const forgetToken = (state: TokenState): Effect.Effect<void> =>
    Effect.gen(function* () {
      states.delete(state.tokenHash);
      yield* endStreams(state);
      yield* Effect.forEach(
        [...state.mcpSessions.values()].flatMap((session) => [...session.calls.values()]),
        (call) => Fiber.interrupt(call),
        { discard: true },
      );
      state.mcpSessions.clear();
      yield* catalogue.closeUpstreamScope(state.tokenHash);
    });

  /**
   * Brings one token in step with the database. A token that no longer
   * resolves is forgotten. Otherwise, when what the session is served has
   * changed since it was last offered, `list_changed` goes to its open
   * streams.
   */
  const reconcileToken = (state: TokenState): Effect.Effect<void> =>
    state.offering.withPermits(1)(
      Effect.gen(function* () {
        const actor = yield* Effect.orDie(tokens.resolveUncached(state.tokenHash));
        if (Option.isNone(actor)) return yield* forgetToken(state);
        const projection = yield* readProjection(state, actor.value);
        // A token that never listed has no fingerprint yet. Its open streams
        // are told too: the client may not have listed since the stream opened.
        const moved = state.fingerprint !== projection.fingerprint;
        state.fingerprint = projection.fingerprint;
        if (!moved) return;
        yield* Effect.forEach([...state.streams], (stream) => stream.notifyListChanged, {
          discard: true,
        });
      }),
    );

  /** Forgets a token that no longer resolves, whether or not it has a stream. */
  const forgetIfEnded = (state: TokenState): Effect.Effect<void> =>
    state.offering.withPermits(1)(
      Effect.gen(function* () {
        const actor = yield* Effect.orDie(tokens.resolveUncached(state.tokenHash));
        if (Option.isNone(actor)) yield* forgetToken(state);
      }),
    );

  const endAllStreams: Effect.Effect<void> = Effect.suspend(() =>
    Effect.forEach([...states.values()], (state) => endStreams(state), { discard: true }),
  );

  /**
   * Follows the committed changes that alter what a session is served, for the
   * life of the fiber: a session's list or end, a server's switch, status or
   * tools, and a profile's grants. Subscribes before it reads anything, so no
   * change is lost.
   */
  const followChanges = Effect.gen(function* () {
    const queue = yield* changes.subscribe(["session", "mcpServer", PROFILE_GRANTS_TOPIC]);
    while (true) {
      const batch = yield* Queue.takeAll(queue);
      // A server or a profile can be in any session's list, so those changes
      // look at every token. A session change looks at that session's own.
      const everyToken = batch.some((change) => change.topic !== "session");
      const changedSessions = new Set(batch.map((change) => change.id));
      const affected = [...states.values()].filter(
        (state) => everyToken || changedSessions.has(state.sessionId),
      );
      yield* Effect.forEach(
        affected,
        (state) =>
          absorbFailures("Following a change for the MCP Gateway failed", reconcileToken(state)),
        { discard: true },
      );
    }
  });

  /** Forgets, once a minute, every token that ended, because no change may have told the gateway. */
  const sweepEndedTokens = Effect.repeat(
    Effect.suspend(() =>
      Effect.forEach(
        [...states.values()],
        (state) => absorbFailures("Sweeping the MCP Gateway's tokens failed", forgetIfEnded(state)),
        { discard: true },
      ),
    ),
    Schedule.spaced(SWEEP_INTERVAL),
  );

  /** Ends every stream whenever the controller freezes or seals, because nothing may be sent then. */
  const endStreamsWhenNotServing = promotion.phaseChanges.pipe(
    Stream.filter((phase) => phase._tag !== "Serving"),
    Stream.runForEach(() => endAllStreams),
  );

  yield* Effect.addFinalizer(() => endAllStreams);

  // -- HTTP -------------------------------------------------------------------

  const isServing: Effect.Effect<boolean> = Effect.map(
    promotion.phase,
    (phase) => phase._tag === "Serving",
  );

  const initialize = (
    caller: McpCaller,
    state: TokenState,
    id: RequestId,
    params: JsonObject,
  ): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
    Effect.gen(function* () {
      const revision = negotiateStatefulRevision(params["protocolVersion"]);
      const projection = yield* readProjection(state, caller.actor);
      const session: McpSession = { id: crypto.randomUUID(), calls: new Map() };
      // A harness that never ends its MCP sessions loses the oldest one.
      if (state.mcpSessions.size >= MAX_MCP_SESSIONS_PER_TOKEN) {
        const [oldest] = state.mcpSessions.keys();
        if (oldest !== undefined) yield* endMcpSession(state, oldest);
      }
      state.mcpSessions.set(session.id, session);
      return respondJson(
        buildRpcResult(id, buildInitializeResult(revision, projection.instructions)),
        200,
        { "mcp-session-id": session.id },
      );
    });

  /** Ends one MCP session: its streams close and its running calls stop. */
  const endMcpSession = (state: TokenState, mcpSessionId: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      const session = state.mcpSessions.get(mcpSessionId);
      if (session === undefined) return;
      state.mcpSessions.delete(mcpSessionId);
      yield* endStreams(state, mcpSessionId);
      yield* Effect.forEach([...session.calls.values()], (call) => Fiber.interrupt(call), {
        discard: true,
      });
    });

  const respondToolsList = (era: Era, state: TokenState, actor: SessionActor, id: RequestId) =>
    Effect.map(offerTools(state, actor), (projection) =>
      respondJson(
        buildRpcResult(id, buildToolsListResult(era, projection.tools.map(buildToolDefinition))),
      ),
    );

  const respondToolsCall = (
    era: Era,
    state: TokenState,
    actor: SessionActor,
    id: RequestId,
    params: JsonObject,
    session: McpSession | undefined,
  ): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
    Effect.gen(function* () {
      const name = params["name"];
      const args = params["arguments"];
      if (
        typeof name !== "string" ||
        (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args)))
      ) {
        return respondJson(
          buildRpcError(
            id,
            McpSchema.INVALID_PARAMS_ERROR_CODE,
            "tools/call needs a tool name and, optionally, an object of arguments",
          ),
        );
      }
      const running = yield* Effect.forkChild(
        runToolCall(state, actor, { name, arguments: args as JsonObject | undefined }),
      );
      const key = JSON.stringify(id);
      session?.calls.set(key, running);
      const exit = yield* Fiber.await(running).pipe(
        Effect.ensuring(Effect.sync(() => session?.calls.delete(key))),
      );
      if (Exit.isSuccess(exit)) {
        return respondJson(buildRpcResult(id, buildToolCallResult(era, exit.value)));
      }
      // Only `notifications/cancelled` or the end of the MCP session interrupts a running call.
      if (Cause.hasInterrupts(exit.cause)) {
        return respondJson(
          buildRpcError(id, REQUEST_CANCELLED_ERROR_CODE, "The request was cancelled"),
        );
      }
      return yield* Effect.failCause(exit.cause);
    });

  const cancelCall = (session: McpSession | undefined, params: JsonObject) => {
    const requestId = params["requestId"];
    const running = session?.calls.get(JSON.stringify(requestId));
    return running === undefined ? Effect.void : Effect.asVoid(Fiber.interrupt(running));
  };

  const listen = (
    state: TokenState,
    id: RequestId,
  ): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
    Effect.gen(function* () {
      if (!(yield* isServing)) return respondNotServing();
      return toServerSentResponse(
        buildServerSentBody({
          mcpSessionId: undefined,
          listChanged: buildSubscribedListChangedNotification(id),
          opening: [buildSubscriptionAcknowledgement(id)],
          closing: buildRpcResult(id, buildListenResult(id)),
          register: registerStream(state),
          unregister: unregisterStream(state),
        }),
      );
    });

  /** Answers one request or notification of a client whose era is known. */
  const dispatch = (
    era: Era,
    caller: McpCaller,
    state: TokenState,
    session: McpSession | undefined,
    message: Exclude<IncomingMessage, { readonly _tag: "batch" | "invalid" | "response" }>,
  ): Effect.Effect<HttpServerResponse.HttpServerResponse> => {
    if (message._tag === "notification") {
      return message.method === "notifications/cancelled"
        ? Effect.as(cancelCall(session, message.params), respondAccepted())
        : Effect.succeed(respondAccepted());
    }
    const { id, method, params } = message;
    switch (method) {
      case "ping":
        return Effect.succeed(
          era === "stateful"
            ? respondJson(buildRpcResult(id, {}))
            : respondJson(buildMethodNotFound(id, method)),
        );
      case "tools/list":
        return respondToolsList(era, state, caller.actor, id);
      case "tools/call":
        return respondToolsCall(era, state, caller.actor, id, params, session);
      case "server/discover":
        return era === "stateless"
          ? Effect.map(readProjection(state, caller.actor), (projection) =>
              respondJson(buildRpcResult(id, buildDiscoverResult(projection.instructions))),
            )
          : Effect.succeed(respondJson(buildMethodNotFound(id, method)));
      case "subscriptions/listen":
        return era === "stateless"
          ? listen(state, id)
          : Effect.succeed(respondJson(buildMethodNotFound(id, method)));
      default:
        return Effect.succeed(respondJson(buildMethodNotFound(id, method)));
    }
  };

  /** Chooses the era of a message from its first words, and answers it. */
  const handleMessage = (
    request: HttpServerRequest.HttpServerRequest,
    caller: McpCaller,
    message: Exclude<IncomingMessage, { readonly _tag: "batch" | "invalid" | "response" }>,
  ): Effect.Effect<HttpServerResponse.HttpServerResponse> => {
    const state = stateOf(caller);
    if (message._tag === "request" && message.method === "initialize") {
      return initialize(caller, state, message.id, message.params);
    }
    const idOrNull = message._tag === "request" ? message.id : null;
    const sessionId = request.headers[SESSION_ID_HEADER];
    if (sessionId !== undefined) {
      const session = state.mcpSessions.get(sessionId);
      return session === undefined
        ? Effect.succeed(respondSessionNotFound())
        : dispatch("stateful", caller, state, session, message);
    }
    const revision = readStatelessRevision(message.params);
    if (
      revision === STATELESS_REVISION ||
      (revision === undefined && message._tag === "request" && message.method === "server/discover")
    ) {
      return dispatch("stateless", caller, state, undefined, message);
    }
    if (revision !== undefined) {
      return Effect.succeed(respondJson(buildUnsupportedRevision(idOrNull, revision), 400));
    }
    // A notification with neither a session nor a revision has nothing to act on.
    return Effect.succeed(
      message._tag === "notification"
        ? respondAccepted()
        : respondRpcError(
            400,
            McpSchema.INVALID_REQUEST_ERROR_CODE,
            "Send initialize first and then name its session in the Mcp-Session-Id header, or use protocol revision 2026-07-28",
            idOrNull,
          ),
    );
  };

  /** Reads the body of a POST, refusing one over the limit before it is parsed. */
  const readBody = (
    request: HttpServerRequest.HttpServerRequest,
  ): Effect.Effect<string, HttpServerResponse.HttpServerResponse> => {
    const tooLarge = Effect.fail(
      respondRpcError(413, McpSchema.INVALID_REQUEST_ERROR_CODE, "The request body is over 1 MiB"),
    );
    if (Number(request.headers["content-length"] ?? 0) > MAX_REQUEST_BODY_BYTES) return tooLarge;
    return request.text.pipe(
      Effect.mapError(() =>
        respondRpcError(400, McpSchema.PARSE_ERROR_CODE, "The request body could not be read"),
      ),
      Effect.flatMap((text) =>
        Buffer.byteLength(text) > MAX_REQUEST_BODY_BYTES ? tooLarge : Effect.succeed(text),
      ),
    );
  };

  const handlePost = (
    request: HttpServerRequest.HttpServerRequest,
    caller: McpCaller,
  ): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
    Effect.gen(function* () {
      const text = yield* readBody(request);
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return respondRpcError(
          400,
          McpSchema.PARSE_ERROR_CODE,
          "The request body is not valid JSON",
        );
      }
      const message = classifyMessage(json);
      switch (message._tag) {
        case "batch":
          return respondRpcError(
            400,
            McpSchema.INVALID_REQUEST_ERROR_CODE,
            "JSON-RPC batches are not supported. Send one message per request",
          );
        case "invalid":
          return respondRpcError(
            400,
            McpSchema.INVALID_REQUEST_ERROR_CODE,
            "The request body is not a JSON-RPC 2.0 message",
          );
        case "response":
          return respondAccepted();
        default:
          return yield* handleMessage(request, caller, message);
      }
    }).pipe(Effect.catch((response) => Effect.succeed(response)));

  const handleGet = (
    request: HttpServerRequest.HttpServerRequest,
    caller: McpCaller,
  ): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
    Effect.gen(function* () {
      const state = stateOf(caller);
      const sessionId = request.headers[SESSION_ID_HEADER];
      const session = sessionId === undefined ? undefined : state.mcpSessions.get(sessionId);
      if (sessionId === undefined) {
        return respondRpcError(
          400,
          McpSchema.INVALID_REQUEST_ERROR_CODE,
          "The Mcp-Session-Id header is required",
        );
      }
      if (session === undefined) return respondSessionNotFound();
      if (!(request.headers["accept"] ?? "").includes("text/event-stream")) {
        return respondRpcError(
          406,
          McpSchema.INVALID_REQUEST_ERROR_CODE,
          "The GET stream needs Accept: text/event-stream",
        );
      }
      if (!(yield* isServing)) return respondNotServing();
      // One stream per MCP session: a harness that opens another has dropped the old one.
      yield* endStreams(state, session.id);
      return toServerSentResponse(
        buildServerSentBody({
          mcpSessionId: session.id,
          listChanged: buildListChangedNotification(),
          opening: [],
          register: registerStream(state),
          unregister: unregisterStream(state),
        }),
      );
    });

  const handleDelete = (
    request: HttpServerRequest.HttpServerRequest,
    caller: McpCaller,
  ): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
    Effect.gen(function* () {
      const state = stateOf(caller);
      const sessionId = request.headers[SESSION_ID_HEADER];
      if (sessionId === undefined) {
        return respondRpcError(
          400,
          McpSchema.INVALID_REQUEST_ERROR_CODE,
          "The Mcp-Session-Id header is required",
        );
      }
      if (!state.mcpSessions.has(sessionId)) return respondSessionNotFound();
      yield* endMcpSession(state, sessionId);
      return HttpServerResponse.empty({ status: 204, headers: NO_STORE });
    });

  return {
    /**
     * Answers one request of the route: a POST, a GET or a DELETE from a
     * caller whose Session Token the route has resolved. Never fails. A
     * defect is logged and answered with a bare JSON-RPC internal error, so no
     * detail reaches the harness.
     */
    handle: (
      request: HttpServerRequest.HttpServerRequest,
      caller: McpCaller,
    ): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
      (request.method === "POST"
        ? handlePost(request, caller)
        : request.method === "GET"
          ? handleGet(request, caller)
          : handleDelete(request, caller)
      ).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.failCause(cause)
            : Effect.as(
                Effect.logError("The MCP Gateway failed to answer a request", cause),
                respondRpcError(500, McpSchema.INTERNAL_ERROR_CODE, "The gateway failed"),
              ),
        ),
      ),

    /**
     * Follows the changes that alter what a session is served, sweeps the
     * tokens that ended, and ends every stream when the controller freezes or
     * seals. Runs for the life of the fiber and never returns.
     */
    follow: Effect.scoped(
      Effect.all([followChanges, sweepEndedTokens, endStreamsWhenNotServing], {
        concurrency: "unbounded",
        discard: true,
      }),
    ) as Effect.Effect<never, never, never>,
  };
});

/** The tool result the gateway sends for a call: the server's answer, or a refusal. */
interface ToolResult {
  readonly content: ReadonlyArray<unknown>;
  readonly isError?: boolean;
  readonly [key: string]: unknown;
}

const buildErrorResult = (message: string): ToolResult => ({
  content: [{ type: "text", text: message }],
  isError: true,
});

/** The MCP Gateway: answers a session's harness and follows what the session is served. */
export class McpGateway extends Context.Service<McpGateway, Effect.Success<typeof make>>()(
  "hercule/controller/mcp-gateway/McpGateway",
) {}

export const McpGatewayLayer = Layer.effect(McpGateway)(make);
