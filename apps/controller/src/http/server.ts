/**
 * The controller's HTTP listener: what `hydra serve` binds (spec 11 section
 * 1.4, spec 13 section 1, spec 15 section 7).
 *
 * The routes are derived from the contract's HttpApi declaration and nothing
 * else; this module is the order the request passes through:
 *
 * 1. the error envelope, which answers everything the routes did not,
 * 2. the pre-setup gate,
 * 3. routing, and with it the per-request span named for the operation,
 * 4. the credential gate and the static grant check (`./middleware.ts`),
 * 5. the derived route's decoding, then the one-line handler.
 *
 * Each request is one fiber. A client that hangs up interrupts it, which rolls
 * an open transaction back: `BunHttpServer` wires the request's abort signal to
 * the fiber, and `server.test.ts` holds it to that.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { ALL_OPERATIONS, api } from "@hydra/contract";
import { withEnvelope } from "./envelope";
import { makeSetupGate } from "./gate";
import { AuthenticatedLayer, SetupTokenLayer } from "./middleware";
import { handlerLayers } from "./routes";

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

/** The API's routes, with both credential gates and the request span in place. */
const routerLayer = HttpApiBuilder.layer(api).pipe(
  Layer.provide(handlerLayers),
  Layer.provide(spanMiddleware.layer),
  Layer.provide(AuthenticatedLayer),
  Layer.provide(SetupTokenLayer),
);

/**
 * The whole application as one effect: what a request runs. Exposed on its own
 * so a test can drive it without a socket.
 */
export const application = Effect.gen(function* () {
  const gate = yield* makeSetupGate;
  const routes = yield* HttpRouter.toHttpEffect(routerLayer);
  return withEnvelope(gate(routes));
});

/**
 * Starts serving on the current `HttpServer` and returns; the caller's scope
 * decides how long the listener lives. Closing it stops accepting, lets
 * in-flight requests finish, and releases the socket.
 */
export const serve = Effect.flatMap(application, HttpServer.serveEffect());
