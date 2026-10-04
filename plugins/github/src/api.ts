/**
 * GitHub's REST API, as every part of this plugin calls it: the token check,
 * the ingest feeds and the workflow actions. One function sends one request
 * and returns what the response held, so every caller reads the same headers
 * the same way.
 */
import { Effect, Schema } from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

/** The root every REST path is appended to. */
export const GITHUB_API_URL = "https://api.github.com";

/** GitHub rejects a request without a user agent, so one is always sent. */
const USER_AGENT = "Hercule";

/** The REST API version this plugin was written against. */
const API_VERSION = "2022-11-28";

/** One request to GitHub's REST API. */
export interface GithubRequest {
  readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** The path below the API root, such as `/repos/owner/repo/issues/42`. */
  readonly path: string;
  readonly token: string;
  readonly query?: Readonly<Record<string, string>>;
  /** Sent as JSON. */
  readonly body?: unknown;
  /** The `ETag` of an earlier response, sent as `If-None-Match`. */
  readonly etag?: string;
  /** The `Last-Modified` of an earlier response, sent as `If-Modified-Since`. */
  readonly lastModified?: string;
}

/** What one response held. */
export interface GithubResponse {
  readonly status: number;
  /** The parsed JSON body, or null when there was none, as on a 304 or a 204. */
  readonly body: Schema.Json;
  readonly etag?: string;
  readonly lastModified?: string;
  /** `X-Poll-Interval`: the shortest wait GitHub allows before the next poll, in seconds. */
  readonly pollIntervalSeconds?: number;
  /** `Retry-After`, in seconds, sent with a rate limit or a server error. */
  readonly retryAfterSeconds?: number;
  /** `Link: <...>; rel="next"`: the URL of the next page, when there is one. */
  readonly nextPageUrl?: string;
}

/** GitHub could not be reached, or its response could not be read. */
export class GithubUnreachable extends Schema.TaggedError<GithubUnreachable>()(
  "GithubUnreachable",
  { message: Schema.String },
) {}

/** Parses a header that holds a whole number of seconds. Returns undefined for anything else. */
const parseSeconds = (value: string | undefined): number | undefined => {
  if (value === undefined || !/^\d+$/.test(value.trim())) return undefined;
  return Number(value.trim());
};

/** Returns the `rel="next"` URL of a `Link` header, or undefined when there is none. */
const parseNextPageUrl = (link: string | undefined): string | undefined =>
  link
    ?.split(",")
    .map((part) => /<([^>]+)>;\s*rel="next"/.exec(part)?.[1])
    .find((url) => url !== undefined);

/**
 * Sends one request to GitHub's REST API and returns its status, body and the
 * headers that pace the next request. Any status is returned as it is: the
 * caller decides what a 401 or a 404 means for it. Fails with
 * `GithubUnreachable` only when no response arrived or its body was not JSON.
 *
 * `path` may also be a full URL, which is how a caller follows `nextPageUrl`.
 */
export const requestGithub = (
  request: GithubRequest,
): Effect.Effect<GithubResponse, GithubUnreachable> =>
  Effect.gen(function* () {
    const url = request.path.startsWith("https://")
      ? request.path
      : `${GITHUB_API_URL}${request.path}`;
    let outgoing = HttpClientRequest.make(request.method)(url, {
      headers: {
        authorization: `Bearer ${request.token}`,
        accept: "application/vnd.github+json",
        "user-agent": USER_AGENT,
        "x-github-api-version": API_VERSION,
        ...(request.etag === undefined ? {} : { "if-none-match": request.etag }),
        ...(request.lastModified === undefined
          ? {}
          : { "if-modified-since": request.lastModified }),
      },
      ...(request.query === undefined ? {} : { urlParams: request.query }),
    });
    if (request.body !== undefined) {
      outgoing = HttpClientRequest.bodyJsonUnsafe(outgoing, request.body);
    }
    const response = yield* HttpClient.execute(outgoing).pipe(
      Effect.mapError(
        (error) =>
          new GithubUnreachable({ message: `GitHub could not be reached: ${error.message}` }),
      ),
    );
    const text = yield* response.text.pipe(
      Effect.mapError(
        (error) =>
          new GithubUnreachable({
            message: `GitHub's response could not be read: ${error.message}`,
          }),
      ),
    );
    const body = yield* Effect.try({
      try: (): Schema.Json => (text.length === 0 ? null : (JSON.parse(text) as Schema.Json)),
      catch: () =>
        new GithubUnreachable({ message: "GitHub answered with a body that is not JSON." }),
    });
    const header = (name: string): string | undefined => response.headers[name];
    const etag = header("etag");
    const lastModified = header("last-modified");
    const pollIntervalSeconds = parseSeconds(header("x-poll-interval"));
    const retryAfterSeconds = parseSeconds(header("retry-after"));
    const nextPageUrl = parseNextPageUrl(header("link"));
    return {
      status: response.status,
      body,
      ...(etag === undefined ? {} : { etag }),
      ...(lastModified === undefined ? {} : { lastModified }),
      ...(pollIntervalSeconds === undefined ? {} : { pollIntervalSeconds }),
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
      ...(nextPageUrl === undefined ? {} : { nextPageUrl }),
    };
  }).pipe(Effect.provide(FetchHttpClient.layer));

/**
 * Returns the token in a GitHub Connection's credentials: the pasted `pat`
 * field, or the `accessToken` the device flow obtained. Returns undefined when
 * neither is there.
 */
export const readToken = (credentials: Readonly<Record<string, string>>): string | undefined =>
  credentials["pat"] ?? credentials["accessToken"];
