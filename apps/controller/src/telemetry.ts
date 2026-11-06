/**
 * The controller's telemetry: its spans, exported over OTLP/HTTP when the
 * bootstrap key `telemetry.otlp_endpoint` (or the OpenTelemetry standard's
 * `OTEL_EXPORTER_OTLP_ENDPOINT`) names a collector, and nothing at all when
 * it does not (#1041).
 *
 * The spans already exist: one per operation, one per SQL statement, and the
 * server span Effect's HTTP server makes around each request once a tracer is
 * installed. This module only decides where they go.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Tracer from "effect/Tracer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpMiddleware from "effect/http/HttpMiddleware";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as OtlpExporter from "effect/observability/OtlpExporter";
import * as OtlpSerialization from "effect/observability/OtlpSerialization";
import * as OtlpTracer from "effect/observability/OtlpTracer";
import { ALL_OPERATIONS } from "@hercule/contract";
import { VERSION } from "@hercule/home/version";

/** The name the controller's spans carry as `service.name`. */
export const CONTROLLER_SERVICE_NAME = "hercule-controller";

/**
 * Builds the URL traces are posted to from a collector's base URL: the
 * OpenTelemetry convention appends `/v1/traces` to the path of
 * `OTEL_EXPORTER_OTLP_ENDPOINT`, and `telemetry.otlp_endpoint` means the same
 * thing. The URL is parsed rather than joined as text, so surrounding spaces
 * and an empty query or fragment (`http://collector:4318#`) cannot end up in
 * the result.
 */
