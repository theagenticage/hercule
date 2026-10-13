/**
 * Linear's GraphQL API, as every part of this plugin calls it: the credential
 * check, the choices of the config form and both ingest feeds. Every call is
 * one named query, sent with its variables to the one endpoint, so a test's
 * fake Linear can tell the queries apart by name.
 */
import { Clock, Duration, Effect, Option, Schema } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { AuthError, PluginError } from "@hercule/plugin-host";
import { cutText } from "./text";

/** The one endpoint of Linear's API. */
export const LINEAR_API_URL = "https://api.linear.app/graphql";

/**
 * How long one request may take, from sending it to reading the whole
 * response. Without a limit, a connection Linear never answers would hold a
 * poll forever.
 */
export const LINEAR_REQUEST_TIMEOUT = Duration.seconds(30);

/** How long to wait after a rate limit when Linear names no time to wait until. */
const DEFAULT_RATE_LIMIT_WAIT_SECONDS = 60;

/** The most characters of Linear's response that an error message quotes. */
const MAX_FAILURE_DETAIL_LENGTH = 1000;

/** The largest page Linear serves. A larger `first` is refused as invalid input. */
export const MAX_PAGE_SIZE = 250;

/** The message of every failure that means the credential is no longer accepted. */
export const CREDENTIAL_REFUSED_MESSAGE = "Linear refused the credential; reconnect the Connection";

/** One GraphQL query: its operation name, its text and its variables. */
export interface LinearQuery {
  /** The operation name the text declares, such as `LinearViewer`. Error messages name it. */
  readonly name: string;
  readonly text: string;
  readonly variables?: Readonly<Record<string, unknown>>;
}

/**
 * Linear refused the request because the user sent too many. This is not a
 * failure: an ingest poll stops and asks the host to wait
 * `retryAfterSeconds`, and a form shows `message`.
 */
export class LinearRateLimited extends Schema.TaggedError<LinearRateLimited>()(
  "LinearRateLimited",
  { message: Schema.String, retryAfterSeconds: Schema.Number },
) {}

/** Everything a call to Linear can fail with. */
export type LinearFailure = AuthError | PluginError | LinearRateLimited;

/** The part of a GraphQL response the plugin reads beside `data`. */
const GraphQLErrors = Schema.Struct({
  errors: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        message: Schema.optionalKey(Schema.String),
        extensions: Schema.optionalKey(
          Schema.Struct({
            code: Schema.optionalKey(Schema.String),
            type: Schema.optionalKey(Schema.String),
          }),
        ),
      }),
    ),
  ),
});

type GraphQLError = NonNullable<Schema.Schema.Type<typeof GraphQLErrors>["errors"]>[number];

const decodeGraphQLErrors = Schema.decodeUnknownOption(GraphQLErrors);

/** Parses a header that holds a whole number. Returns undefined for anything else. */
const parseWholeNumber = (value: string | undefined): number | undefined =>
  value === undefined || !/^\d+$/.test(value.trim()) ? undefined : Number(value.trim());

/**
 * Returns how many seconds to wait after a rate limit, at least one:
 *
 * - the `retry-after` header, in seconds, when Linear sent it;
 * - else until the reset of the limit that ran out, from
 *   `x-ratelimit-requests-reset` when no requests remain, else from
 *   `x-ratelimit-complexity-reset`. Both are epoch milliseconds;
 * - else one minute.
 */
export const computeRateLimitWaitSeconds = (
  headers: Readonly<Record<string, string | undefined>>,
  nowMillis: number,
): number => {
  const retryAfter = parseWholeNumber(headers["retry-after"]);
  if (retryAfter !== undefined) return Math.max(1, retryAfter);
  const requestsRanOut = parseWholeNumber(headers["x-ratelimit-requests-remaining"]) === 0;
  const resetAt =
    parseWholeNumber(
      headers[requestsRanOut ? "x-ratelimit-requests-reset" : "x-ratelimit-complexity-reset"],
    ) ??
    parseWholeNumber(headers["x-ratelimit-requests-reset"]) ??
    parseWholeNumber(headers["x-ratelimit-complexity-reset"]);
  return resetAt === undefined
    ? DEFAULT_RATE_LIMIT_WAIT_SECONDS
    : Math.max(1, Math.ceil((resetAt - nowMillis) / 1000));
};

