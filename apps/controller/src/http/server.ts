/**
 * The controller's HTTP listener: what `hydra serve` binds (spec 11 section
 * 1.4, spec 13 section 1, spec 15 section 7).
 *
 * The routes are derived from the contract's HttpApi declaration and nothing
 * else; this module is the order the request passes through:
 *
 * 1. the error envelope, which answers everything the routes did not,
 * 2. routing,
 * 3. the pre-setup gate and the per-request span, both named for the operation
 *    the router matched (`./gate.ts`),
 * 4. the credential gate and the static grant check (`./middleware.ts`),
 * 5. the derived route's decoding, then the one-line handler.
 *
 * The body cap is not in that order: it is the listener's, given to Bun as
 * `maxRequestBodySize`, so an oversize body is answered `413` by the transport
 * before a byte of it is read and before this module runs at all. That `413` is
 * the one response the API sends outside the error envelope of spec 11 section
 * 1.5, and it is deliberate: an enveloped answer would mean reading the body
 * first, which is the cost the cap exists to avoid.
 *
 * Each request is one fiber, and `BunHttpServer` wires the request's abort
 * signal to it: a client that hangs up interrupts the fiber, and
 * `disconnect.test.ts` holds a real socket to the consequence - a request that
 * was abandoned performs no durable write, authenticated or not.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import type * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { ALL_OPERATIONS, api, validation } from "@hydra/contract";
import { responseFor, withEnvelope } from "./envelope";
import { setupGate } from "./gate";
import { AuthenticatedLayer, SetupTokenLayer } from "./middleware";
import { handlerLayers } from "./routes";

/**
 * The largest request body the controller reads, in bytes. The listener is
 * given this as `maxRequestBodySize`, so it is enforced by the transport.
 *
 * Nothing the public API takes in v1 is anywhere near a megabyte - the largest
 * is a secret value - and without a cap an unauthenticated caller can push
 * arbitrary bytes into durable storage through a failed login's audit row. The
 * cap is the listener's, so it holds for every operation and for paths no
 * operation owns, and an oversize body is refused with a bare `413` before it
 * is read.
 */
export const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

/** Which operation a matched route is, so a span carries the name everything else uses. */
const OPERATION_BY_ROUTE = new Map(
  ALL_OPERATIONS.map((operation) => [`${operation.method} ${operation.path}`, operation.id]),
);

/**
 * One span per request, named for the operation (spec 11 section 1.1). It wraps
 * every route, so the service calls and repository calls underneath hang off
 * it. v1 exports spans nowhere; an exporter is a later layer swap.
 */
const spanMiddleware = HttpRouter.middleware((httpEffect) =>
  Effect.flatMap(HttpRouter.RouteContext, (context) =>
    Effect.withSpan(
      httpEffect,
      OPERATION_BY_ROUTE.get(`${context.route.method} ${context.route.path}`) ?? "http.request",
    ),
  ),
);

/** The API's routes, with the pre-setup gate, both credential gates and the request span. */
const routerLayer = HttpApiBuilder.layer(api).pipe(
  Layer.provide(handlerLayers),
  Layer.provide(spanMiddleware.combine(setupGate).layer),
  Layer.provide(AuthenticatedLayer),
  Layer.provide(SetupTokenLayer),
);

/**
 * The derived routes answer a body they cannot decode with a bare `415` and a
 * text body of their own, which is the one failure that would leave the
 * envelope of spec 11 section 1.5. It is bad input, so it answers as one.
 */
const jsonOnly = <E, R>(
  app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
): Effect.Effect<HttpServerResponse.HttpServerResponse, E, R> =>
  Effect.map(app, (response) =>
    response.status === 415
      ? responseFor(
          validation([{ path: [], message: "the request body must be application/json" }]),
        )
      : response,
  );

/**
 * The whole application as one effect: what a request runs.
 */
const application = Effect.map(HttpRouter.toHttpEffect(routerLayer), (routes) =>
  withEnvelope(jsonOnly(routes)),
);

/**
 * Starts serving on the current `HttpServer` and returns; the caller's scope
 * decides how long the listener lives. Closing it stops accepting, lets
 * in-flight requests finish, and releases the socket.
 */
export const serve = Effect.flatMap(application, HttpServer.serveEffect());
