/**
 * Sentry's REST API, as every part of this plugin calls it: the token check,
 * the choices of the config form, the ingest feed and the workflow actions.
 * One function sends one request and returns what the response held, so every
 * caller reads the headers the same way.
 */
import { Clock, Duration, Effect, Option, Schema } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { AuthError, PluginError } from "@hercule/plugin-host";
import { cutText } from "./text";

/**
 * The host the actions call. It answers every organization endpoint, so they
 * need no lookup of the organization's region. Ingest calls the
 * organization's own region host instead.
 */
export const SENTRY_API_URL = "https://sentry.io";

/** Sentry rejects a request without a user agent it can name, so one is always sent. */
const USER_AGENT = "Hercule";

/**
 * How long one request may take, from sending it to reading the whole
 * response. Without a limit, a connection Sentry never answers would hold a
 * poll or a workflow step forever.
 */
export const SENTRY_REQUEST_TIMEOUT = Duration.seconds(30);

/**
 * How long to wait after a rate limit when Sentry does not say when its
 * window ends.
 */
const DEFAULT_RATE_LIMIT_WAIT_SECONDS = 60;

/** The most characters of Sentry's response that an error message quotes. */
const MAX_FAILURE_DETAIL_LENGTH = 1000;

/** The message of every failure that means the token is no longer accepted. */
export const TOKEN_REFUSED_MESSAGE = "Sentry refused the token; reconnect the Connection";

/** One request to Sentry's REST API. */
export interface SentryRequest {
  readonly method: "GET" | "PUT";
  /** The host the request goes to, such as `https://us.sentry.io`. Must be on `sentry.io`. */
  readonly baseUrl: string;
  /** The path below the host, such as `/api/0/organizations/`. */
  readonly path: string;
  readonly token: string;
  /** Query parameters as pairs, because Sentry takes a repeated name (`project`, `group`) as a list. */
  readonly query?: ReadonlyArray<readonly [string, string]>;
  /** Sent as JSON. */
  readonly body?: unknown;
}

/** What one response held. */
export interface SentryResponse {
  readonly status: number;
  /** The parsed JSON body, or null when there was none. */
  readonly body: Schema.Json;
  /** The cursor of the next page, when the `Link` header says there is one. */
  readonly nextCursor?: string;
  /** `x-sentry-rate-limit-reset`: when the current rate-limit window ends, in seconds since the epoch. */
  readonly rateLimitResetAt?: number;
}

/**
 * Sentry refused the request because the Connection sent too many. This is
 * not a failure: an ingest poll stops and asks the host to wait
 * `retryAfterSeconds`, and an action or a form shows `message`.
 */
export class SentryRateLimited extends Schema.TaggedError<SentryRateLimited>()(
  "SentryRateLimited",
  { message: Schema.String, retryAfterSeconds: Schema.Number },
) {}

/**
 * No answer from Sentry arrived: it could not be reached, its response could
 * not be read, or it took too long. Unlike every other failure of a request,
 * trying again later may work. `callSentry` turns it into a `PluginError`;
 * an action reads it to report the failure as `unavailable`.
 */
export class SentryUnreachable extends Schema.TaggedError<SentryUnreachable>()(
  "SentryUnreachable",
  { message: Schema.String },
) {}

/** Everything a call to Sentry can fail with. */
export type SentryFailure = AuthError | PluginError | SentryRateLimited;

/**
 * Checks that an origin is on `sentry.io`: `https://sentry.io` or one of its
 * subdomains, such as the region host `https://us.sentry.io`. A request
 * carries the Connection's token, so it is sent nowhere else.
 */
const isSentryOrigin = (origin: string): boolean => {
  if (!URL.canParse(origin)) return false;
  const url = new URL(origin);
  return (
    url.protocol === "https:" &&
    url.port === "" &&
    (url.hostname === "sentry.io" || url.hostname.endsWith(".sentry.io"))
  );
};

/**
 * Returns the cursor of the next page from a `Link` header, or undefined when
 * there is none. Sentry always sends a `rel="next"` link, even on the last
 * page, and marks it `results="false"` there, so the marker decides.
 */
const parseNextCursor = (link: string | undefined): string | undefined => {
  const next = link?.split(/,\s*(?=<)/).find((part) => /rel="next"/.test(part));
  if (next === undefined || !/results="true"/.test(next)) return undefined;
  return /cursor="([^"]*)"/.exec(next)?.[1];
};

/** Parses a header that holds a whole number. Returns undefined for anything else. */
const parseWholeNumber = (value: string | undefined): number | undefined =>
  value === undefined || !/^\d+$/.test(value.trim()) ? undefined : Number(value.trim());

/** Returns true for the statuses `callSentry` classifies without looking at the body: a refused token and a rate limit. */
const isBodyIgnored = (status: number): boolean => status === 401 || status === 429;

