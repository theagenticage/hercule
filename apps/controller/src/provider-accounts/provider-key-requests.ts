/**
 * The requests the controller makes to a provider with an account's key
 * (spec 06 sections 15.2, 16 and 18). An account kind declares each request: one
 * GET with headers that may hold the placeholder `{apiKey}`.
 *
 * - `check` asks the provider whether it accepts a key, before the key is
 *   stored.
 * - `readUsage` reads the account's usage from the provider's endpoint. The
 *   kind's plugin supplies the function that turns the response body into
 *   readings.
 * - `readCatalog` reads the account's Model Catalog from the provider's API
 *   (spec 06 section 16). The provider's plugin supplies the function that
 *   turns the response body into models.
 *
 * All three touch no database: the caller stores what they find. The request is
 * sent as `sendKeyRequest` describes, so the key is never logged and never
 * put in an error message or an outcome. Errors and outcomes hold the
 * provider's name, a status, or the provider's own words about why it refused.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import {
  createInvalidStateError,
  createValidationError,
  type InvalidState,
  type Validation,
} from "@hercule/contract";
import type { AccountKind, ParseCatalogBody, ParseUsageBody } from "@hercule/plugin-host";
import { CatalogModel, MAX_CATALOG_MODELS, Timestamp, UsageReading } from "@hercule/protocol";
import { findCredentialSecretName, type RegisteredProvider } from "../plugins";
import {
  cleanRefusalMessage,
  isHeaderSafe,
  readBodyWithin,
  readBoundedBody,
  readRefusalMessage,
  sendKeyRequest,
  type KeyRequest,
} from "./key-request";

/** How long the provider has to answer. A hung provider must not hold a dialog or a loop open. */
const KEY_REQUEST_TIMEOUT: Duration.Duration = Duration.seconds(10);

/** Lets tests set a timeout short enough to wait for. */
export const ProviderKeyRequestTimeout = Context.Reference<Duration.Duration>(
  "hercule/controller/provider-accounts/ProviderKeyRequestTimeout",
  { defaultValue: (): Duration.Duration => KEY_REQUEST_TIMEOUT },
);

/**
 * The most bytes of a catalog's response body that are read. A catalog lists
 * every model of a provider with its details, so it is far larger than the
 * other answers: OpenRouter's is about 0.8 MB for 450 models. 4 MiB leaves room
 * for several times that, while a provider that never stops sending still
 * cannot fill memory.
 */
const MAX_CATALOG_BODY_BYTES = 4 * 1024 * 1024;

/**
 * The most bytes a parsed catalog may take once encoded as JSON, which is about
 * what the controller stores and sends. The count bound alone does not limit
 * that, because a model may carry long names and options. OpenRouter's 452
 * models encode to about 121 kB. A `SessionStart` or a `TextGenerationRequest`
 * carries at most the catalog, and a frame must stay under `MAX_FRAME_BYTES`
 * (2 MiB) with everything else in it, so the catalog gets half of that.
 */
const MAX_STORED_CATALOG_BYTES = 1024 * 1024;

const encodeUtf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/** Returns `models` without the second and later model of each slug, which the browser keys its rows by. */
const keepFirstOfEachSlug = (models: ReadonlyArray<CatalogModel>): ReadonlyArray<CatalogModel> => {
  const seen = new Set<string>();
  return models.filter((model) => {
    if (seen.has(model.slug)) return false;
    seen.add(model.slug);
    return true;
  });
};

/**
 * What a read of a provider's catalog found out:
 *
 * - `listed`: the provider accepted the key and listed these models, in its
 *   order.
 * - `refused`: the provider answered 401, with its own words in `message`.
 *   Only a 401 shows that the key is wrong.
 * - `unavailable`: the read told nothing about the key or the catalog (no
 *   answer, any other status, a body that is too large, not JSON or not read
 *   by the plugin, more models than Hercule keeps, a key a header cannot
 *   carry). `message` is a sentence for the user, and for the log. It holds
 *   the provider's name and no key.
 */
export type CatalogApiReadOutcome =
  | { readonly _tag: "listed"; readonly models: ReadonlyArray<CatalogModel> }
  | { readonly _tag: "refused"; readonly message: string }
  | { readonly _tag: "unavailable"; readonly message: string };