/** Checks whether a GraphQL error is Linear's rate limit, by its code or by the type the SDK reads. */
const isRateLimit = (error: GraphQLError): boolean =>
  error.extensions?.code === "RATELIMITED" || error.extensions?.type === "ratelimited";

/** Checks whether a GraphQL error is Linear refusing the credential. */
const isAuthenticationError = (error: GraphQLError): boolean =>
  error.extensions?.code === "AUTHENTICATION_ERROR";

/**
 * Returns the `Authorization` header for a Linear Connection's credentials:
 * `Bearer <token>` for the `accessToken` of the redirect flow, or the pasted
 * `apiKey` as it is, because Linear refuses a personal API key sent with
 * `Bearer`. Returns undefined when the credentials hold neither.
 */
export const buildAuthorization = (
  credentials: Readonly<Record<string, string>>,
): string | undefined => {
  const accessToken = credentials["accessToken"];
  if (accessToken !== undefined) return `Bearer ${accessToken}`;
  return credentials["apiKey"];
};

/**
 * Sends one query to Linear and returns its `data`, decoded with `schema`.
 * Fails with:
 *
 * - `AuthError` on a 401 or an `AUTHENTICATION_ERROR`, because only the user
 *   can fix a refused credential;
 * - `LinearRateLimited` when an error has the code `RATELIMITED`, which Linear
 *   sends with a 400, not a 429. The wait comes from the headers, as
 *   `computeRateLimitWaitSeconds` says;
 * - a `PluginError` naming the query when Linear cannot be reached or does not
 *   answer within `LINEAR_REQUEST_TIMEOUT`, on any other status that is not
 *   2xx, when a 200 carries `errors` (Linear can answer part of a query, and a
 *   part is never taken for the whole), and when `data` has another shape.
 *
 * The `HttpClient` stays a requirement: the plugin provides the fetch client
 * only where the host calls in, so a test can drive any function below that
 * point with a fake Linear (see `testing.ts`).
 */
export const callLinear = <S extends Schema.Decoder<unknown>>(
  authorization: string,
  query: LinearQuery,
  schema: S,
): Effect.Effect<S["Type"], LinearFailure, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const request = HttpClientRequest.post(LINEAR_API_URL, {
      headers: { authorization, accept: "application/json" },
    }).pipe(
      HttpClientRequest.bodyJsonUnsafe({
        query: query.text,
        operationName: query.name,
        variables: query.variables ?? {},
      }),
    );
    const { status, headers, text } = yield* Effect.gen(function* () {
      const response = yield* HttpClient.execute(request);
      // The body of a failed response is optional, so one that cannot be read is no body.
      const isSuccess = response.status >= 200 && response.status < 300;
      const text = isSuccess
        ? yield* response.text
        : yield* response.text.pipe(Effect.catch(() => Effect.succeed("")));
      return { status: response.status, headers: response.headers, text };
    }).pipe(
      Effect.mapError(
        (error) =>
          new PluginError({
            message: `Linear could not be reached for ${query.name}: ${error.message}`,
          }),
      ),
      Effect.timeoutOrElse({
        duration: LINEAR_REQUEST_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new PluginError({
              message: `Linear did not answer ${query.name} within ${String(Duration.toSeconds(LINEAR_REQUEST_TIMEOUT))} seconds.`,
            }),
          ),
      }),
    );
    const body = parseJson(text);
    const errors = Option.getOrUndefined(decodeGraphQLErrors(body))?.errors ?? [];
    if (status === 401 || errors.some(isAuthenticationError)) {
      return yield* new AuthError({ message: CREDENTIAL_REFUSED_MESSAGE });
    }
    if (errors.some(isRateLimit)) {
      const retryAfterSeconds = computeRateLimitWaitSeconds(
        headers,
        yield* Clock.currentTimeMillis,
      );
      return yield* new LinearRateLimited({
        message: `Linear rate limited the Connection; it asked to wait ${String(retryAfterSeconds)} seconds.`,
        retryAfterSeconds,
      });
    }
    const explanation = errors.map((error) => error.message ?? "").filter((m) => m !== "");
    const said =
      explanation.length === 0
        ? ""
        : ` Linear said: ${cutText(explanation.join("; "), MAX_FAILURE_DETAIL_LENGTH)}`;
    if (status < 200 || status >= 300) {
      return yield* new PluginError({
        message: `Linear answered ${String(status)} to ${query.name}.${said}`,
      });
    }
    if (errors.length > 0) {
      return yield* new PluginError({
        message: `Linear answered ${query.name} with errors.${said}`,
      });
    }
    return yield* decodeLinearData(schema, body, query.name);
  });