/**
 * Sends one request to Sentry's REST API and returns its status, body, next
 * page cursor and rate-limit reset. Any status is returned as it is: the
 * caller decides what a 403 or a 404 means for it. Fails with:
 *
 * - `SentryUnreachable` when no response arrived, the body of a 2xx response
 *   could not be read, or the whole response did not arrive within
 *   `SENTRY_REQUEST_TIMEOUT`;
 * - a `PluginError` when the host is not on `sentry.io`, so the request is not
 *   sent at all, or when the body of a 2xx response was not JSON. The body of
 *   a 401 or a 429 is never read, and is returned as null, so a body that
 *   stalls or fails changes nothing. The body of any other status is returned
 *   as null when it is not JSON or cannot be read.
 *
 * The `HttpClient` stays a requirement: the plugin provides the fetch client
 * only where the host calls in, so a test can drive any function below that
 * point with a stub client (see `testing.ts`).
 */
export const requestSentry = (
  request: SentryRequest,
): Effect.Effect<SentryResponse, PluginError | SentryUnreachable, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    if (!isSentryOrigin(request.baseUrl)) {
      return yield* new PluginError({
        message: `The request to ${request.baseUrl} was not sent, because it would carry the Sentry token and only sentry.io may receive it.`,
      });
    }
    const url = new URL(request.path, request.baseUrl);
    // A path such as `//example.com/x` would otherwise replace the host.
    if (!isSentryOrigin(url.origin)) {
      return yield* new PluginError({
        message: `The request to ${url.origin} was not sent, because it would carry the Sentry token and only sentry.io may receive it.`,
      });
    }
    let outgoing = HttpClientRequest.make(request.method)(url.toString(), {
      headers: {
        authorization: `Bearer ${request.token}`,
        accept: "application/json",
        "user-agent": USER_AGENT,
      },
      ...(request.query === undefined ? {} : { urlParams: request.query }),
    });
    if (request.body !== undefined) {
      outgoing = HttpClientRequest.bodyJsonUnsafe(outgoing, request.body);
    }
    const { response, text } = yield* Effect.gen(function* () {
      const response = yield* HttpClient.execute(outgoing).pipe(
        Effect.mapError(
          (error) =>
            new SentryUnreachable({ message: `Sentry could not be reached: ${error.message}` }),
        ),
      );
      // A 401 and a 429 are classified from the status and headers alone, so
      // their body is never read: a body that stalls or fails changes nothing.
      if (isBodyIgnored(response.status)) return { response, text: "" };
      // The body of any other failure is optional too, so one that cannot be
      // read is no body. Only a successful response needs its body.
      const isSuccess = response.status >= 200 && response.status < 300;
      const text = yield* response.text.pipe(
        Effect.catch((error) =>
          isSuccess
            ? Effect.fail(
                new SentryUnreachable({
                  message: `Sentry's response could not be read: ${error.message}`,
                }),
              )
            : Effect.succeed(""),
        ),
      );
      return { response, text };
    }).pipe(
      Effect.timeoutOrElse({
        duration: SENTRY_REQUEST_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new SentryUnreachable({
              message: `Sentry did not answer ${request.method} ${url.pathname} within ${String(Duration.toSeconds(SENTRY_REQUEST_TIMEOUT))} seconds.`,
            }),
          ),
      }),
    );
    const isSuccess = response.status >= 200 && response.status < 300;
    const body = yield* Effect.try({
      try: (): Schema.Json => (text.length === 0 ? null : (JSON.parse(text) as Schema.Json)),
      // The status decides first. A proxy's HTML page in front of a 401 or a
      // 429 is still a refused token or a rate limit, so only the body of a
      // successful response has to be JSON; any other body becomes null.
      catch: () => new PluginError({ message: "Sentry answered with a body that is not JSON." }),
    }).pipe(
      Effect.catchTag("PluginError", (error) =>
        isSuccess ? Effect.fail(error) : Effect.succeed<Schema.Json>(null),
      ),
    );
    const nextCursor = parseNextCursor(response.headers["link"]);
    const rateLimitResetAt = parseWholeNumber(response.headers["x-sentry-rate-limit-reset"]);
    return {
      status: response.status,
      body,
      ...(nextCursor === undefined ? {} : { nextCursor }),
      ...(rateLimitResetAt === undefined ? {} : { rateLimitResetAt }),
    };
  });

/** The part of Sentry's error body the plugin reads. */
const SentryErrorBody = Schema.Struct({ detail: Schema.optionalKey(Schema.String) });

const decodeSentryErrorBody = Schema.decodeUnknownOption(SentryErrorBody);

/** Returns Sentry's own explanation in an error body (its `detail`), or an empty string. */
export const readSentryExplanation = (body: Schema.Json): string =>
  Option.getOrUndefined(decodeSentryErrorBody(body))?.detail ?? "";

