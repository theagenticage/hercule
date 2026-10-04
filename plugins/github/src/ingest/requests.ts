/**
 * How the feeds call GitHub: one request, or every page of a listing, with
 * GitHub's answer turned into what the host acts on.
 *
 * - 200 and 304 are answers. A 304 means nothing changed since the ETag or
 *   `Last-Modified` the request carried, and costs no quota.
 * - 401 is an `AuthError`: the token was rejected, so retrying cannot help.
 * - A rate limit (a 429, or a 403 with `Retry-After` or no requests left) is
 *   `GithubRateLimited`. The feed stops its tick there, and the poll succeeds
 *   with `nextAfterSeconds` set to the wait GitHub asked for. A rate limit is
 *   GitHub pacing the token, not a fault in the Connection, so it must not
 *   count toward the five failures that set the Connection to `error`.
 * - Anything else, and a request that never reached GitHub, is a
 *   `PluginError`, which the host retries with backoff.
 */
import { Clock, Effect, Schema } from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import { AuthError, PluginError } from "@hercule/plugin-host";
import { isRateLimited, requestGithub, type GithubRequest, type GithubResponse } from "../api";

/** GitHub asked the token to wait before its next request. */
export class GithubRateLimited extends Schema.TaggedError<GithubRateLimited>()(
  "GithubRateLimited",
  { retryAfterSeconds: Schema.Number },
) {}

/** Every way a feed's call to GitHub can fail. */
export type FeedError = AuthError | PluginError | GithubRateLimited;

/** The wait used when GitHub reports a rate limit without saying for how long. */
const DEFAULT_RATE_LIMIT_WAIT_SECONDS = 60;

/** Returns GitHub's own error message from a response body, when it has one. */
const readErrorMessage = (body: Schema.Json): string | undefined => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const message = (body as Record<string, Schema.Json>)["message"];
  return typeof message === "string" ? message : undefined;
};

/**
 * Returns how long a rate-limited token must wait, in seconds: `Retry-After`
 * when GitHub sent it, else the time until `X-RateLimit-Reset`, else one
 * minute.
 */
const computeRateLimitWait = (response: GithubResponse): Effect.Effect<number> =>
  Effect.map(Clock.currentTimeMillis, (now) => {
    if (response.retryAfterSeconds !== undefined) return response.retryAfterSeconds;
    if (response.rateLimitResetAt !== undefined) {
      return Math.max(1, response.rateLimitResetAt - Math.floor(now / 1000));
    }
    return DEFAULT_RATE_LIMIT_WAIT_SECONDS;
  });

/** Returns how a request is named in an error message, such as `GET /notifications`. */
const describeRequest = (request: GithubRequest): string => `${request.method} ${request.path}`;

/**
 * Sends one request and returns the response when its status is 200 or 304.
 * Fails with `AuthError` on a 401, with `GithubRateLimited` on a rate limit,
 * and with a `PluginError` that names the request and GitHub's message for
 * any other status or when GitHub could not be reached.
 */
export const fetchGithub = (
  request: GithubRequest,
): Effect.Effect<GithubResponse, FeedError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const response = yield* requestGithub(request).pipe(
      Effect.mapError((error) => new PluginError({ message: error.message })),
    );
    if (response.status === 200 || response.status === 304) return response;
    const message = readErrorMessage(response.body);
    const said = message === undefined ? "" : `: ${message}`;
    if (response.status === 401) {
      return yield* new AuthError({ message: `GitHub rejected the Connection's token${said}` });
    }
    if (isRateLimited(response)) {
      return yield* new GithubRateLimited({
        retryAfterSeconds: yield* computeRateLimitWait(response),
      });
    }
    return yield* new PluginError({
      message: `GitHub returned status ${String(response.status)} for ${describeRequest(request)}${said}`,
    });
  });

/** Every page of one listing, or the news that it has not changed. */
export interface GithubListing {
  /** True when GitHub answered the first page with 304; `items` is then empty. */
  readonly unchanged: boolean;
  /** The items of every page fetched, in GitHub's order. */
  readonly items: ReadonlyArray<Schema.Json>;
  /** The first page's response, whose `ETag`, `Last-Modified` and `X-Poll-Interval` pace the next request. */
  readonly first: GithubResponse;
  /** True when the listing had more pages than `maxPages` and the rest were not fetched. */
  readonly truncated: boolean;
}

/**
 * Fetches a listing and follows its `Link` header for up to `maxPages`
 * pages. Only the first request carries the ETag or `Last-Modified`: a 304
 * on it means the whole listing is unchanged. Fails as `fetchGithub` fails,
 * and with a `PluginError` when a page's body is not a JSON array.
 */
export const fetchListing = (
  request: GithubRequest,
  maxPages: number,
): Effect.Effect<GithubListing, FeedError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const first = yield* fetchGithub(request);
    if (first.status === 304) return { unchanged: true, items: [], first, truncated: false };
    const items: Array<Schema.Json> = [];
    let page = first;
    let pages = 1;
    for (;;) {
      if (!Array.isArray(page.body)) {
        return yield* new PluginError({
          message: `GitHub returned something other than a list for ${describeRequest(request)}.`,
        });
      }
      items.push(...(page.body as ReadonlyArray<Schema.Json>));
      if (page.nextPageUrl === undefined) break;
      if (pages === maxPages) return { unchanged: false, items, first, truncated: true };
      page = yield* fetchGithub({ method: "GET", path: page.nextPageUrl, token: request.token });
      pages += 1;
    }
    return { unchanged: false, items, first, truncated: false };
  });

/**
 * Decodes a value GitHub returned against the schema of the fields a feed
 * reads. Fails with a `PluginError` naming `what` when the value does not
 * have them.
 */
export const decodeGithubValue = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: unknown,
  what: string,
): Effect.Effect<S["Type"], PluginError> =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(
      (error) =>
        new PluginError({
          message: `GitHub returned ${what} without the expected fields: ${error.message}`,
        }),
    ),
  );

/** The longest string kept in an event's `raw`, in UTF-16 code units. */
const MAX_RAW_STRING_LENGTH = 2000;

/**
 * Returns a copy of a GitHub object with every string longer than 2000
 * characters cut to that length. An issue body or a comment may be 65,536
 * characters long, and `raw` is kept for every event, so it is bounded here;
 * the fields a reader needs are in the payload.
 */
export const truncateRaw = (value: Schema.Json): Schema.Json => {
  if (typeof value === "string") {
    return value.length > MAX_RAW_STRING_LENGTH ? value.slice(0, MAX_RAW_STRING_LENGTH) : value;
  }
  if (Array.isArray(value)) return value.map(truncateRaw);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, Schema.Json>).map(([key, field]) => [
        key,
        truncateRaw(field),
      ]),
    );
  }
  return value;
};
