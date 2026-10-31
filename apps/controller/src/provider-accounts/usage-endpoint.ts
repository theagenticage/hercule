/**
 * Reads a Provider Account's usage from the provider's own endpoint, with the
 * account's key (spec 06 section 18). The account kind declares the request,
 * and its plugin supplies the function that turns the response body into
 * readings. This service sends the request and decides what the answer means;
 * it touches no database, so the caller stores the outcome.
 *
 * The request is sent as `sendKeyRequest` describes, so the key is never
 * logged and never put in an outcome.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type { ParseUsageBody } from "@hercule/plugin-host";
import { UsageReading } from "@hercule/protocol";
import {
  cleanRefusalMessage,
  readBoundedBody,
  readRefusalMessage,
  sendKeyRequest,
  type KeyRequest,
} from "./key-request";

/** How long the provider has to answer a usage read. */
const USAGE_READ_TIMEOUT: Duration.Duration = Duration.seconds(10);

/** Lets tests set a timeout short enough to wait for. */
export const ProviderUsageEndpointTimeout = Context.Reference<Duration.Duration>(
  "hercule/controller/provider-accounts/ProviderUsageEndpointTimeout",
  { defaultValue: (): Duration.Duration => USAGE_READ_TIMEOUT },
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
 *   status, a body the plugin could not read). `reason` is for the log.
 */
export type UsageEndpointOutcome =
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
  // Each read runs in a scope of its own, and closing the scope aborts a
  // response body that nobody read.
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.withScope);

  return {
    /**
     * Sends `request` with the key and returns what the answer means. Never
     * fails: every problem is an `unavailable` outcome.
     *
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
    read: (
      request: KeyRequest,
      parse: ParseUsageBody,
      apiKey: Redacted.Redacted<string>,
    ): Effect.Effect<UsageEndpointOutcome> =>
      Effect.gen(function* () {
        const timeout = yield* ProviderUsageEndpointTimeout;
        return yield* sendKeyRequest(
          client,
          request,
          apiKey,
          timeout,
          (response): Effect.Effect<UsageEndpointOutcome> =>
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
                Effect.map((parsed): UsageEndpointOutcome => {
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
                  Effect.succeed<UsageEndpointOutcome>({
                    _tag: "unavailable",
                    reason: `the plugin could not read the answer: ${message}`,
                  }),
                ),
              );
            }),
        ).pipe(
          Effect.catchTag("KeyRequestUnreachable", () =>
            Effect.succeed<UsageEndpointOutcome>({
              _tag: "unavailable",
              reason: "the provider could not be reached in time",
            }),
          ),
        );
      }),
  };
});

/** Reads the usage of Provider Accounts from their providers' endpoints. */
export class ProviderUsageEndpoint extends Context.Service<
  ProviderUsageEndpoint,
  Effect.Success<typeof make>
>()("hercule/controller/provider-accounts/ProviderUsageEndpoint") {}

export const ProviderUsageEndpointLayer: Layer.Layer<
  ProviderUsageEndpoint,
  never,
  HttpClient.HttpClient
> = Layer.effect(ProviderUsageEndpoint)(make);