/**
 * What a usage read found out:
 *
 * - `readings`: the provider accepted the key and gave these readings, taken
 *   at `takenAt`, the time its answer arrived. There may be none: an answer
 *   with no readings still tells that the account has none now. `expiresAt` is set
 *   when the answer also says when the key expires (`null`: it does not
 *   expire) and absent when the answer says nothing about it.
 * - `refused`: the provider rejected the key, with its own words in
 *   `message`. Either it answered 401, or its plugin read the answer as a
 *   rejection.
 * - `unavailable`: the read told nothing about the key (no answer, any other
 *   status, a body the plugin could not read, a key a header cannot carry).
 *   `reason` is for the log.
 */
export type UsageReadOutcome =
  | {
      readonly _tag: "readings";
      readonly readings: ReadonlyArray<UsageReading>;
      readonly takenAt: Timestamp;
      readonly expiresAt?: Timestamp | null;
    }
  | { readonly _tag: "refused"; readonly message: string }
  | { readonly _tag: "unavailable"; readonly reason: string };

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));

/**
 * What a plugin's parser must return: the readings and, optionally, when the
 * key expires, or the provider's words when it read the answer as a refusal.
 * The plugin is third-party code, so its result is checked and not trusted.
 */
const decodeParsedUsage = Schema.decodeUnknownOption(
  Schema.Union([
    Schema.Struct({
      readings: Schema.Array(UsageReading),
      expiresAt: Schema.optionalKey(Schema.NullOr(Timestamp)),
    }),
    Schema.Struct({ refused: Schema.String }),
  ]),
);

/** What a plugin's catalog parser must return. The plugin is third-party code, so its result is checked and not trusted. */
const decodeParsedCatalog = Schema.decodeUnknownOption(Schema.Array(CatalogModel));

/** Returns the text of a thrown value, cleaned for the log. */
const describeThrown = (error: unknown): string =>
  cleanRefusalMessage(error instanceof Error ? error.message : String(error));

