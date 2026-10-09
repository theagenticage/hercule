/**
 * The controller's HTTP listener, which `hercule serve` starts.
 *
 * Almost every route is derived from the contract's HttpApi declaration. This
 * module sets the order a request passes through:
 *
 * 1. CORS, which answers the desktop app's preflights and lets the desktop
 *    app read every other response (`./cors.ts`);
 * 2. the error envelope, which handles every failure the routes did not;
 * 3. the web bundle, which serves requests the router matched no route for
 *    (`./static.ts`);
 * 4. routing;
 * 5. the per-request span, the pre-setup gate and the promotion gate, all
 *    keyed on the route the router matched (`./gate.ts`);
 * 6. the credential middleware and the static grant check (`./middleware.ts`);
 * 7. the derived route's decoding, then the one-line handler.
 *
 * Seven paths are not derived from the contract's HttpApi declaration. None
 * of them reaches steps 6 and 7 or gets the span of step 5, and they differ
 * in which of the two gates they pass:
 *
 * - The live socket at `GET /ws` passes both gates. It then authenticates in
 *   its own first frame, because a browser cannot put a credential on a
 *   WebSocket handshake.
 * - Three paths pass the promotion gate but not the pre-setup gate, because
 *   their callers are not users:
 *   - the join at `POST /api/v1/runners/join`, where the caller is a runner
 *     with a single-use join token, and the controller's own local runner
 *     joins before anyone has set Hercule up;
 *   - the attachment fetch at `GET /api/v1/runners/attachments/:id`, where a
 *     runner fetches an input's image with its credential;
 *   - the OAuth callback at `GET /oauth/callback`, where the browser arrives
 *     from the provider with only a `state`, and gets a redirect rather than
 *     a JSON response.
 * - Three paths pass neither gate, because they must keep working while the
 *   controller is frozen or sealed. Each checks the promotion phase itself:
 *   - the promotion transfer at `/api/v1/controller/promotion-transfer`,
 *     where GET previews it, POST streams it and DELETE cancels it, for a
 *     machine holding a promotion token rather than a user credential;
 *   - the promotion switch at `POST /api/v1/controller/promotion-switch`,
 *     called by the same machine with the same token;
 *   - the runner socket at `GET /api/v1/runners/socket`, which presents a
 *     runner's durable credential that no operation accepts and no grant
 *     applies to.
 *
 * The body size limits sit outside that order, in two places:
 *
 * - The listener: Bun is given `MAX_UPLOAD_BODY_BYTES` as
 *   `maxRequestBodySize` and the protocol's `MAX_FRAME_BYTES` as the sockets'
 *   `maxPayloadLength`, so the transport rejects a larger body or frame before
 *   reading any of it, and before this module runs at all.
 * - `limitRequestBody`, between steps 1 and 2: only an image upload may be
 *   that large, so every other request is held to `MAX_REQUEST_BODY_BYTES`
 *   by its `Content-Length`, again before any of the body is read.
 *
 * Both answer with a bare `413`, the one response the API sends outside the
 * error envelope, on purpose: an enveloped response would mean reading the
 * body first, which is the cost the limit exists to avoid.
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
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import {
  ALL_OPERATIONS,
  api,
  createValidationError,
  MAX_ATTACHMENT_BYTES,
  OPERATIONS,
} from "@hercule/contract";
import { MAX_FRAME_BYTES } from "@hercule/protocol";
import { withCors } from "./cors";
import { buildErrorResponse, withEnvelope } from "./envelope";
import { promotionGate, setupGate } from "./gate";
import { AuthenticatedLayer, SetupTokenLayer } from "./middleware";
import { OAuthCallbackRouteLayer } from "../connections";
import {
  Arrival,
  Inbound,
  Pipeline,
  PromotionFleetRouteLayer,
  Provisioning,
  checkSchedulerInterval,
  runAttachmentSweepLoop,
  runIngestReconciler,
  runScheduler,
  sweepSessionsOnLostRunners,
  sweepUnreachableRunners,
} from "../daemon";
import { PromotionState, PromotionTransferRouteLayer } from "../promotion";
import { LiveSocketLayer } from "../live";
import { ProviderProbes } from "../providers";
import {
  RunnerAttachmentRouteLayer,
  RunnerJoinRouteLayer,
  RunnerConnections,
  RunnerSocketRouteLayer,
} from "../runners";
import { resumeUnfinishedRuns } from "../runs";
import { handlerLayers } from "./routes";
import { withWebBundle, type WebBundle } from "./static";

/**
 * The largest request body the controller reads, in bytes, for every request
 * except an image upload. `limitRequestBody` enforces it from the request's
 * `Content-Length`, before the body is read.
 *
 * The largest value the public API accepts is a workflow's YAML source, at most
 * 256K characters. Encoded as JSON, one character can take up to six bytes,
 * because JSON escapes a control character as, for example, `\u0001`. So a
 * source can need 1.5 MiB, and the cap is set above that. Any source within the
 * length limit then reaches the controller, and a source that is too long gets
 * a normal error in the error envelope instead of the bare `413`.
 *
 * Without a limit, an unauthenticated caller could push any number of bytes
 * into durable storage through a failed login's audit row. The limit wraps
 * the whole application, so it applies to every operation and to paths no
 * operation owns.
 */
