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
export const fetchFeedResponse = (
  request: GithubRequest,
): Effect.Effect<GithubResponse, FeedError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const response = yield* requestGithub(request).pipe(
      Effect.mapError((error) => new PluginError({ message: error.message })),
    );
    if (response.status === 200 || response.status === 304) return response;
    const message = readErrorMessage(response.body);
    const githubDetail = message === undefined ? "" : `: ${message}`;
    if (response.status === 401) {
      return yield* new AuthError({
        message: `GitHub rejected the Connection's token${githubDetail}`,
      });
    }
    if (isRateLimited(response)) {
      return yield* new GithubRateLimited({
        retryAfterSeconds: yield* computeRateLimitWait(response),
      });
    }
    return yield* new PluginError({
      message: `GitHub returned status ${String(response.status)} for ${describeRequest(request)}${githubDetail}`,
    });
  });

/** Every page of one listing, or the news that it has not changed. */
interface GithubListing {
  /** True when GitHub answered the first page with 304; `items` is then empty. */
  readonly unchanged: boolean;
  /** The items of every page fetched, in GitHub's order. */
  readonly items: ReadonlyArray<Schema.JsonObject>;
  /** The first page's response, whose `ETag`, `Last-Modified` and `X-Poll-Interval` pace the next request. */
  readonly firstPage: GithubResponse;
  /** True when the listing had more pages than `maxPages` and the rest were not fetched. */
  readonly truncated: boolean;
}

/** Checks that a JSON value is an object, rather than an array, a string, a number, a boolean or null. */
const isJsonObject = (value: Schema.Json): value is Schema.JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Returns a response body GitHub sent as one object, such as a pull request,
 * for the event's `raw`. Fails with a `PluginError` when the body is not a
 * JSON object. `what` names the body in the error, such as "a pull request".
 */
export const readGithubObject = (
  body: Schema.Json,
  what: string,
): Effect.Effect<Schema.JsonObject, PluginError> =>
  isJsonObject(body)
    ? Effect.succeed(body)
    : Effect.fail(
        new PluginError({ message: `GitHub returned something other than an object for ${what}.` }),
      );

/**
 * Fetches a listing and follows its `Link` header for up to `maxPages`
 * pages. Only the first request carries the ETag or `Last-Modified`: a 304
 * on it means the whole listing is unchanged. Fails as `fetchFeedResponse` fails,
 * and with a `PluginError` when a page's body is not a JSON array of objects.
 */
export const fetchListing = (
  request: GithubRequest,
  maxPages: number,
): Effect.Effect<GithubListing, FeedError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const firstPage = yield* fetchFeedResponse(request);
    if (firstPage.status === 304) {
      return { unchanged: true, items: [], firstPage, truncated: false };
    }
    const items: Array<Schema.JsonObject> = [];
    let page = firstPage;
    let pages = 1;
    for (;;) {
      if (!Array.isArray(page.body) || !page.body.every(isJsonObject)) {
        return yield* new PluginError({
          message: `GitHub returned something other than a list of objects for ${describeRequest(request)}.`,
        });
      }
      items.push(...page.body);
      if (page.nextPageUrl === undefined) break;
      if (pages === maxPages) return { unchanged: false, items, firstPage, truncated: true };
      page = yield* fetchFeedResponse({
        method: "GET",
        path: page.nextPageUrl,
        token: request.token,
      });
      pages += 1;
    }
    return { unchanged: false, items, firstPage, truncated: false };
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

/** Returns a copy of a JSON value with every string longer than 2000 characters cut to that length. */
const truncateLongStrings = (value: Schema.Json): Schema.Json => {
  if (typeof value === "string") {
    return value.length > MAX_RAW_STRING_LENGTH ? value.slice(0, MAX_RAW_STRING_LENGTH) : value;
  }
  if (Array.isArray(value)) return value.map(truncateLongStrings);
  if (typeof value === "object" && value !== null) return truncateRaw(value as Schema.JsonObject);
  return value;
};

/**
 * Returns a copy of a GitHub object with every string longer than 2000
 * characters cut to that length. An issue body or a comment may be 65,536
 * characters long, and `raw` is kept for every event, so it is bounded here;
 * the fields a reader needs are in the payload.
 */
export const truncateRaw = (value: Schema.JsonObject): Schema.JsonObject =>
  Object.fromEntries(
    Object.entries(value).map(([key, field]) => [key, truncateLongStrings(field)]),
  );
