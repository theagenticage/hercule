/**
 * The controller's HTTP listener, which `hercule serve` starts.
 *
 * The routes are derived from the contract's HttpApi declaration and nothing
 * else. This module sets the order a request passes through:
 *
 * 1. CORS, which answers the desktop app's preflights and lets the desktop
 *    app read every other response (`./cors.ts`);
 * 2. the error envelope, which handles every failure the routes did not;
 * 3. the web bundle, which serves requests the router matched no route for
 *    (`./static.ts`);
 * 4. routing;
 * 5. the pre-setup gate and the per-request span, both keyed on the operation
 *    the router matched (`./gate.ts`);
 * 6. the credential middleware and the static grant check (`./middleware.ts`);
 * 7. the derived route's decoding, then the one-line handler.
 *
 * Four routes are not derived from the contract's HttpApi declaration:
 *
 * - The live socket at `GET /ws` stops after step 5. It passes the pre-setup
 *   gate, then authenticates in its own first frame, because a browser cannot
 *   put a credential on a WebSocket handshake.
 * - The join at `POST /api/v1/runners/join` stops before step 5. The caller is
 *   a runner with a single-use join token, not a user, and the controller's
 *   own local runner joins before anyone has set Hercule up.
 * - The runner socket at `GET /api/v1/runners/socket` also stops before step 5,
 *   for the same reason: it presents a runner's durable credential, which no
 *   operation accepts and no grant applies to.
 * - The OAuth callback at `GET /oauth/callback` also stops before the
 *   credential middleware: the browser arrives there from the provider with
 *   only a `state`, and gets a redirect rather than a JSON response.
 *
 * The body size limit is not part of that order. It belongs to the listener,
 * and is given to Bun as `maxRequestBodySize` and, for sockets, as
 * `maxPayloadLength`. So the transport rejects an oversize body before reading
 * any of it, and before this module runs at all. That `413` is the only
 * response the API sends outside the error envelope, on purpose: an enveloped
 * response would mean reading the body first, which is the cost the limit
 * exists to avoid.
 *
 * Each request runs on one fiber, and `BunHttpServer` connects the request's
 * abort signal to it: a client that disconnects interrupts the fiber.
 * `disconnect.integration.test.ts` checks the result on a real socket: an
 * abandoned request makes no durable write, authenticated or not.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import type * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { ALL_OPERATIONS, api, createValidationError } from "@hercule/contract";
import { withCors } from "./cors";
import { buildErrorResponse, withEnvelope } from "./envelope";
import { setupGate } from "./gate";
import { AuthenticatedLayer, SetupTokenLayer } from "./middleware";
import { OAuthCallbackRouteLayer } from "../connections";
import {
  Arrival,
  Inbound,
  Pipeline,
  Provisioning,
  checkSchedulerInterval,
  runScheduler,
  sweepSessionsOnLostRunners,
  sweepUnreachableRunners,
} from "../daemon";
import { LiveSocketLayer } from "../live";
import { ProviderProbes } from "../providers";
import { RunnerJoinRouteLayer, RunnerConnections, RunnerSocketRouteLayer } from "../runners";
import { resumeUnfinishedRuns } from "../runs";
import { handlerLayers } from "./routes";
import { withWebBundle, type WebBundle } from "./static";

/**
 * The largest request body the controller reads, in bytes. The listener is
 * given this as `maxRequestBodySize`, so it is enforced by the transport.
 *
 * The largest value the public API accepts is a workflow's YAML source, at most
 * 256K characters. Encoded as JSON, one character can take up to six bytes,
 * because JSON escapes a control character as, for example, `\u0001`. So a
 * source can need 1.5 MiB, and the cap is set above that. Any source within the
 * length limit then reaches the controller, and a source that is too long gets
 * a normal error in the error envelope instead of the transport's bare `413`.
 *
 * Without a limit, an unauthenticated caller could push any number of bytes
 * into durable storage through a failed login's audit row. The limit belongs
 * to the listener, so it applies to every operation and to paths no operation
 * owns, and an oversize body is rejected before it is read.
 */
export const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024;

/**
 * The listener options that enforce the limit, on request bodies and on
 * socket frames. Bun does not apply `maxRequestBodySize` to WebSocket frames,
 * so without the `websocket` option an unauthenticated connection could send
 * the controller a frame many times the documented size.
 */
export const bodyLimits = {
  maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
  websocket: { maxPayloadLength: MAX_REQUEST_BODY_BYTES },
} as const;

/** The operation id of each route, so a span has the same name as everything else uses. */
const OPERATION_BY_ROUTE = new Map(
  ALL_OPERATIONS.map((operation) => [`${operation.method} ${operation.path}`, operation.id]),
);

/**
 * Wraps each request in one span, named after its operation. It wraps every
 * route, so the service and repository calls inside become its children. v1
 * does not export spans; an exporter can be added later by swapping a layer.
 */
const spanMiddleware = HttpRouter.middleware((httpEffect) =>
  Effect.flatMap(HttpRouter.RouteContext, (context) =>
    Effect.withSpan(
      httpEffect,
      OPERATION_BY_ROUTE.get(`${context.route.method} ${context.route.path}`) ?? "http.request",
    ),
  ),
);

