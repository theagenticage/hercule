/**
 * CORS for the desktop app. The controller lets exactly one other origin read
 * its responses: the desktop app's page, at `app://hercule` (spec 13 §1).
 *
 * The desktop app's page is not served by the controller, so the browser
 * engine lets the page read a response only when the response names the
 * page's origin. Every request that carries the bearer token sends a header a
 * page may not send freely, so the browser first asks for permission with a
 * preflight: an `OPTIONS` request that carries the method it wants to use.
 *
 * Effect's own `HttpMiddleware.cors` is not used, because it breaks the "one
 * origin" rule in two ways. Given one allowed origin, it names that origin on
 * every response, whatever origin the request came from. And it answers every
 * `OPTIONS` request, whoever sent it.
 *
 * CORS is not authentication. It decides only whether a page may read a
 * response; the operations still require the bearer token.
 */
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { ALL_OPERATIONS, DESKTOP_APP_ORIGIN } from "@hercule/contract";

/**
 * The methods the public API uses, each once, sorted. It is built from the
 * operation table, so an operation with a new method is allowed with no
 * change here.
 */
const ALLOWED_METHODS = [...new Set(ALL_OPERATIONS.map((operation) => operation.method))]
  .sort()
  .join(", ");

/**
 * The request headers the client sends that a page may not send without
 * asking: the bearer token and the JSON body's content type.
 */
const ALLOWED_HEADERS = "authorization, content-type";

/**
 * How long the browser may reuse a preflight's answer, in seconds. Two hours
 * is the most Chromium accepts, so the longest value saves the most repeat
 * preflights.
 */
const PREFLIGHT_MAX_AGE_SECONDS = "7200";

/** Checks whether a request is a browser's preflight, which asks whether a method may be used. */
const isPreflight = (request: HttpServerRequest.HttpServerRequest): boolean =>
  request.method === "OPTIONS" && request.headers["access-control-request-method"] !== undefined;

/**
 * Returns the response with `origin` added to its `vary` header. The names
 * already listed are kept, so a cache still varies on them too, and `origin`
 * is not added twice.
 */
const addOriginToVary = (
  response: HttpServerResponse.HttpServerResponse,
): HttpServerResponse.HttpServerResponse => {
  const vary = response.headers.vary;
  if (vary === undefined) return HttpServerResponse.setHeader(response, "vary", "origin");
  const listed = vary.split(",").some((name) => name.trim().toLowerCase() === "origin");
  return listed ? response : HttpServerResponse.setHeader(response, "vary", `${vary}, origin`);
};

/**
 * Wraps `app` so that the desktop app's page can read its responses:
 *
 * - A preflight from the desktop app gets `204` with the allowed methods and
 *   headers, and never reaches `app`, so no credential check runs on it. The
 *   browser sends a preflight without the bearer token.
 * - Any other request from the desktop app gets `app`'s response, with
 *   `access-control-allow-origin: app://hercule` added.
 * - A request from any other origin, or with no origin, gets `app`'s response
 *   with no CORS header. A preflight from another origin reaches `app` like
 *   any other request. No route in the controller answers `OPTIONS`, so it
 *   gets a 404.
 *
 * Every response from `app` also gets `origin` in its `vary` header, because
 * whether it carries the CORS header depends on the request's `Origin`. A
 * cache must not give one origin the response it stored for another.
 *
 * Wrap the whole application with it, the error envelope included, so an
 * error response also carries the header and the desktop app can read the
 * error.
 */
export const withCors = <E, R>(
  app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  E,
  R | HttpServerRequest.HttpServerRequest
> =>
  Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) => {
    const allowed = request.headers.origin === DESKTOP_APP_ORIGIN;
    if (allowed && isPreflight(request)) {
      return Effect.succeed(
        HttpServerResponse.empty({
          headers: {
            "access-control-allow-origin": DESKTOP_APP_ORIGIN,
            "access-control-allow-methods": ALLOWED_METHODS,
            "access-control-allow-headers": ALLOWED_HEADERS,
            "access-control-max-age": PREFLIGHT_MAX_AGE_SECONDS,
          },
        }),
      );
    }
    return Effect.map(app, (response) =>
      addOriginToVary(
        allowed
          ? HttpServerResponse.setHeader(
              response,
              "access-control-allow-origin",
              DESKTOP_APP_ORIGIN,
            )
          : response,
      ),
    );
  });