/** Parses a response body as JSON. Returns null when it is empty or not JSON. */
const parseJson = (text: string): unknown => {
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
};

/** A GraphQL response that has `data`, before the data itself is decoded. */
const GraphQLData = Schema.Struct({ data: Schema.Unknown });

/**
 * Decodes the `data` of a GraphQL response with `schema`. Fails with a
 * `PluginError` naming the query when the response has no `data` or its
 * `data` has another shape, which happens only when Linear changes its API.
 */
const decodeLinearData = <S extends Schema.Decoder<unknown>>(
  schema: S,
  body: unknown,
  name: string,
): Effect.Effect<S["Type"], PluginError> =>
  Schema.decodeUnknownEffect(GraphQLData)(body).pipe(
    Effect.flatMap(({ data }) => Schema.decodeUnknownEffect(schema)(data)),
    Effect.mapError(
      (error) =>
        new PluginError({
          // The message quotes the value that failed, which can be as long as the response.
          message: `Linear's answer to ${name} did not have the expected shape: ${cutText(error.message, MAX_FAILURE_DETAIL_LENGTH)}`,
        }),
    ),
  );

/** The page info of a GraphQL connection, which says whether there is a next page. */
const PageInfo = Schema.Struct({
  hasNextPage: Schema.Boolean,
  endCursor: Schema.NullOr(Schema.String),
});

/** The items of a list read page by page. */
export interface PagedItems<A> {
  readonly items: ReadonlyArray<A>;
  /** True when Linear had more pages than `maxPages`, so `items` is a part of the list. */
  readonly hasMore: boolean;
}

/**
 * Reads a list query page by page and returns its items. The query's list is
 * the root field `field`, and the query takes `$first` and `$after`. Each
 * page asks for `MAX_PAGE_SIZE` items. Stops after `maxPages` pages and says
 * so with `hasMore`, so the caller decides whether a partial list is
 * acceptable. Fails as `callLinear` does.
 */
export const readPages = <S extends Schema.Decoder<unknown>>(
  authorization: string,
  query: LinearQuery,
  field: string,
  item: S,
  maxPages: number,
): Effect.Effect<PagedItems<S["Type"]>, LinearFailure, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const page = Schema.Struct({
      [field]: Schema.Struct({ nodes: Schema.Array(item), pageInfo: PageInfo }),
    });
    const items: Array<S["Type"]> = [];
    let after: string | null = null;
    for (let read = 0; read < maxPages; read += 1) {
      const data = yield* callLinear(
        authorization,
        { ...query, variables: { ...query.variables, first: MAX_PAGE_SIZE, after } },
        page,
      );
      const list = data[field] as {
        readonly nodes: ReadonlyArray<S["Type"]>;
        readonly pageInfo: Schema.Schema.Type<typeof PageInfo>;
      };
      items.push(...list.nodes);
      if (!list.pageInfo.hasNextPage || list.pageInfo.endCursor === null) {
        return { items, hasMore: false };
      }
      after = list.pageInfo.endCursor;
    }
    return { items, hasMore: true };
  });