export const buildTracesUrl = (endpoint: string): string => {
  const url = new URL(endpoint);
  url.search = "";
  url.hash = "";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/v1/traces`;
  return url.href;
};

/**
 * How long one export request may take, from sending it to the end of the
 * collector's answer, body included. Effect's exporter sets no deadline of
 * its own, so a collector that accepts a request and never answers would hold
 * it, and its spans, for ever. A request past the deadline fails like a
 * network error: Effect's exporter tries it three more times, about a second
 * apart, then drops the batch and pauses for a minute.
 */
const EXPORT_DEADLINE = Duration.seconds(5);

/**
 * How many export requests may wait for the collector at once. Effect's
 * exporter starts a new request for every thousand spans without waiting for
 * the last, so a slow collector would otherwise collect requests, and the
 * memory of their spans, as fast as the controller works. A request past the
 * limit fails at once, like a network error. The exporter keeps its batch
 * while it tries three more times, about a second apart, then drops it and
 * pauses for a minute. So what a slow collector costs is bounded by the spans
 * of a few seconds, not by four batches. A collector that answers in time
 * never has more than one request waiting.
 */
const MAX_EXPORTS_IN_FLIGHT = 4;

/**
 * Wraps the exporter's HTTP client so that every request has a deadline
 * (`EXPORT_DEADLINE`) and no more than `MAX_EXPORTS_IN_FLIGHT` wait at once.
 * Together they bound what a slow or hung collector can cost the controller.
 */
const limitExportRequests = (client: HttpClient.HttpClient): HttpClient.HttpClient => {
  let inFlight = 0;
  const fail = (request: HttpClientRequest.HttpClientRequest, description: string) =>
    Effect.fail(
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({ request, description }),
      }),
    );
  return HttpClient.transform(client, (response, request) =>
    Effect.suspend(() => {
      if (inFlight >= MAX_EXPORTS_IN_FLIGHT) {
        return fail(
          request,
          `${MAX_EXPORTS_IN_FLIGHT} exports are already waiting for the collector`,
        );
      }
      inFlight += 1;
      return response.pipe(
        // The body is read here, inside the deadline and the limit. The
        // exporter reads it after this returns, and gets the copy the
        // response keeps; a body read outside would let a collector that
        // sends its headers and then stalls hold requests without bound.
        Effect.tap((answer) => answer.arrayBuffer),
        Effect.timeoutOrElse({
          duration: EXPORT_DEADLINE,
          orElse: () => fail(request, "the collector did not answer in time"),
        }),
        Effect.ensuring(Effect.sync(() => (inFlight -= 1))),
      );
    }),
  );
};

/**
 * The attributes Effect gives a span that hold text a client chose:
 *
 * - a URL's path, which can hold anything, even in a request that fails;
 * - its query, which can hold what the user typed (a search's `text`) or a
 *   credential (the setup URL's `token`);
 * - the `User-Agent` header, which Effect records whatever header filter is
 *   set.
 *
 * The span's name and `http.route` say which route a request took without
 * them.
 */
const CLIENT_TEXT_ATTRIBUTES: ReadonlySet<string> = new Set([
  "url.full",
  "url.path",
  "url.query",
  "user_agent.original",
]);

/**
 * Wraps `tracer` so that no span it makes records text a client chose
 * (`CLIENT_TEXT_ATTRIBUTES`). Every other attribute is kept.
 */
const omitClientText = (tracer: Tracer.Tracer): Tracer.Tracer =>
  Tracer.make({
    span: (options) => {
      const span = tracer.span(options);
      const record = span.attribute.bind(span);
      span.attribute = (key, value) => {
        if (!CLIENT_TEXT_ATTRIBUTES.has(key)) record(key, value);
      };
      return span;
    },
    context: tracer.context,
  });

/**
 * The API's routes as patterns that match a request's path, with the route
 * each stands for, fewest parameters first: a fixed segment such as
 * `/sessions/archive` must win over a parameter such as `/sessions/:id`.
 */
const ROUTE_PATTERNS = ALL_OPERATIONS.map((operation) => {
  const segments = operation.path.split("/");
  const pattern = segments
    .map((segment) =>
      segment.startsWith(":") ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("/");
  return {
    method: operation.method,
    route: operation.path,
    parameters: segments.filter((segment) => segment.startsWith(":")).length,
    pattern: new RegExp(`^${pattern}$`),
  };
}).sort((a, b) => a.parameters - b.parameters);

/**
 * Returns the name of a request's server span: its method and its route,
 * such as `GET /api/v1/sessions/:id`, as the OpenTelemetry conventions name
 * an HTTP server span. Returns the method alone for a path that is not an
 * API route, such as a file of the web app. Effect names the span when the
 * request arrives, before the router has run, so the route is found here
 * from the contract's operation table.
 */
export const nameServerSpan = (request: HttpServerRequest.HttpServerRequest): string => {
  const end = request.url.search(/[?#]/);
  const path = end === -1 ? request.url : request.url.slice(0, end);
  const found = ROUTE_PATTERNS.find(
    (route) => route.method === request.method && route.pattern.test(path),
  );
  return found === undefined ? request.method : `${request.method} ${found.route}`;
};

/**
 * Returns the layer that exports the controller's spans to `endpoint`, or an
 * empty layer when `endpoint` is undefined, so a controller with telemetry
 * off installs no tracer and runs no exporter.
 *
 * The exporter batches spans and posts them in the background. When the
 * collector fails, Effect's exporter drops the batch and pauses for a minute,
 * and at shutdown it flushes for a bounded time. A collector that is slow or
 * never answers is bounded too (`limitExportRequests`). So a collector that
 * is down never slows or stops the controller.
 *
 * No span records text a client chose: a URL's path or query, or the
 * `User-Agent` (`omitClientText`). No other request header is recorded,
 * which is Effect's default. Server spans are named
 * by `nameServerSpan`. What the spans may hold is what the process log may
 * hold: error messages included, and never a secret.
 */
export const makeTelemetryLayer = (endpoint: string | undefined): Layer.Layer<never> =>
  endpoint === undefined
    ? Layer.empty
    : Layer.mergeAll(
        Layer.effect(Tracer.Tracer)(
          Effect.map(
            OtlpTracer.make({
              url: buildTracesUrl(endpoint),
              resource: { serviceName: CONTROLLER_SERVICE_NAME, serviceVersion: VERSION },
            }),
            omitClientText,
          ),
        ).pipe(
          Layer.provideMerge(OtlpExporter.layerFlusher),
          Layer.provide([
            OtlpSerialization.layerJson,
            Layer.effect(HttpClient.HttpClient)(
              Effect.map(HttpClient.HttpClient, limitExportRequests),
            ).pipe(Layer.provide(FetchHttpClient.layer)),
          ]),
        ),
        Layer.succeed(HttpMiddleware.SpanNameGenerator)(nameServerSpan),
      );