/**
 * Returns how many seconds to wait after a rate limit: until the window ends,
 * at least one second, or one minute when Sentry gave no end. `nowMillis` is
 * the current time, in milliseconds since the epoch.
 */
export const computeRateLimitWaitSeconds = (
  response: Pick<SentryResponse, "rateLimitResetAt">,
  nowMillis: number,
): number =>
  response.rateLimitResetAt === undefined
    ? DEFAULT_RATE_LIMIT_WAIT_SECONDS
    : Math.max(1, response.rateLimitResetAt - Math.floor(nowMillis / 1000));

/**
 * Sends one request and returns the response when its status is 2xx or one
 * of `tolerate`. Fails with:
 *
 * - `AuthError` on a 401, because only the user can fix a refused token;
 * - `SentryRateLimited` on a 429, with the wait Sentry asked for;
 * - a `PluginError` naming the request on any other status. A 403 adds that
 *   the token may not read it, or that a configured project is gone or
 *   hidden, because Sentry answers an unknown project id with a 403.
 */
export const callSentry = (
  request: SentryRequest,
  tolerate: ReadonlyArray<number> = [],
): Effect.Effect<SentryResponse, SentryFailure, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const response = yield* requestSentry(request).pipe(
      Effect.catchTag("SentryUnreachable", (error) =>
        Effect.fail(new PluginError({ message: error.message })),
      ),
    );
    if ((response.status >= 200 && response.status < 300) || tolerate.includes(response.status)) {
      return response;
    }
    if (response.status === 401) return yield* new AuthError({ message: TOKEN_REFUSED_MESSAGE });
    if (response.status === 429) {
      const retryAfterSeconds = computeRateLimitWaitSeconds(
        response,
        yield* Clock.currentTimeMillis,
      );
      return yield* new SentryRateLimited({
        message: `Sentry rate limited the Connection; it asked to wait ${String(retryAfterSeconds)} seconds.`,
        retryAfterSeconds,
      });
    }
    const explanation = readSentryExplanation(response.body);
    const hint =
      response.status === 403
        ? " The token may not read it, or a project in the Connection's settings is gone or hidden."
        : "";
    return yield* new PluginError({
      message: `Sentry answered ${String(response.status)} to ${request.method} ${request.path}.${hint}${explanation === "" ? "" : ` Sentry said: ${explanation}`}`,
    });
  });

/**
 * Decodes the body of a Sentry response with `schema`. Fails with a
 * `PluginError` naming the request when the body has another shape, which
 * happens only when Sentry changes its API.
 */
export const decodeSentryBody = <S extends Schema.Decoder<unknown>>(
  schema: S,
  body: Schema.Json,
  path: string,
): Effect.Effect<S["Type"], PluginError> =>
  Effect.mapError(
    Schema.decodeUnknownEffect(schema)(body),
    (error) =>
      new PluginError({
        // The message quotes the value that failed, which can be as long as the response.
        message: `Sentry's answer to ${path} did not have the expected shape: ${cutText(error.message, MAX_FAILURE_DETAIL_LENGTH)}`,
      }),
  );

/** The items of a list read page by page. */
export interface PagedItems<A> {
  readonly items: ReadonlyArray<A>;
  /** True when Sentry had more pages than `maxPages`, so `items` is a part of the list. */
  readonly hasMore: boolean;
}

/**
 * Reads a list endpoint page by page, following the `Link` cursor, and
 * decodes every page as an array of `item`. Stops after `maxPages` pages and
 * says so with `hasMore`, so the caller decides whether a partial list is
 * acceptable. The cursor is sent as a parameter rather than followed as a
 * URL, so the token only ever goes to the host of the first request.
 */
export const readPages = <S extends Schema.Decoder<unknown>>(
  request: SentryRequest,
  item: S,
  maxPages: number,
): Effect.Effect<PagedItems<S["Type"]>, SentryFailure, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const items: Array<S["Type"]> = [];
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page += 1) {
      const response = yield* callSentry({
        ...request,
        query: [
          ...(request.query ?? []),
          ...(cursor === undefined ? [] : [["cursor", cursor] as const]),
        ],
      });
      items.push(...(yield* decodeSentryBody(Schema.Array(item), response.body, request.path)));
      cursor = response.nextCursor;
      if (cursor === undefined) return { items, hasMore: false };
    }
    return { items, hasMore: true };
  });

/**
 * Returns the token in a Sentry Connection's credentials: the
 * `accessToken` the device flow obtained, or the pasted `token` field.
 * Returns undefined when neither is there.
 */
export const readToken = (credentials: Readonly<Record<string, string>>): string | undefined =>
  credentials["accessToken"] ?? credentials["token"];
