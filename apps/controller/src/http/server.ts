/**
 * The controller's HTTP listener: what `hydra serve` binds.
 *
 * The routes are derived from the contract's HttpApi declaration and nothing
 * else; this module is the order the request passes through:
 *
 * 1. the error envelope, which answers everything the routes did not,
 * 2. the web bundle, which answers what the router matched nothing for
 *    (`./static.ts`),
 * 3. routing,
 * 4. the pre-setup gate and the per-request span, both named for the operation
 *    the router matched (`./gate.ts`),
 * 5. the credential gate and the static grant check (`./middleware.ts`),
 * 6. the derived route's decoding, then the one-line handler.
 *
 * Four routes are not derived from the contract's HttpApi declaration. The live
 * socket at `GET /ws` stops at step 4: it passes the pre-setup gate and then
 * authenticates itself in its own first frame, because a browser cannot put a
 * credential on a WebSocket handshake. The join at `POST /api/v1/runners/join`
 * stops before it: the caller is a machine holding a single-use join token
 * rather than a user, and the controller's own local runner joins before
 * anybody has set Hydra up. The runner socket at `GET /api/v1/runners/socket`
 * stops there too, and for the same reason: what it presents is a runner's
 * durable credential, which no operation accepts and no grant belongs to. The
 * OAuth callback at `GET /oauth/callback` stops before the credential gate as
 * well: the browser arrives there from the provider with nothing but a `state`,
 * and what it is told is a redirect rather than an answer.
 *
 * The body cap is not in that order: it is the listener's, given to Bun as
 * `maxRequestBodySize` and, for the socket, as `maxPayloadLength`, so an
 * oversize body is refused by the transport before a byte of it is read and
 * before this module runs at all. That `413` is
 * the one response the API sends outside the error envelope, and it is
 * deliberate: an enveloped answer would mean reading the body first, which is
 * the cost the cap exists to avoid.
 *
 * Each request is one fiber, and `BunHttpServer` wires the request's abort
 * signal to it: a client that hangs up interrupts the fiber, and
 * `disconnect.integration.test.ts` holds a real socket to the consequence - a
 * request that was abandoned performs no durable write, authenticated or not.
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
import { OAuthCallbackRouteLayer } from "../connections";
import { Inbound, Provisioning } from "../daemon";
import { LiveSocketLayer } from "../live";
import { ProviderProbes } from "../providers";
import { RunnerJoinRouteLayer, RunnerConnections, RunnerSocketRouteLayer } from "../runners";
import { handlerLayers } from "./routes";
import { withWebBundle, type WebBundle } from "./static";

/**
 * The largest request body the controller reads, in bytes. The listener is
 * given this as `maxRequestBodySize`, so it is enforced by the transport.
 *
 * Nothing the public API takes in v1 is anywhere near a megabyte - the largest
 * is a secret value - and without a cap an unauthenticated caller can push
 * arbitrary bytes into durable storage through a failed login's audit row. The
 * cap is the listener's, so it holds for every operation and for paths no
 * operation owns, and an oversize body is refused before it is read.
 */
export const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

/**
 * The listener options that enforce the cap, on a request body and on a socket
 * frame alike. Bun applies `maxRequestBodySize` to neither WebSocket frames nor
 * anything else the socket carries, so without the second half an unauthenticated
 * connection could hand the controller a frame many times the documented size.
 */
export const bodyLimits = {
  maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
  websocket: { maxPayloadLength: MAX_REQUEST_BODY_BYTES },
} as const;

/** Which operation a matched route is, so a span carries the name everything else uses. */
const OPERATION_BY_ROUTE = new Map(
  ALL_OPERATIONS.map((operation) => [`${operation.method} ${operation.path}`, operation.id]),
);

