/**
 * Test support for this plugin:
 *
 * - a stub `HttpClient`. Every function that calls GitHub requires an
 *   `HttpClient`, so a test provides the stub's layer, or runs the function
 *   with `runAgainstStub`, and reads back the requests it received;
 * - an ingest context that keeps its state in memory and records every event
 *   emitted, after checking it as the host would.
 */
import { Effect, Layer, Option, type Result, Schema } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpClientError from "effect/unstable/http/HttpClientError";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import {
  PluginError,
  type EmittedEvent,
  type IngestContext,
  type KeyValueStore,
  type LinkedResource,
} from "@hercule/plugin-host";
import {
  bounded,
  ExternalRef,
  MAX_DEDUP_KEY_LENGTH,
  MAX_EVENT_SYSTEM_LENGTH,
  MAX_EVENT_URL_LENGTH,
} from "@hercule/contract";
import { TEST_TOKEN } from "./actions/testing";
import { GITHUB_EVENT_KINDS } from "./kinds";

/** The stub's layer, and every request it received, in order. */
export interface GithubStub {
  readonly layer: Layer.Layer<HttpClient.HttpClient>;
  readonly requests: Array<HttpClientRequest.HttpClientRequest>;
}

/** One response the stub returns. A missing body is an empty body, as on a 304. */
export interface StubResponse {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * Builds a stub client that answers each request with `answer`. Use it to
 * fail a request, or to answer by method and URL.
 */
export const stubHttpClient = (
  answer: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>,
): GithubStub => {
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  const client = HttpClient.make((request) => {
    requests.push(request);
    return answer(request);
  });
  return { layer: Layer.succeed(HttpClient.HttpClient, client), requests };
};

/** Converts a `StubResponse` into the response the client returns for `request`. */
const buildStubResponse = (
  request: HttpClientRequest.HttpClientRequest,
  response: StubResponse,
): HttpClientResponse.HttpClientResponse =>
  HttpClientResponse.fromWeb(
    request,
    new Response(response.body === undefined ? null : JSON.stringify(response.body), {
      status: response.status,
      headers: { "content-type": "application/json", ...response.headers },
    }),
  );

/**
 * Builds a stub client that answers each request with what `route` returns
 * for it, so one stub can serve several endpoints.
 */
export const stubGithub = (
  route: (request: HttpClientRequest.HttpClientRequest) => StubResponse,
): GithubStub =>
  stubHttpClient((request) => Effect.succeed(buildStubResponse(request, route(request))));

/** Builds a stub client that answers every request with this status and body. */
export const stubAnswer = (status: number, body: unknown): GithubStub =>
  stubGithub(() => ({ status, body }));

/**
 * Runs an effect that calls GitHub against a stub client, and returns its
 * result: the value it succeeded with, or the error it failed with.
 */
export const runAgainstStub = <A, E>(
  effect: Effect.Effect<A, E, HttpClient.HttpClient>,
  stub: GithubStub,
): Promise<Result.Result<A, E>> =>
  Effect.runPromise(Effect.result(effect).pipe(Effect.provide(stub.layer)));

/** The path and query parameters of a request the stub received. */
export interface StubRequestTarget {
  /** The path below the API root, such as `/repos/owner/repo/issues`. */
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
}

/**
 * Returns the path and query parameters of a request, whether they were
 * passed as parameters or are part of the URL, as on a next-page URL.
 */
export const readStubRequestTarget = (
  request: HttpClientRequest.HttpClientRequest,
): StubRequestTarget => {
  const url = new URL(request.url);
  for (const [name, value] of request.urlParams) url.searchParams.set(name, value);
  return { path: url.pathname, query: Object.fromEntries(url.searchParams) };
};

/** An ingest context for tests, and what was done through it. */
export interface IngestHarness {
  readonly context: IngestContext;
  /** Every event emitted, in order. */
  readonly events: Array<EmittedEvent>;
  /** The Connection's state, by key. */
  readonly state: Map<string, Schema.Json>;
  /** The Resources linked to the Connection; a test may change them between polls. */
  readonly resources: Array<LinkedResource>;
}

/**
 * The fields of an emitted event that are the same for every kind, with the
 * limits the host enforces. The host decodes the same schema in
 * `apps/controller/src/plugins/ingest-context.ts`, which a plugin cannot
 * import, so it is rebuilt here from the limits in `@hercule/contract`.
 */
const EventEnvelope = Schema.Struct({
  dedupKey: bounded(1, MAX_DEDUP_KEY_LENGTH),
  // The host's own check: an ISO 8601 date and time with an explicit time zone.
  occurredAt: Schema.String.check(
    Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/),
  ),
  refs: Schema.Array(ExternalRef),
  url: Schema.optionalKey(bounded(1, MAX_EVENT_URL_LENGTH)),
  system: Schema.optionalKey(bounded(1, MAX_EVENT_SYSTEM_LENGTH)),
  raw: Schema.optionalKey(Schema.JsonObject),
});

/**
 * Checks one emitted event the way the host does before it writes it. Fails
 * with a `PluginError` when the kind is not one the plugin declares, when a
 * common field breaks the host's limits, such as a dedup key longer than 200
 * characters, or when the payload does not match the kind's schema exactly.
 */
const checkEmittedEvent = (event: EmittedEvent): Effect.Effect<void, PluginError> => {
  const declaration = GITHUB_EVENT_KINDS[event.kind];
  if (declaration === undefined) {
    return Effect.fail(new PluginError({ message: `Undeclared kind ${event.kind}` }));
  }
  return Effect.andThen(
    Schema.decodeUnknownEffect(EventEnvelope)(event),
    Schema.decodeUnknownEffect(declaration.schema as Schema.Codec<unknown>, {
      onExcessProperty: "error",
    })(event.payload),
  ).pipe(
    Effect.asVoid,
    Effect.mapError((error) => new PluginError({ message: `${event.kind}: ${error.message}` })),
  );
};

/**
 * Builds an ingest context whose credentials hold `credentials`, whose state
 * lives in a `Map`, and whose `emit` records each event. Like the host's,
 * `emit` fails with a `PluginError` when the event fails the checks
 * `checkEmittedEvent` describes.
 */
export const buildIngestHarness = (
  credentials: Readonly<Record<string, string>> = { pat: TEST_TOKEN },
): IngestHarness => {
  const events: Array<EmittedEvent> = [];
  const state = new Map<string, Schema.Json>();
  const resources: Array<LinkedResource> = [];
  const store: KeyValueStore = {
    get: (key) => Effect.sync(() => Option.fromUndefinedOr(state.get(key))),
    set: (key, value) => Effect.sync(() => void state.set(key, value)),
    delete: (key) => Effect.sync(() => void state.delete(key)),
    list: () => Effect.sync(() => [...state.keys()]),
  };
  const emit = (event: EmittedEvent): Effect.Effect<void, PluginError> =>
    Effect.andThen(
      checkEmittedEvent(event),
      Effect.sync(() => void events.push(event)),
    );
  return {
    context: {
      emit,
      state: store,
      credentials: () => Effect.succeed({ ...credentials }),
      resources: { list: () => Effect.sync(() => [...resources]) },
    },
    events,
    state,
    resources,
  };
};