export const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024;

/**
 * The largest body of an image upload (`attachment.create`), which is the
 * largest image an input accepts. Bun enforces it on every request as
 * `maxRequestBodySize`, so it also bounds an upload sent without a
 * `Content-Length`.
 */
export const MAX_UPLOAD_BODY_BYTES = MAX_ATTACHMENT_BYTES;

/**
 * The listener options that enforce the limits, on request bodies and on
 * socket frames. Bun does not apply `maxRequestBodySize` to WebSocket frames,
 * so without the `websocket` option an unauthenticated connection could send
 * the controller a frame many times the documented size. A frame never
 * carries an image, so sockets are held to `MAX_FRAME_BYTES`, which the
 * runner also reads, so it never sends an event too large for one frame.
 * Bun closes a socket whose frame is larger.
 */
export const bodyLimits = {
  maxRequestBodySize: MAX_UPLOAD_BODY_BYTES,
  websocket: { maxPayloadLength: MAX_FRAME_BYTES },
} as const;

/** The path of `attachment.create`, the one route whose body may exceed `MAX_REQUEST_BODY_BYTES`. */
const UPLOAD_PATH = OPERATIONS["attachment.create"].path;

/**
 * Checks whether a request is an image upload. The method and the path must
 * match exactly, with the query string removed. A path the router would also
 * accept, such as one in another case, is not treated as an upload, so it is
 * held to the smaller limit rather than slipping past it.
 */
