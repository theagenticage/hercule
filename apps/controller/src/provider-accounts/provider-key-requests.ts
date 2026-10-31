/**
 * The requests the controller makes to a provider with an account's key
 * (spec 06 sections 15.2 and 18). An account kind declares each request: one
 * GET with headers that may hold the placeholder `{apiKey}`.
 *
 * - `check` asks the provider whether it accepts a key, before the key is
 *   stored.
 * - `readUsage` reads the account's usage from the provider's endpoint. The
 *   kind's plugin supplies the function that turns the response body into
 *   readings.
 *
 * Both touch no database: the caller stores what they find. The request is
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
import type { AccountKind, ParseUsageBody } from "@hercule/plugin-host";
import { UsageReading } from "@hercule/protocol";
import { findCredentialSecretName, type RegisteredProvider } from "../plugins";
import {
  cleanRefusalMessage,
  isHeaderSafe,
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
 * What a usage read found out:
 *
 * - `readings`: the provider accepted the key and gave these readings, taken
 *   at the time its answer arrived. There may be none.
 * - `refused`: the provider rejected the key, with its own words in
 *   `message`. Either it answered 401, or its plugin read the answer as a
 *   rejection.
 * - `unavailable`: the read told nothing about the key (no answer, any other
 *   status, a body the plugin could not read, a key a header cannot carry).
 *   `reason` is for the log.
 */
export type UsageReadOutcome =
  | { readonly _tag: "readings"; readonly readings: ReadonlyArray<UsageReading> }
  | { readonly _tag: "refused"; readonly message: string }
  | { readonly _tag: "unavailable"; readonly reason: string };

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));

/**
 * What a plugin's parser must return: the readings, or the provider's words
 * when it read the answer as a refusal. The plugin is third-party code, so its
 * result is checked and not trusted.
 */
const decodeParsedUsage = Schema.decodeUnknownOption(
  Schema.Union([
    Schema.Struct({ readings: Schema.Array(UsageReading) }),
    Schema.Struct({ refused: Schema.String }),
  ]),
);

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
                return { _tag: "readings", readings: checked.value.readings };
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
  };
});

/** Sends the requests that need an account's key: checking a key, and reading an account's usage. */
export class ProviderKeyRequests extends Context.Service<
  ProviderKeyRequests,
  Effect.Success<typeof make>
>()("hercule/controller/provider-accounts/ProviderKeyRequests") {}

export const ProviderKeyRequestsLayer: Layer.Layer<
  ProviderKeyRequests,
  never,
  HttpClient.HttpClient
> = Layer.effect(ProviderKeyRequests)(make);
