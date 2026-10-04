/**
 * A stub `HttpClient` for this plugin's tests. Every function that calls
 * GitHub requires an `HttpClient`, so a test provides the stub's layer and
 * reads back the requests it received.
 */
import { Effect, Layer } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpClientError from "effect/unstable/http/HttpClientError";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

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