const isUpload = (request: HttpServerRequest.HttpServerRequest): boolean => {
  const end = request.url.search(/[?#]/);
  const path = end === -1 ? request.url : request.url.slice(0, end);
  return request.method === OPERATIONS["attachment.create"].method && path === UPLOAD_PATH;
};

/** Builds a bare refusal of a request whose body was not read, closing its connection. */
const refuseUnreadBody = (status: 411 | 413): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.empty({ status, headers: { connection: "close" } });

/**
 * Wraps `app` so that a request other than an image upload is refused when
 * its body could exceed `MAX_REQUEST_BODY_BYTES`, before any of the body is
 * read:
 *
 * - a `Content-Length` over the limit gets a bare `413`, like the one Bun
 *   sends for a body over `maxRequestBodySize`;
 * - a body sent with `Transfer-Encoding` gets a bare `411`, because its
 *   length is known only after reading it. The upload is exempt, because
 *   Bun's own limit bounds it.
 *
 * Both refusals close the connection. The body was never read, so the
 * connection cannot be trusted for another request. Bun also keeps such a
 * connection counted as busy once a large unread body has arrived: a graceful
 * `server.stop()` then waits for it until Bun's idle timeout, about 10
 * seconds, ends it. Closing the connection is what HTTP asks of a server that
 * answers without reading the body (RFC 9112, section 9.6).
 *
 * It sits inside `withCors`, so the desktop app can read the refusal.
 */
const limitRequestBody = <E, R>(
  app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  E,
  R | HttpServerRequest.HttpServerRequest
> =>
  Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) => {
    if (isUpload(request)) return app;
    if (request.headers["transfer-encoding"] !== undefined)
      return Effect.succeed(refuseUnreadBody(411));
    const length = Number(request.headers["content-length"] ?? 0);
    return length > MAX_REQUEST_BODY_BYTES ? Effect.succeed(refuseUnreadBody(413)) : app;
  });

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

/** The API's routes, with the pre-setup gate, the promotion gate, both credential middlewares and the request span. */
const routerLayer = HttpApiBuilder.layer(api).pipe(
  Layer.provide(handlerLayers),
  Layer.provide(spanMiddleware.combine(setupGate).combine(promotionGate).layer),
  Layer.provide(AuthenticatedLayer),
  Layer.provide(SetupTokenLayer),
);

/**
 * Replaces a `415` response with a validation error in the envelope. The
 * derived routes respond to a body with the wrong content type with a bare
 * `415` and a text body, the only failure that would bypass the envelope. It
 * is bad input, so it is returned as a validation error that names the type
 * the route takes: raw bytes for an image upload, JSON for everything else.
 */
const rewriteUnsupportedMediaType = <E, R>(
  app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  E,
  R | HttpServerRequest.HttpServerRequest
> =>
  Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
    Effect.map(app, (response) => {
      if (response.status !== 415) return response;
      const type = isUpload(request) ? "application/octet-stream" : "application/json";
      return buildErrorResponse(
        createValidationError([{ path: [], message: `the request body must be ${type}` }]),
      );
    }),
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
const liveLayer = LiveSocketLayer.pipe(Layer.provide(setupGate.combine(promotionGate).layer));

/**
 * The routes outside the operation table that the promotion gate guards. They
 * sit outside the pre-setup gate: a runner joins with a join token, a runner
 * fetches an image with its own credential, and the OAuth callback carries a
 * `state`, none of which need a user.
 *
 * The promotion routes and the runner socket are behind neither gate. They
 * keep working while the controller is frozen or sealed, and each checks the
 * promotion phase itself.
 */
const gatedRouteLayers = Layer.mergeAll(
  RunnerJoinRouteLayer,
  RunnerAttachmentRouteLayer,
  OAuthCallbackRouteLayer,
).pipe(Layer.provide(promotionGate.layer));

/** Builds the whole application as one effect, which each request runs. */
const buildApplication = (bundle: WebBundle | undefined) =>
  Effect.map(
    HttpRouter.toHttpEffect(
      Layer.mergeAll(
        routerLayer,
        liveLayer,
        gatedRouteLayers,
        PromotionTransferRouteLayer,
        PromotionFleetRouteLayer,
        RunnerSocketRouteLayer,
      ),
    ),
    (routes) =>
      withCors(
        limitRequestBody(withEnvelope(withWebBundle(bundle)(rewriteUnsupportedMediaType(routes)))),
      ),
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
    // Images nobody sent within a day of their upload are deleted, with their files.
    yield* Effect.forkScoped(runAttachmentSweepLoop);
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
    // The Ingest Reconciler opens an ingest handle for each Connection that
    // should ingest. It starts after the event pipeline, so the events the
    // plugins emit reach it. Each ingest runs on a fiber of the Ingest
    // Executor, apart from the reconciler's pass that opened it.
    yield* Effect.forkScoped(runIngestReconciler);
    // Runs a restart cut off continue from their rows. Each run executes on
    // a fiber of the Run Executor, so this returns once they are all started.
    // A sealed controller resumes nothing: the controller its data moved to
    // runs them. No controller boots frozen, because the freeze is not stored.
    const promotion = yield* PromotionState;
    if ((yield* promotion.phase)._tag !== "Sealed") yield* resumeUnfinishedRuns;
    yield* Effect.flatMap(buildApplication(bundle), HttpServer.serveEffect());
  });
