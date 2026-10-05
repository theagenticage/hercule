/**
 * How the feeds call GitHub: one request, or every page of a listing, with
 * GitHub's answer turned into what the host acts on.
 *
 * - 200 and 304 are answers. A 304 means nothing changed since the ETag or
 *   `Last-Modified` the request carried, and costs no quota.
 * - 401 is an `AuthError`: the token was rejected, so retrying cannot help.
 * - A rate limit (a 429, or a 403 that `isRateLimited` recognises) is
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
import {
  computeRateLimitWaitSeconds,
  isRateLimited,
  readGithubExplanation,
  requestGithub,
  type GithubRequest,
  type GithubResponse,
} from "../api";

/** GitHub asked the token to wait before its next request. */
export class GithubRateLimited extends Schema.TaggedError<GithubRateLimited>()(
  "GithubRateLimited",
  { retryAfterSeconds: Schema.Number },
) {}

/** Every way a feed's call to GitHub can fail. */
export type FeedError = AuthError | PluginError | GithubRateLimited;

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
    const explanation = readGithubExplanation(response.body);
    const githubDetail = explanation === "" ? "" : `: ${explanation}`;
    if (response.status === 401) {
      return yield* new AuthError({
        message: `GitHub rejected the Connection's token${githubDetail}`,
      });
    }
    if (isRateLimited(response)) {
      return yield* new GithubRateLimited({
        retryAfterSeconds: computeRateLimitWaitSeconds(response, yield* Clock.currentTimeMillis),
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
 * Returns the items of one page of a listing: the body itself when it is a
 * JSON array of objects, or, when `itemsField` is set, the array of objects
 * under that field of the body. Returns `undefined` when the body has
 * neither shape.
 */
const readPageItems = (
  body: Schema.Json,
  itemsField: string | undefined,
): ReadonlyArray<Schema.JsonObject> | undefined => {
  const items = itemsField === undefined ? body : isJsonObject(body) ? body[itemsField] : undefined;
  return Array.isArray(items) && items.every(isJsonObject) ? items : undefined;
};

/** How `fetchListing` reads a listing whose pages are not plain arrays. */
interface ListingOptions {
  /**
   * The field of each page's body that holds the page's items, for a listing
   * GitHub sends as an object, such as `check_suites` in
   * `{ total_count, check_suites }`. Absent when each page is an array.
   */
  readonly itemsField?: string;
}

/**
 * Fetches a listing and follows its `Link` header for up to `maxPages`
 * pages. Only the first request carries the ETag or `Last-Modified`: a 304
 * on it means the whole listing is unchanged. Fails as `fetchFeedResponse` fails,
 * and with a `PluginError` when a page's body is not a JSON array of objects
 * (or, with `itemsField`, an object holding one under that field) or the
 * `Link` header points outside GitHub's API.
 */
export const fetchListing = (
  request: GithubRequest,
  maxPages: number,
  options: ListingOptions = {},
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
      const pageItems = readPageItems(page.body, options.itemsField);
      if (pageItems === undefined) {
        const expected =
          options.itemsField === undefined
            ? "a list of objects"
            : `an object with a list of objects under \`${options.itemsField}\``;
        return yield* new PluginError({
          message: `GitHub returned something other than ${expected} for ${describeRequest(request)}.`,
        });
      }
      items.push(...pageItems);
      if (page.nextPageUrl === undefined) break;
      if (pages === maxPages) return { unchanged: false, items, firstPage, truncated: true };
      // The next page's URL comes from GitHub's `Link` header. The request
      // refuses a URL outside GitHub's API, and the error names the listing,
      // because the URL alone does not tell the user which one it was.
      page = yield* fetchFeedResponse({
        method: "GET",
        path: page.nextPageUrl,
        token: request.token,
      }).pipe(
        Effect.mapError((error) =>
          error instanceof PluginError
            ? new PluginError({
                message: `Reading the next page of ${describeRequest(request)} failed. ${error.message}`,
              })
            : error,
        ),
      );
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