const make = Effect.gen(function* () {
  // Each request runs in a scope of its own, and closing the scope aborts a
  // response body that nobody read.
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.withScope);

  /** Sends `request` with the key, within the timeout, and runs `handle` on the response (see `sendKeyRequest`). */
  const send = <A, E>(
    request: KeyRequest,
    apiKey: Redacted.Redacted<string>,
    handle: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<A, E>,
  ) =>
    Effect.gen(function* () {
      const timeout = yield* ProviderKeyRequestTimeout;
      return yield* sendKeyRequest(client, request, apiKey, timeout, handle);
    });

  return {
    /**
     * Sends the kind's key check with the key and succeeds when the provider
     * accepts it. Fails with:
     *
     * - `Validation` when the key holds a space, a line break or another
     *   character no key has, or when the provider answers 401 or 403. The
     *   message of the second is the provider's own words, or the status text
     *   when it gave none;
     * - `InvalidState` when the provider cannot be reached or does not answer
     *   within 10 seconds, or answers any other status. The key might be fine,
     *   so the caller is told to try again.
     *
     * A kind that declares no `keyCheck` is a defect: the plugin host refuses
     * to register a key kind without one.
     */
    check: (
      provider: RegisteredProvider,
      kind: AccountKind,
      apiKey: Redacted.Redacted<string>,
    ): Effect.Effect<void, Validation | InvalidState> =>
      Effect.gen(function* () {
        const { keyCheck } = kind;
        if (keyCheck === undefined) {
          return yield* Effect.die(
            new Error(
              `the account kind ${kind.id} of ${provider.id} declares no keyCheck, which the plugin host refuses at registration`,
            ),
          );
        }
        const keyField = findCredentialSecretName(kind);
        if (keyField === undefined) {
          return yield* Effect.die(
            new Error(`the account kind ${kind.id} of ${provider.id} holds no key to check`),
          );
        }
        if (!isHeaderSafe(Redacted.value(apiKey))) {
          return yield* createValidationError(
            [
              {
                path: ["credentials", keyField],
                message:
                  "The key has a space, a line break or another character that no key holds. Paste it again without them.",
              },
            ],
            "the key is not valid",
          );
        }
        const couldNotReach = createInvalidStateError(
          `Could not reach ${provider.displayName} to check the key. Try again.`,
        );
        return yield* send(keyCheck, apiKey, (response) =>
          Effect.gen(function* () {
            if (response.status >= 200 && response.status < 300) return;
            if (response.status === 401 || response.status === 403) {
              const body = yield* readBoundedBody(response);
              const message = readRefusalMessage(
                body,
                response.status === 401 ? "Unauthorized" : "Forbidden",
              );
              return yield* createValidationError(
                [{ path: ["credentials", keyField], message }],
                message,
              );
            }
            return yield* createInvalidStateError(
              `${provider.displayName} could not check the key (HTTP ${response.status}). Try again.`,
            );
          }),
        ).pipe(Effect.catchTag("KeyRequestUnreachable", () => Effect.fail(couldNotReach)));
      }),

    /**
     * Sends `request` with the key and returns what the answer means. Never
     * fails: every problem is an `unavailable` outcome.
     *
     * - A key a header cannot carry is `unavailable`, and nothing is sent.
     * - A 2xx answer with a JSON body goes to `parse`, with the time the
     *   answer arrived. The outcome is its readings, or `refused` when it
     *   returns `{ refused }` (cleaned like any provider's words, because the
     *   user reads them). When `parse` throws, or returns anything but one of
     *   those two shapes or a reading that is not valid, the plugin is at
     *   fault and the outcome is `unavailable`.
     * - A 401 is `refused`, with the `error.message` of the provider's body or
     *   `Unauthorized`.
     * - Anything else (403, 429, 5xx, a redirect, no answer within 10
     *   seconds, a 2xx body that is not JSON) is `unavailable`. A 403 or 429
     *   does not show that the key is wrong, so it is not a refusal.
     */
    readUsage: (
      request: KeyRequest,
      parse: ParseUsageBody,
      apiKey: Redacted.Redacted<string>,
    ): Effect.Effect<UsageReadOutcome> =>
      Effect.gen(function* () {
        if (!isHeaderSafe(Redacted.value(apiKey))) {
          return {
            _tag: "unavailable",
            reason: "the key holds characters a header cannot carry",
          } as const;
        }
        return yield* send(request, apiKey, (response): Effect.Effect<UsageReadOutcome> =>
          Effect.gen(function* () {
            const { status } = response;
            if (status === 401) {
              return {
                _tag: "refused",
                message: readRefusalMessage(yield* readBoundedBody(response), "Unauthorized"),
              };
            }
            if (status < 200 || status >= 300) {
              return { _tag: "unavailable", reason: `the provider answered HTTP ${status}` };
            }
            const body = decodeJson(yield* readBoundedBody(response));
            if (Option.isNone(body)) {
              return { _tag: "unavailable", reason: "the provider's answer is not JSON" };
            }
            const takenAt = new Date(yield* Clock.currentTimeMillis).toISOString();
            return yield* Effect.try({
              try: () => parse(body.value, takenAt),
              catch: describeThrown,
            }).pipe(
              Effect.map((parsed): UsageReadOutcome => {
                const checked = decodeParsedUsage(parsed);
                if (Option.isNone(checked)) {
                  return {
                    _tag: "unavailable",
                    reason:
                      "the plugin returned something that is neither readings nor a refusal, or a reading that is not valid",
                  };
                }
                if ("refused" in checked.value) {
                  const message = cleanRefusalMessage(checked.value.refused);
                  return { _tag: "refused", message: message === "" ? "Unauthorized" : message };
                }
                const { readings, expiresAt } = checked.value;
                return expiresAt === undefined
                  ? { _tag: "readings", readings, takenAt }
                  : { _tag: "readings", readings, takenAt, expiresAt };
              }),
              Effect.catch((message) =>
                Effect.succeed<UsageReadOutcome>({
                  _tag: "unavailable",
                  reason: `the plugin could not read the answer: ${message}`,
                }),
              ),
            );
          }),
        ).pipe(
          Effect.catchTag("KeyRequestUnreachable", () =>
            Effect.succeed<UsageReadOutcome>({
              _tag: "unavailable",
              reason: "the provider could not be reached in time",
            }),
          ),
        );
      }),

    /**
     * Sends `request` with the key and returns what the answer means. Never
     * fails: every problem is an `unavailable` outcome. Reads up to 4 MiB of
     * the answer, where the other requests read 64 kB.
     *
     * - A key a header cannot carry is `unavailable`, and nothing is sent.
     * - A 401 is `refused`, with the `error.message` of the provider's body or
     *   `Unauthorized`.
     * - A 2xx answer with a JSON body goes to `parse`. The outcome is `listed`
     *   with the models it returns.
     * - Anything else is `unavailable`: 403 or another status, a redirect, no
     *   answer within 10 seconds, a body over the bound or not JSON, a `parse`
     *   that throws, a `parse` result that is not a list of valid models, a
     *   list longer than `MAX_CATALOG_MODELS`, or a list that encodes to more
     *   than 1 MiB of JSON. A list that is too long or too large is not cut,
     *   because a cut list would hide models without saying so.
     * - A list with two models of one slug keeps the first of each slug and
     *   logs how many it dropped, because the browser keys its rows by slug.
     *
     * `displayName` is the provider's name, for the sentence about a list that
     * is too long. A plugin's thrown message is logged and not shown, because
     * it may quote the answer. Every `unavailable` message holds `displayName`.
     */
    readCatalog: (
      displayName: string,
      request: KeyRequest,
      parse: ParseCatalogBody,
      apiKey: Redacted.Redacted<string>,
    ): Effect.Effect<CatalogApiReadOutcome> =>
      Effect.gen(function* () {
        if (!isHeaderSafe(Redacted.value(apiKey))) {
          return {
            _tag: "unavailable",
            message: `The key stored for ${displayName} holds characters a header cannot carry. Set the key again.`,
          } as const;
        }
        return yield* send(request, apiKey, (response): Effect.Effect<CatalogApiReadOutcome> =>
          Effect.gen(function* () {
            const { status } = response;
            if (status === 401) {
              return {
                _tag: "refused",
                message: readRefusalMessage(yield* readBoundedBody(response), "Unauthorized"),
              };
            }
            if (status < 200 || status >= 300) {
              return {
                _tag: "unavailable",
                message: `${displayName} answered HTTP ${status} when asked for its models.`,
              };
            }
            const read = yield* readBodyWithin(response, MAX_CATALOG_BODY_BYTES).pipe(
              Effect.option,
            );
            if (Option.isNone(read)) {
              return {
                _tag: "unavailable",
                message: `The connection to ${displayName} failed before the list of models ended.`,
              };
            }
            const { text, complete } = read.value;
            if (!complete) {
              return {
                _tag: "unavailable",
                message: `The list of models ${displayName} sent is larger than 4 MiB.`,
              };
            }
            const body = decodeJson(text);
            if (Option.isNone(body)) {
              return {
                _tag: "unavailable",
                message: `The list of models ${displayName} sent is not JSON.`,
              };
            }
            return yield* Effect.try({
              try: () => parse(body.value),
              catch: describeThrown,
            }).pipe(
              Effect.flatMap((parsed) =>
                Effect.gen(function* () {
                  const decoded = decodeParsedCatalog(parsed);
                  if (Option.isNone(decoded)) {
                    return {
                      _tag: "unavailable",
                      message: `Hercule could not read the list of models ${displayName} sent: the plugin that reads it returned models that are not valid.`,
                    } as const;
                  }
                  const models = keepFirstOfEachSlug(decoded.value);
                  if (models.length < decoded.value.length) {
                    yield* Effect.logWarning(
                      `${displayName} listed ${decoded.value.length - models.length} models whose slug it had already listed, so only the first model of each slug is kept`,
                    );
                  }
                  if (models.length > MAX_CATALOG_MODELS) {
                    return {
                      _tag: "unavailable",
                      message: `${displayName} lists ${models.length.toLocaleString("en-US")} models, more than the ${MAX_CATALOG_MODELS.toLocaleString("en-US")} Hercule can keep.`,
                    } as const;
                  }
                  if (encodeUtf8(JSON.stringify(models)).byteLength > MAX_STORED_CATALOG_BYTES) {
                    return {
                      _tag: "unavailable",
                      message: `The list of models ${displayName} sent is larger than the 1 MiB Hercule keeps, so Hercule keeps the list it already has.`,
                    } as const;
                  }
                  return { _tag: "listed", models } as const;
                }),
              ),
              Effect.catch((message) =>
                Effect.logWarning(
                  `The plugin of ${displayName} could not read the answer of its catalog: ${message}`,
                ).pipe(
                  Effect.as<CatalogApiReadOutcome>({
                    _tag: "unavailable",
                    message: `Hercule could not read the list of models ${displayName} sent: the plugin that reads it failed on it.`,
                  }),
                ),
              ),
            );
          }),
        ).pipe(
          Effect.catchTag("KeyRequestUnreachable", () =>
            Effect.succeed<CatalogApiReadOutcome>({
              _tag: "unavailable",
              message: `${displayName} did not answer in time when asked for its models.`,
            }),
          ),
        );
      }),
  };
});

/** Sends the requests that need an account's key: checking a key, and reading an account's usage or catalog. */
export class ProviderKeyRequests extends Context.Service<
  ProviderKeyRequests,
  Effect.Success<typeof make>
>()("hercule/controller/provider-accounts/ProviderKeyRequests") {}

export const ProviderKeyRequestsLayer: Layer.Layer<
  ProviderKeyRequests,
  never,
  HttpClient.HttpClient
> = Layer.effect(ProviderKeyRequests)(make);
