/**
 * Test support for this plugin:
 *
 * - a stub `HttpClient`. Every function that calls GitHub requires an
 *   `HttpClient`, so a test provides the stub's layer and reads back the
 *   requests it received;
 * - an ingest context that keeps its state in memory and records every event
 *   emitted, after checking it as the host would.
 */
import { Effect, Layer, Option, Schema } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpClientError from "effect/unstable/http/HttpClientError";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import {
  PluginError,
  type EmitEvent,
  type IngestContext,
  type KeyValueStore,
  type LinkedResource,
} from "@hercule/plugin-host";
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
export const buildStubResponse = (
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
  readonly events: Array<EmitEvent>;
  /** The Connection's state, by key. */
  readonly state: Map<string, Schema.Json>;
  /** The Resources linked to the Connection; a test may change them between polls. */
  readonly resources: Array<LinkedResource>;
}

/**
 * Builds an ingest context whose credentials hold `credentials`, whose state
 * lives in a `Map`, and whose `emit` records each event. Like the host's,
 * `emit` fails with a `PluginError` when the kind is not one the plugin
 * declares, or the payload does not match the kind's schema exactly.
 */
export const buildIngestHarness = (
  credentials: Readonly<Record<string, string>> = { pat: "ghp_test-token" },
): IngestHarness => {
  const events: Array<EmitEvent> = [];
  const state = new Map<string, Schema.Json>();
  const resources: Array<LinkedResource> = [];
  const store: KeyValueStore = {
    get: (key) => Effect.sync(() => Option.fromUndefinedOr(state.get(key))),
    set: (key, value) => Effect.sync(() => void state.set(key, value)),
    delete: (key) => Effect.sync(() => void state.delete(key)),
    list: () => Effect.sync(() => [...state.keys()]),
  };
  const emit = (event: EmitEvent): Effect.Effect<void, PluginError> => {
    const declaration = GITHUB_EVENT_KINDS[event.kind];
    if (declaration === undefined) {
      return Effect.fail(new PluginError({ message: `Undeclared kind ${event.kind}` }));
    }
    return Schema.decodeUnknownEffect(declaration.schema as Schema.Codec<unknown>, {
      onExcessProperty: "error",
    })(event.payload).pipe(
      Effect.mapError((error) => new PluginError({ message: `${event.kind}: ${error.message}` })),
      Effect.andThen(() => Effect.sync(() => void events.push(event))),
    );
  };
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
