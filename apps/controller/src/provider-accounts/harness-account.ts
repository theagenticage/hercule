/**
 * Builds the `HarnessAccount` every frame that runs a harness carries: a
 * probe, a sign-in, a session's start, resume or fork, and a text generation
 * call. There is one builder so no frame can disagree with another about an
 * account's home, model argument or credential.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import {
  createInvalidStateError,
  createNotFoundError,
  type InvalidState,
  type NotFound,
} from "@hercule/contract";
import type { HarnessAccount } from "@hercule/protocol";
import * as Redacted from "effect/Redacted";
import { API_KEY_SECRET_NAME, decideProviderAccountHarness, PluginHost } from "../plugins";
import { buildProviderAccountOwner, type SecretDecryptError, Secrets } from "../secrets";
import { resolveHarnessHome } from "./harness-home";
import { providerAccountRepository } from "./repository";

const make = Effect.gen(function* () {
  const accounts = yield* providerAccountRepository;
  const host = yield* PluginHost;
  const secrets = yield* Secrets;

  /**
   * Returns the account's stored key, decrypted, or `none` when the account
   * has none (a per-machine account, or a key account the user has not given
   * a key yet).
   *
   * Fails when the stored value cannot be read or decrypted, and the caller
   * fails with it. A probe or a session that went ahead without the key would
   * report that it is not signed in, which would look as if the user never
   * entered one.
   */
  const readCredential = (
    providerAccountId: string,
  ): Effect.Effect<Option.Option<string>, SqlError | SecretDecryptError> =>
    secrets.get(buildProviderAccountOwner(providerAccountId), API_KEY_SECRET_NAME).pipe(
      Effect.map(Option.map(Redacted.value)),
      // The name is a constant without `|` and an account id is a UUID, so the
      // secrets store can never reject either.
      Effect.catchTag("SecretNameError", Effect.die),
    );

  return {
    /**
     * Returns what the runner needs to run one harness for one account. It
     * fails, and sends nothing, when the pair cannot run:
     *
     * - `NotFound` when there is no such account;
     * - `InvalidState` when this build carries no such harness, when the
     *   account's provider does not allow the harness for the account's kind,
     *   or when the harness does not list the provider and kind in its
     *   `runs`. The message says which and why;
     * - `InvalidState` when the stored key does not decrypt. The user fixes it
     *   by entering the key again, so it is reported as a state and not as a
     *   fault.
     *
     * The folder comes from `resolveHarnessHome`. The model argument comes
     * from the harness's `runs` entry for the account's provider. When that
     * entry names a credential variable for the account's kind, the frame
     * carries it, with the decrypted key if one is stored. Without a key it
     * carries the variable alone, so the runner removes it from the harness's
     * environment instead of letting a key of the runner's own stand in. The
     * plaintext lives only while the frame is built and then on the wire.
     */
    prepare: (
      providerAccountId: string,
      harnessId: string,
    ): Effect.Effect<HarnessAccount, NotFound | InvalidState | SqlError> =>
      Effect.gen(function* () {
        const found = yield* accounts.one(providerAccountId);
        if (Option.isNone(found)) {
          return yield* Effect.fail(createNotFoundError("no such provider account"));
        }
        const account = found.value;
        const choice = decideProviderAccountHarness(
          yield* host.providers(),
          yield* host.harnesses(),
          account,
          harnessId,
        );
        if (choice._tag === "refused") {
          return yield* Effect.fail(createInvalidStateError(choice.reason));
        }
        const { support } = choice;
        const harnessHome = resolveHarnessHome(account, harnessId);
        if (support.credentialVariable === undefined) {
          return { providerAccountId, harnessHome, modelArgument: support.modelArgument };
        }
        const key = yield* readCredential(providerAccountId).pipe(
          Effect.catchTag("SecretDecryptError", () =>
            Effect.fail(
              createInvalidStateError(
                "the key stored for that provider account could not be decrypted; enter it again " +
                  `with \`hercule provider-account update ${providerAccountId} --credentials-stdin\``,
              ),
            ),
          ),
        );
        return {
          providerAccountId,
          harnessHome,
          modelArgument: support.modelArgument,
          credential: {
            variable: support.credentialVariable,
            ...(Option.isSome(key) ? { value: key.value } : {}),
          },
        };
      }),
  };
});

/**
 * Prepares the `HarnessAccount` every frame to a runner carries. It is a
 * service so that the places that send such frames (probes, sign-in, session
 * dispatch and text generation) do not each repeat the services the builder
 * reads.
 */
export class HarnessAccounts extends Context.Service<
  HarnessAccounts,
  Effect.Success<typeof make>
>()("hercule/controller/provider-accounts/HarnessAccounts") {}

export const HarnessAccountsLayer: Layer.Layer<
  HarnessAccounts,
  never,
  SqlClient.SqlClient | PluginHost | Secrets
> = Layer.effect(HarnessAccounts)(make);
