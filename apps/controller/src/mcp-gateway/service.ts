/**
 * The MCP Gateway (spec 21 section 3): the one MCP endpoint every session's
 * harness is given, in place of the servers themselves. It knows the session
 * from its Session Token, serves the tools of the servers in that session's
 * list under its own names, and forwards each call through the catalogue.
 *
 * This module is the wire endpoint: it reads a request, checks it against the
 * protocol, and answers it. The route (`http/mcp.ts`) checks the method, the
 * `Origin` header and the bearer token, and hands the request to `handle`.
 * What the gateway keeps per Session Token lives in `tokens.ts`, and what it
 * does with a `tools/call` in `call-policy.ts`.
 */
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { McpSchema } from "effect/ai";
import type { SessionActor } from "../actor";
import { makeCallPolicy } from "./call-policy";
import {
  buildDiscoverResult,
  buildInitializeResult,
  buildListChangedNotification,
  buildListenResult,
  buildMethodNotFound,
  buildRefusalBody,
  buildRpcError,
  buildRpcResult,
  buildSubscribedListChangedNotification,
  buildSubscriptionAcknowledgement,
  buildToolCallResult,
  buildToolsListResult,
  checkSessionVersionHeader,
  checkStatelessMetadata,
  classifyMessage,
  isStatelessMessage,
  MAX_REQUEST_BODY_BYTES,
  negotiateStatefulRevision,
  readListenRequest,
  readStatelessRevision,
  REQUEST_CANCELLED_ERROR_CODE,
  SESSION_ID_HEADER,
  type HeaderMap,
  type IncomingMessage,
  type JsonObject,
  type RequestId,
  type RequestRefusal,
} from "./protocol";
import { makeFreshReads } from "./reads";
import { buildServedInstructions, buildToolDefinition, projectTools } from "./served";
import { buildServerSentBody } from "./streams";
import {
  cancelCall,
  makeTokenStates,
  type McpCaller,
  type McpSession,
  type TokenState,
} from "./tokens";

/** The era of a client, chosen from its first message. */
type Era = "stateful" | "stateless";

/** A message the gateway answers itself: a request or a notification. */
type DispatchableMessage = Exclude<
  IncomingMessage,
  { readonly _tag: "batch" | "invalid" | "response" }
>;

const NO_STORE = { "cache-control": "no-store" } as const;

const respondJson = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: { ...NO_STORE, ...headers } });

const respondAccepted = () => HttpServerResponse.empty({ status: 202, headers: NO_STORE });

/**
 * Builds the 401 for a request without the Session Token of a running session.
 * `WWW-Authenticate` carries no `resource_metadata`, so no harness starts an
 * OAuth sign-in.
 */
export const buildUnauthorizedResponse = (): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.text("The MCP gateway needs the Session Token of a running session", {
    status: 401,
    headers: { ...NO_STORE, "www-authenticate": "Bearer" },
  });

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

const respondRefusal = (refusal: RequestRefusal, id: RequestId | null) =>
  respondJson(buildRefusalBody(id, refusal), refusal.status);

const toServerSentResponse = (body: Stream.Stream<Uint8Array>) =>
  HttpServerResponse.stream(body, {
    contentType: "text/event-stream",
    headers: NO_STORE,
  });

/**
 * Reads the body of a POST as it arrives and refuses it once it passes the
 * limit, so a chunked body with no `Content-Length` is never buffered past
 * it. Fails with the response to send.
 */
