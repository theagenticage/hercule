/**
 * The MCP Gateway's route (spec 21 section 3.1, spec 11 section 1.4): `POST`,
 * `GET` and `DELETE /mcp`. It is not derived from the contract, serves no
 * operation of it, and is matched before everything else in the request's
 * path: CORS (no browser may call it), the error envelope, the body limit,
 * the compression of answers (which would hold a stream back) and the
 * promotion and pre-setup gates (the gateway admits its own work, so that
 * `tools/list` still answers while the controller is frozen).
 *
 * This module answers the HTTP-level refusals, all before any JSON is read,
 * and hands the rest to the gateway in one line:
 *
 * - any `Origin` header, an empty one too: 403;
 * - any method but POST, GET and DELETE: 405;
 * - a bearer that is not the token of a live session: 401 with
 *   `WWW-Authenticate: Bearer` and no `resource_metadata`, so no harness
 *   starts an OAuth sign-in. A user credential, an API key and no token at all
 *   are refused the same way. The token is never logged.
 */
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { hashToken } from "../credentials";
import { buildUnauthorizedResponse, McpGateway } from "../mcp-gateway";
import { SessionTokens } from "../permissions";
import { readBearerToken } from "./bearer";

/** The route's path. Only this exact path is the gateway's. */
export const MCP_PATH = "/mcp";

const ALLOWED_METHODS = "GET, POST, DELETE";

const NO_STORE = { "cache-control": "no-store" } as const;

/** Returns whether the request is for the gateway, ignoring its query string. */
const isMcpRequest = (request: HttpServerRequest.HttpServerRequest): boolean => {
  const end = request.url.search(/[?#]/);
  return (end === -1 ? request.url : request.url.slice(0, end)) === MCP_PATH;
};

const refuse = (status: number, text: string, headers: Record<string, string> = {}) =>
  HttpServerResponse.text(text, { status, headers: { ...NO_STORE, ...headers } });

/**
 * Answers a request for `/mcp`: refuses it at the HTTP level, or hands it to
 * the gateway with the session its bearer token belongs to.
 */
const answerMcpRequest = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (request.headers["origin"] !== undefined) {
    return refuse(403, "The MCP gateway does not serve browsers");
  }
  if (request.method !== "POST" && request.method !== "GET" && request.method !== "DELETE") {
    return refuse(405, `Use ${ALLOWED_METHODS}`, { allow: ALLOWED_METHODS });
  }
  const bearer = readBearerToken(request);
  const tokenHash = bearer === undefined ? undefined : hashToken(bearer);
  const tokens = yield* SessionTokens;
  const actor =
    tokenHash === undefined ? Option.none() : yield* Effect.orDie(tokens.resolve(tokenHash));
  if (tokenHash === undefined || Option.isNone(actor)) return buildUnauthorizedResponse();
  return yield* (yield* McpGateway).handle(request, { tokenHash, actor: actor.value });
}).pipe(
  // The route sits outside the error envelope, so a defect must not escape as one.
  Effect.catchCause((cause) =>
    Cause.hasInterrupts(cause)
      ? Effect.failCause(cause)
      : Effect.as(
          Effect.logError("A request to the MCP gateway failed", cause),
          refuse(500, "The MCP gateway failed"),
        ),
  ),
);

/**
 * Ends the gateway's open streams and refuses new ones. The controller runs
 * it when it is asked to stop, before the listener drains: the listener
 * waits for every open response, and a gateway stream never ends by itself.
 */
export const closeMcpStreams: Effect.Effect<void, never, McpGateway> = Effect.flatMap(
  McpGateway,
  (gateway) => gateway.closeStreams,
);

/**
 * Wraps `app` so that a request for `/mcp` goes to the gateway and every other
 * request to `app`.
 *
 * The server runs a request uninterruptibly, and the router makes only the
 * handlers it owns interruptible. This route sits outside the router, so it
 * makes itself interruptible. Without that, a client that hangs up, which is
 * how a `2026-07-28` client cancels a call, would not stop the call.
 */
export const withMcpRoute = <E, R>(
  app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  E,
  R | HttpServerRequest.HttpServerRequest | McpGateway | SessionTokens
> =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    return yield* isMcpRequest(request) ? Effect.interruptible(answerMcpRequest) : app;
  });
