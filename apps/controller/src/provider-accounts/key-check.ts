/**
 * Checks an API key with its provider before the key is stored (spec 06
 * section 15.2). The account kind declares the request: one GET with headers
 * that may hold the placeholder `{apiKey}`. A 2xx answer means the provider
 * accepts the key.
 *
 * The request is sent as `sendKeyRequest` describes, so the key is never
 * logged and never put in an error message: the errors below hold the
 * provider's name, a status, or the provider's own words about why it refused.
 */
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as Redacted from "effect/Redacted";
import {
  createInvalidStateError,
  createValidationError,
  type InvalidState,
  type Validation,
} from "@hercule/contract";
import type { AccountKind } from "@hercule/plugin-host";
import { findCredentialSecretName, type RegisteredProvider } from "../plugins";
import { isHeaderSafe, readBoundedBody, readRefusalMessage, sendKeyRequest } from "./key-request";

/** How long the provider has to answer. A hung provider must not hold the dialog open. */
const KEY_CHECK_TIMEOUT: Duration.Duration = Duration.seconds(10);

/** Lets tests set a timeout short enough to wait for. */
export const ProviderKeyCheckTimeout = Context.Reference<Duration.Duration>(
  "hercule/controller/provider-accounts/ProviderKeyCheckTimeout",
  { defaultValue: (): Duration.Duration => KEY_CHECK_TIMEOUT },
);

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
        const timeout = yield* ProviderKeyCheckTimeout;
        const couldNotReach = createInvalidStateError(
          `Could not reach ${provider.displayName} to check the key. Try again.`,
        );
        return yield* sendKeyRequest(client, keyCheck, apiKey, timeout, (response) =>
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
  };
});

/** Checks API keys with their providers before they are stored. */
export class ProviderKeyCheck extends Context.Service<
  ProviderKeyCheck,
  Effect.Success<typeof make>
>()("hercule/controller/provider-accounts/ProviderKeyCheck") {}

export const ProviderKeyCheckLayer: Layer.Layer<ProviderKeyCheck, never, HttpClient.HttpClient> =
  Layer.effect(ProviderKeyCheck)(make);