/** The API's routes, with the pre-setup gate, both credential middlewares and the request span. */
const routerLayer = HttpApiBuilder.layer(api).pipe(
  Layer.provide(handlerLayers),
  Layer.provide(spanMiddleware.combine(setupGate).layer),
  Layer.provide(AuthenticatedLayer),
  Layer.provide(SetupTokenLayer),
);

/**
 * Replaces a `415` response with a validation error in the envelope. The
 * derived routes respond to a body with the wrong content type with a bare
 * `415` and a text body, the only failure that would bypass the envelope. It
 * is bad input, so it is returned as a validation error.
 */
const rewriteUnsupportedMediaType = <E, R>(
  app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
): Effect.Effect<HttpServerResponse.HttpServerResponse, E, R> =>
  Effect.map(app, (response) =>
    response.status === 415
      ? buildErrorResponse(
          createValidationError([
            { path: [], message: "the request body must be application/json" },
          ]),
        )
      : response,
  );

/**
 * Loads the web bundle this build embeds. Returns `undefined` when no web
 * build has run.
 *
 * It is loaded when the listener starts, not when this module is imported.
 * `./bundle.ts` is generated, and its `with { type: "file" }` imports refer to
 * build output that only Bun's bundler understands. Anything else that loads
 * them, such as a test runner, tries to evaluate a browser bundle.
 *
 * A generated file that refers to build output that no longer exists is
 * treated like no build at all: the API is served on its own. A warning is
 * logged once, because this is a checkout that needs rebuilding, not a broken
 * controller, and refusing to start would be wrong.
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
 * The live socket, behind the same pre-setup gate as the operations. Nothing
 * on it is reachable before setup anyway, because a ticket needs a credential
 * and there is no user yet. But a route should sit outside the gate only for
 * a reason, as the join does, and not by accident.
 */
const liveLayer = LiveSocketLayer.pipe(Layer.provide(setupGate.layer));

/** Builds the whole application as one effect, which each request runs. */
const buildApplication = (bundle: WebBundle | undefined) =>
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
    (routes) => withCors(withEnvelope(withWebBundle(bundle)(rewriteUnsupportedMediaType(routes)))),
  );

/**
 * Starts the background drivers, then starts serving on the current
 * `HttpServer`, and returns. The caller's scope decides how long the listener
 * lives. Closing the scope stops accepting requests, lets in-flight requests
 * finish, and releases the socket.
 *
 * The caller passes in the web bundle: the API is the same with or without
 * it, and a checkout that was never built has none.
 */
export const serve = (bundle: WebBundle | undefined) =>
  Effect.gen(function* () {
    // Before any runner can connect: a runner row marked `online` means a
    // connection is open, and no connection survives the process that held
    // it. Otherwise a controller that was killed rather than shut down would
    // show its whole fleet as ready for work forever, because only the
    // connection that set `online` can clear it.
    const connections = yield* RunnerConnections;
    yield* Effect.orDie(connections.strandedByTheLastRun);
    // Only after that reset: the sweep ends only sessions on runners that are
    // not connected, and until the reset every runner the last process held
    // still reads `online`.
    yield* Effect.forkScoped(sweepSessionsOnLostRunners);
    // Also after the reset, so a runner the last process left `online` is
    // reported once it has been gone for the grace, like any other.
    yield* Effect.forkScoped(sweepUnreachableRunners);
    // Forked before the listener binds, and the arrivals stream replays the
    // rest, so no runner's hello is missed. The probe driver also runs on a
    // timer, because logins expire and harnesses are upgraded outside Hercule.
    yield* Effect.forkScoped(Effect.flatMap(ProviderProbes, (probes) => probes.driving));
    // A runner that connects is sent the work owed to it: its pending
    // provisioning and its running workspace steps. Forked before the
    // listener binds, like the probe driver, so no arrival is missed.
    yield* Effect.forkScoped(Effect.flatMap(Arrival, (arrival) => arrival.driving));
    // Workspaces nothing needs any more are removed from their runner's disk.
    yield* Effect.forkScoped(Effect.flatMap(Provisioning, (provisioning) => provisioning.driving));
    // The controller daemon's two inbound drivers, also before the listener:
    // the queues they read are created with the layer, so nothing a runner
    // reports while these fibers start is missed. Each has its own fiber, so a
    // session's events are applied in the order the runner numbered them, and
    // the rest of the fleet's reports never wait behind them.
    yield* Effect.forkScoped(Effect.flatMap(Inbound, (inbound) => inbound.driving));
    yield* Effect.forkScoped(Effect.flatMap(Inbound, (inbound) => inbound.ingesting));
    // The event pipeline. The router is the only consumer of the event log,
    // and it reads its cursor from the database, so its loop can start here
    // like the others without depending on anything before it.
    yield* Effect.forkScoped(Effect.flatMap(Pipeline, (pipeline) => pipeline.driving));
    // The Scheduler fires cron triggers into the event log, where the
    // pipeline picks their ticks up. It reads what it needs from the
    // database, so it starts here like the others.
    yield* checkSchedulerInterval;
    yield* Effect.forkScoped(runScheduler);
    // Runs a restart cut off continue from their rows. Each run executes on
    // a fiber of the Run Executor, so this returns once they are all started.
    yield* resumeUnfinishedRuns;
    yield* Effect.flatMap(buildApplication(bundle), HttpServer.serveEffect());
  });
