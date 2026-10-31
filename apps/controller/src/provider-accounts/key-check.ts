/**
 * Checks an API key with its provider before the key is stored (spec 06
 * section 15.2). The account kind declares the request: one GET with headers
 * that may hold the placeholder `{apiKey}`. A 2xx answer means the provider
 * accepts the key.
 *
 * The key travels in a header of that one request, so:
 *
 * - redirects are never followed, because one would carry the key to another
 *   host;
 * - the key is never logged and never put in an error message: the errors
 *   below hold the provider's name, a status, or the provider's own words
 *   about why it refused.
 */
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  createInvalidStateError,
  createValidationError,
  type InvalidState,
  type Validation,
} from "@hercule/contract";
import type { AccountKind } from "@hercule/plugin-host";
import { findCredentialSecretName, type RegisteredProvider } from "../plugins";

/** How long the provider has to answer. A hung provider must not hold the dialog open. */
const KEY_CHECK_TIMEOUT: Duration.Duration = Duration.seconds(10);

/** Lets tests set a timeout short enough to wait for. */
export const ProviderKeyCheckTimeout = Context.Reference<Duration.Duration>(
  "hercule/controller/provider-accounts/ProviderKeyCheckTimeout",
  { defaultValue: (): Duration.Duration => KEY_CHECK_TIMEOUT },
);

/** The most characters of a provider's refusal that are kept. */
const MAX_REFUSAL_LENGTH = 500;

/**
 * The most bytes of a refusal's body that are read. The provider is a third
 * party, so a body that never ends must not hold the check open or fill memory.
 */
const MAX_REFUSAL_BODY_BYTES = 64 * 1024;

const API_KEY_PLACEHOLDER = "{apiKey}";

/** The error body that Anthropic, OpenAI and most other providers send: `{"error":{"message":"..."}}`. */
const decodeRefusalBody = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ error: Schema.Struct({ message: Schema.String }) })),
);

/**
 * Returns the reason a provider gave for refusing a key: the `error.message`
 * of its JSON body, on one line, without control characters (the message is
 * shown to the user, and a terminal would run an escape sequence in it), and
 * at most 500 characters. Returns `fallback` when the body holds no such
 * message.
 */
const readRefusalReason = (body: string, fallback: string): string => {
  const message = Option.match(decodeRefusalBody(body), {
    onNone: () => "",
    onSome: (decoded) =>
      decoded.error.message
        .replace(/\s+/g, " ")
        .replace(/\p{Cc}/gu, "")

        .trim(),
  });
  return message === "" ? fallback : message.slice(0, MAX_REFUSAL_LENGTH);
};

/**
 * Reads at most 64 kB of the response body as text and ignores the rest.
 * Returns an empty string when the body cannot be read.
 */
const readBoundedBody = (response: HttpClientResponse.HttpClientResponse): Effect.Effect<string> =>
  Effect.gen(function* () {
    const chunks: Array<Uint8Array> = [];
    let size = 0;
    yield* Stream.runForEachWhile(response.stream, (chunk) =>
      Effect.sync(() => {
        chunks.push(chunk);
        size += chunk.length;
        return size < MAX_REFUSAL_BODY_BYTES;
      }),
    );
    return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, MAX_REFUSAL_BODY_BYTES));
  }).pipe(Effect.orElseSucceed(() => ""));

/** Checks that the key holds only visible ASCII characters, which is all a header value may safely hold. */
const isHeaderSafe = (apiKey: string): boolean => !/[^!-~]/.test(apiKey);

const make = Effect.gen(function* () {
  // Each check runs in a scope of its own, and closing the scope aborts a
  // response body that nobody read.
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.withScope);

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
        const key = Redacted.value(apiKey);
        if (!isHeaderSafe(key)) {
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
        const headers = Object.fromEntries(
          Object.entries(keyCheck.headers).map(([name, value]) => [
            name,
            // A function, so a `$` in the key is not read as a replacement pattern.
            value.replaceAll(API_KEY_PLACEHOLDER, () => key),
          ]),
        );
        const timeout = yield* ProviderKeyCheckTimeout;
        const couldNotReach = createInvalidStateError(
          `Could not reach ${provider.displayName} to check the key. Try again.`,
        );
        return yield* Effect.gen(function* () {
          const response = yield* client.get(keyCheck.url, { headers }).pipe(
            // `fetch` follows redirects unless told not to.
            Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
            // The provider is a third party: no trace headers go to it.
            Effect.provideService(HttpClient.TracerPropagationEnabled, false),
            // The error holds the request and its headers, which hold the key.
            Effect.mapError(() => couldNotReach),
          );
          if (response.status >= 200 && response.status < 300) return;
          if (response.status === 401 || response.status === 403) {
            const body = yield* readBoundedBody(response);
            const reason = readRefusalReason(
              body,
              response.status === 401 ? "Unauthorized" : "Forbidden",
            );
            return yield* createValidationError(
              [{ path: ["credentials", keyField], message: reason }],
              reason,
            );
          }
          return yield* createInvalidStateError(
            `${provider.displayName} could not check the key (HTTP ${response.status}). Try again.`,
          );
        }).pipe(
          Effect.scoped,
          Effect.timeoutOrElse({ duration: timeout, orElse: () => Effect.fail(couldNotReach) }),
        );
      }),
  };
});

/** Checks API keys with their providers before they are stored. */
export class ProviderKeyCheck extends Context.Service<
  ProviderKeyCheck,
  Effect.Success<typeof make>
>()("hercule/controller/provider-accounts/ProviderKeyCheck") {}

export const ProviderKeyCheckLayer: Layer.Layer<ProviderKeyCheck, never, HttpClient.HttpClient> =
  Layer.effect(ProviderKeyCheck)(make);