const readBody = (
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<string, HttpServerResponse.HttpServerResponse> => {
  const tooLarge = respondRpcError(
    413,
    McpSchema.INVALID_REQUEST_ERROR_CODE,
    "The request body is over 1 MiB",
  );
  if (Number(request.headers["content-length"] ?? 0) > MAX_REQUEST_BODY_BYTES) {
    return Effect.fail(tooLarge);
  }
  return Effect.gen(function* () {
    const chunks: Array<Uint8Array> = [];
    let total = 0;
    yield* request.stream.pipe(
      Stream.mapError(() =>
        respondRpcError(400, McpSchema.PARSE_ERROR_CODE, "The request body could not be read"),
      ),
      Stream.runForEach((chunk) => {
        total += chunk.byteLength;
        if (total > MAX_REQUEST_BODY_BYTES) return Effect.fail(tooLarge);
        chunks.push(chunk);
        return Effect.void;
      }),
    );
    return new TextDecoder().decode(Buffer.concat(chunks));
  });
};

/**
 * Admits a request to the stateful MCP session its `Mcp-Session-Id` header
 * names. Every kind of request goes through this one check: a request, a
 * notification, a response, `initialize`, GET and DELETE. Fails with the
 * response to send when the header names no session of this token (404, also
 * for the session of another token), or when the `MCP-Protocol-Version`
 * header disagrees with the revision the session negotiated. Succeeds with the
 * session, or with `undefined` when the request names none.
 */
const admitMcpSession = (
  request: HttpServerRequest.HttpServerRequest,
  state: TokenState,
  requestId: RequestId | null,
): Effect.Effect<McpSession | undefined, HttpServerResponse.HttpServerResponse> => {
  const sessionId = request.headers[SESSION_ID_HEADER];
  if (sessionId === undefined) return Effect.succeed(undefined);
  const session = state.mcpSessions.get(sessionId);
  if (session === undefined) return Effect.fail(respondSessionNotFound());
  const refusal = checkSessionVersionHeader(
    request.headers["mcp-protocol-version"],
    session.revision,
  );
  return refusal === undefined
    ? Effect.succeed(session)
    : Effect.fail(respondRefusal(refusal, requestId));
};

/** Like `admitMcpSession`, for GET and DELETE, which mean nothing without a session. */
const admitRequiredMcpSession = (
  request: HttpServerRequest.HttpServerRequest,
  state: TokenState,
): Effect.Effect<McpSession, HttpServerResponse.HttpServerResponse> =>
  Effect.flatMap(admitMcpSession(request, state, null), (session) =>
    session === undefined
      ? Effect.fail(
          respondRpcError(
            400,
            McpSchema.INVALID_REQUEST_ERROR_CODE,
            "The Mcp-Session-Id header is required",
          ),
        )
      : Effect.succeed(session),
  );

const make = Effect.gen(function* () {
  const reads = yield* makeFreshReads;
  const tokenStates = yield* makeTokenStates;
  const callPolicy = yield* makeCallPolicy;

  /** Reads the instructions the session gets. They need the served servers but no tool names. */
  const readInstructions = (actor: SessionActor): Effect.Effect<string> =>
    Effect.map(reads.readServed(actor), (served) => buildServedInstructions(served, actor));

  const initialize = (
    caller: McpCaller,
    state: TokenState,
    id: RequestId,
    params: JsonObject,
  ): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
    Effect.gen(function* () {
      const revision = negotiateStatefulRevision(params["protocolVersion"]);
      const instructions = yield* readInstructions(caller.actor);
      const session = yield* tokenStates.openMcpSession(state, revision);
      return respondJson(buildRpcResult(id, buildInitializeResult(revision, instructions)), 200, {
        "mcp-session-id": session.id,
      });
    });

  /** Answers `tools/list` and records the names it sends: only these names may be called. */
  const respondToolsList = (era: Era, state: TokenState, actor: SessionActor, id: RequestId) =>
    Effect.gen(function* () {
      const { tools, leftOut } = projectTools(yield* reads.readServed(actor), state.names);
      // Nothing waits between naming the tools and recording the names, so two
      // lists at once cannot give one name to two tools.
      state.names.record(tools);
      for (const { serverName, tool } of leftOut) {
        yield* Effect.logWarning(
          `MCP gateway: the tool ${tool} of server ${serverName} got no unique name and is not offered`,
        );
      }
      return respondJson(
        buildRpcResult(id, buildToolsListResult(era, tools.map(buildToolDefinition))),
      );
    });

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
      const exit = yield* tokenStates.runCall(
        state,
        session,
        id,
        callPolicy.runToolCall(state, actor, { name, arguments: args as JsonObject | undefined }),
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

  /** Opens `subscriptions/listen`: refuses invalid parameters, then streams the notifications it asked for. */
  const listen = (
    state: TokenState,
    id: RequestId,
    params: JsonObject,
  ): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
    Effect.gen(function* () {
      const honored = readListenRequest(params);
      if (honored === undefined) {
        return respondRpcError(
          400,
          McpSchema.INVALID_PARAMS_ERROR_CODE,
          "subscriptions/listen needs the request metadata and the notifications it asks for",
          id,
        );
      }
      if (!(yield* tokenStates.isServing)) return respondNotServing();
      return toServerSentResponse(
        buildServerSentBody({
          mcpSessionId: undefined,
          listChanged: honored.toolsListChanged
            ? buildSubscribedListChangedNotification(id)
            : undefined,
          opening: [buildSubscriptionAcknowledgement(id, honored)],
          closing: buildRpcResult(id, buildListenResult(id)),
          ...tokenStates.buildStreamHooks(state),
        }),
      );
    });

  /** Answers one request or notification of a client whose era is known. */
  const dispatch = (
    era: Era,
    caller: McpCaller,
    state: TokenState,
    session: McpSession | undefined,
    message: DispatchableMessage,
  ): Effect.Effect<HttpServerResponse.HttpServerResponse> => {
    if (message._tag === "notification") {
      return message.method === "notifications/cancelled"
        ? Effect.as(cancelCall(session, message.params["requestId"]), respondAccepted())
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
          ? Effect.map(readInstructions(caller.actor), (instructions) =>
              respondJson(buildRpcResult(id, buildDiscoverResult(instructions))),
            )
          : Effect.succeed(respondJson(buildMethodNotFound(id, method)));
      case "subscriptions/listen":
        return era === "stateless"
          ? listen(state, id, params)
          : Effect.succeed(respondJson(buildMethodNotFound(id, method)));
      default:
        return Effect.succeed(respondJson(buildMethodNotFound(id, method)));
    }
  };

  /**
   * Chooses the era of a message from its first words, checks its HTTP headers
   * against that era, and answers it. `session` is the MCP session the
   * `Mcp-Session-Id` header named, which `admitMcpSession` has already admitted.
   */
  const handleMessage = (
    request: HttpServerRequest.HttpServerRequest,
    caller: McpCaller,
    state: TokenState,
    session: McpSession | undefined,
    message: DispatchableMessage,
  ): Effect.Effect<HttpServerResponse.HttpServerResponse> => {
    const idOrNull = message._tag === "request" ? message.id : null;
    const headers: HeaderMap = request.headers;
    if (message._tag === "request" && message.method === "initialize") {
      return initialize(caller, state, message.id, message.params);
    }
    if (session !== undefined) return dispatch("stateful", caller, state, session, message);
    // A `server/discover` that names no revision at all is how a client asks
    // which revisions the gateway speaks, so it is answered, not checked.
    const asksWhichRevisions =
      message._tag === "request" &&
      message.method === "server/discover" &&
      readStatelessRevision(message.params) === undefined &&
      headers["mcp-protocol-version"] === undefined;
    if (asksWhichRevisions) return dispatch("stateless", caller, state, undefined, message);
    if (isStatelessMessage(headers, message.params)) {
      const refusal = checkStatelessMetadata(headers, message.method, message.params);
      return refusal === undefined
        ? dispatch("stateless", caller, state, undefined, message)
        : Effect.succeed(respondRefusal(refusal, idOrNull));
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

  /** Answers a POST. Fails with the response to send when the request is refused before it is dispatched. */
  const handlePost = (
    request: HttpServerRequest.HttpServerRequest,
    routedCaller: McpCaller,
  ): Effect.Effect<HttpServerResponse.HttpServerResponse, HttpServerResponse.HttpServerResponse> =>
    Effect.gen(function* () {
      const text = yield* readBody(request);
      // The body may have taken a while to arrive. The Thread can have ended,
      // resumed or lost `mcp.use` since the route resolved the token, so the
      // token and its profile are read again, and that reading serves the request.
      const actor = yield* reads.resolveActor(routedCaller.tokenHash);
      if (Option.isNone(actor)) return buildUnauthorizedResponse();
      const caller: McpCaller = { tokenHash: routedCaller.tokenHash, actor: actor.value };
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
        default: {
          const state = tokenStates.findOrCreateState(caller);
          const session = yield* admitMcpSession(
            request,
            state,
            message._tag === "request" ? message.id : null,
          );
          if (message._tag === "response") return respondAccepted();
          return yield* handleMessage(request, caller, state, session, message);
        }
      }
    });

  /** Answers a GET by opening the server-sent event stream of an MCP session. */
  const handleGet = (
    request: HttpServerRequest.HttpServerRequest,
    caller: McpCaller,
  ): Effect.Effect<HttpServerResponse.HttpServerResponse, HttpServerResponse.HttpServerResponse> =>
    Effect.gen(function* () {
      const state = tokenStates.findOrCreateState(caller);
      const session = yield* admitRequiredMcpSession(request, state);
      if (!(request.headers["accept"] ?? "").includes("text/event-stream")) {
        return respondRpcError(
          406,
          McpSchema.INVALID_REQUEST_ERROR_CODE,
          "The GET stream needs Accept: text/event-stream",
        );
      }
      if (!(yield* tokenStates.isServing)) return respondNotServing();
      return toServerSentResponse(
        buildServerSentBody({
          mcpSessionId: session.id,
          listChanged: buildListChangedNotification(),
          opening: [],
          ...tokenStates.buildStreamHooks(state),
        }),
      );
    });

  /** Answers a DELETE by ending the MCP session it names, and nothing else of the token. */
  const handleDelete = (
    request: HttpServerRequest.HttpServerRequest,
    caller: McpCaller,
  ): Effect.Effect<HttpServerResponse.HttpServerResponse, HttpServerResponse.HttpServerResponse> =>
    Effect.gen(function* () {
      const state = tokenStates.findOrCreateState(caller);
      const session = yield* admitRequiredMcpSession(request, state);
      yield* tokenStates.endMcpSession(state, session.id);
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
        Effect.catch((response) => Effect.succeed(response)),
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
     * Ends every open stream and refuses new ones. The controller calls it
     * when it is asked to stop, before the listener starts to drain, because
     * the listener waits for every open response and these never end by
     * themselves.
     */
    closeStreams: tokenStates.closeStreams,

    /**
     * Follows the changes that alter what a session is served, sweeps the
     * tokens that ended, and ends every stream when the controller freezes or
     * seals. Runs for the life of the fiber and never returns.
     */
    follow: tokenStates.follow,
  };
});

/** The MCP Gateway: answers a session's harness and follows what the session is served. */
export class McpGateway extends Context.Service<McpGateway, Effect.Success<typeof make>>()(
  "hercule/controller/mcp-gateway/McpGateway",
) {}

export const McpGatewayLayer = Layer.effect(McpGateway)(make);