/**
 * One span per request, named for the operation. It wraps every route, so the
 * service calls and repository calls underneath hang off it. v1 exports spans
 * nowhere; an exporter is a later layer swap.
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
 * envelope. It is bad input, so it answers as one.
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
 * The web bundle this build embeds, or nothing when no web build has run.
 *
 * Loaded when the listener starts rather than when this module is imported.
 * `./bundle.ts` is generated, and its `with { type: "file" }` imports name
 * build output and mean something to Bun's bundler alone; anything else that
 * links them - a test runner, above all - tries to evaluate a browser bundle.
 *
 * A generated file naming build output that is no longer there is the same
 * situation as no build at all: the API is served on its own. It says so once,
 * because it is a checkout that needs rebuilding rather than a broken
 * controller, and refusing to start over it would be the wrong answer.
 */
export const webBundle: Effect.Effect<WebBundle | undefined> = Effect.tryPromise({
  try: () => import("./bundle").then((module) => module.webBundle),
  catch: (error: unknown) => String(error),
}).pipe(
  Effect.catch((reason) =>
    Effect.as(
      Effect.logWarning(
        "The embedded web bundle is stale or missing, so only the API is served. " +
          `Run \`pnpm build:binary\` to regenerate it. (${reason})`,
      ),
      undefined,
    ),
  ),
);

/**
 * The whole application as one effect: what a request runs.
 */
/**
 * The live socket, behind the same pre-setup gate the operations are behind.
 * Nothing on it is reachable before setup - a ticket needs a credential and
 * there is no user yet - but a route that sits outside the gate should do so
 * because it has a reason to, as the join does, and not by omission.
 */
const liveLayer = LiveSocketLayer.pipe(Layer.provide(setupGate.layer));

const application = (bundle: WebBundle | undefined) =>
  Effect.map(
    HttpRouter.toHttpEffect(
      Layer.mergeAll(
        routerLayer,
        liveLayer,
        RunnerJoinRouteLayer,
        RunnerSocketRouteLayer,
        OAuthCallbackRouteLayer,
      ),
    ),
    (routes) => withEnvelope(withWebBundle(bundle)(jsonOnly(routes))),
  );

/**
 * Starts serving on the current `HttpServer` and returns; the caller's scope
 * decides how long the listener lives. Closing it stops accepting, lets
 * in-flight requests finish, and releases the socket.
 *
 * The web bundle is the caller's to hand over: the API is the same server with
 * or without it, and a checkout that was never built has none.
 */
export const serve = (bundle: WebBundle | undefined) =>
  Effect.gen(function* () {
    // Before anything can dial: a runner row saying `online` means a connection
    // is open, and no connection survives the process that held it. A
    // controller killed rather than drained would otherwise show its whole
    // fleet as ready for work for ever, because the only thing that moves a
    // runner off `online` is the connection that put it there.
    const connections = yield* RunnerConnections;
    yield* Effect.orDie(connections.strandedByTheLastRun);
    // Forked before the listener binds, and the arrivals replay covers the rest
    // of the gap, so no machine says hello unheard. The tick is there because a
    // login expires and a harness is upgraded outside Hydra.
    yield* Effect.forkScoped(Effect.flatMap(ProviderProbes, (probes) => probes.driving));
    // Workspaces: a machine that dials in is told what it still owes, and a
    // workspace nothing needs any more is taken off its machine's disk. Forked
    // before the listener binds, like the probe driver, so no arrival is
    // missed.
    yield* Effect.forkScoped(Effect.flatMap(Provisioning, (provisioning) => provisioning.driving));
    // The controller daemon's two inbound drivers, before the listener for the
    // same reason: the queues they read are built with the layer, so nothing a
    // machine reports while these fibers are starting is missed. One fiber
    // each, so a session's events are applied in the order the machine numbered
    // them and the rest of the fleet's reports never wait behind them.
    yield* Effect.forkScoped(Effect.flatMap(Inbound, (inbound) => inbound.driving));
    yield* Effect.forkScoped(Effect.flatMap(Inbound, (inbound) => inbound.ingesting));
    yield* Effect.flatMap(application(bundle), HttpServer.serveEffect());
  });
