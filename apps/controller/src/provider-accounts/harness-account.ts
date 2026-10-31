/**
 * Builds the `HarnessAccount` every frame that runs a harness carries: a
 * probe, a sign-in, a session's start, resume or fork, and a text generation
 * call. There is one builder so no frame can disagree with another about an
 * account's home, model argument or credential.
 */
import * as Clock from "effect/Clock";
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
import { decideProviderAccountHarness, listCredentialVariables, PluginHost } from "../plugins";
import { buildProviderAccountOwner, type SecretDecryptError, Secrets } from "../secrets";
import { resolveHarnessHome } from "./harness-home";
import { providerAccountRepository } from "./repository";
import { describeProviderAccount, findCredentialProblem, holdsMadeToken } from "./runnability";

const make = Effect.gen(function* () {
  const accounts = yield* providerAccountRepository;
  const host = yield* PluginHost;
  const secrets = yield* Secrets;

  /**
   * Returns the account's stored credential (a key or a token), decrypted, or
   * `none` when the account has none.
   *
   * Fails when the stored value cannot be read or decrypted, and the caller
   * fails with it. A probe or a session that went ahead without the key would
   * report that it is not signed in, which would look as if the user never
   * entered one.
   */
  const readCredential = (
    providerAccountId: string,
    secretName: string,
  ): Effect.Effect<Option.Option<string>, SqlError | SecretDecryptError> =>
    secrets.get(buildProviderAccountOwner(providerAccountId), secretName).pipe(
      Effect.map(Option.map(Redacted.value)),
      // The name comes from the plugin catalog, which refuses names the
      // secrets store rejects, and an account id is a UUID.
      Effect.catchTag("SecretNameError", Effect.die),
    );

  /**
   * Builds the frame's account for the pair, or fails as `prepare` documents.
   * With `withCredential` false it stops before the credential: it neither
   * reads nor requires the stored key or token.
   */
  const build = (
    providerAccountId: string,
    harnessId: string,
    withCredential: boolean,
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
      const { harness, support } = choice;
      const frame = {
        providerAccountId,
        harnessHome: resolveHarnessHome(account, harnessId),
        modelArgument: support.modelArgument,
        credentialVariables: listCredentialVariables(harness),
      };
      const { credentialSecretName, credentialVariable } = support;
      if (
        !withCredential ||
        credentialSecretName === undefined ||
        credentialVariable === undefined
      ) {
        return frame;
      }
      const providers = yield* host.providers();
      const stored = yield* readCredential(providerAccountId, credentialSecretName).pipe(
        Effect.catchTag("SecretDecryptError", () =>
          Effect.fail(
            createInvalidStateError(
              // A token account takes no key by update: its token is made by a sign-in.
              holdsMadeToken(account, providers)
                ? `the token stored for ${describeProviderAccount(account, providers)} could not be decrypted; make a new one in Settings › Providers`
                : "the key stored for that provider account could not be decrypted; enter it again " +
                    `with \`hercule provider-account update ${providerAccountId} --credentials-stdin\``,
            ),
          ),
        ),
      );
      const problem = findCredentialProblem(
        account,
        providers,
        Option.isSome(stored),
        yield* Clock.currentTimeMillis,
      );
      if (problem !== null) return yield* Effect.fail(createInvalidStateError(problem));
      // The problem is null only when a credential is stored.
      return {
        ...frame,
        credential: { variable: credentialVariable, value: Option.getOrThrow(stored) },
      };
    });

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
     * - `InvalidState` when the account's kind holds a key or token and none is
     *   stored. A harness never falls back to another login then;
     * - `InvalidState` when the account's token is past its expiry. The user
     *   makes a new one;
     * - `InvalidState` when the stored key does not decrypt. The user fixes it
     *   by entering the key again, so it is reported as a state and not as a
     *   fault.
     *
     * The folder comes from `resolveHarnessHome`. The model argument comes
     * from the harness's `runs` entry for the account's provider.
     * `credentialVariables` is every credential variable the harness declares,
     * so the runner removes them all from the harness's environment. The frame
     * carries a `credential` only when the account's kind holds one: the
     * decrypted key or token, in the variable this harness reads it from. The
     * plaintext lives only while the frame is built and then on the wire.
     */
    prepare: (
      providerAccountId: string,
      harnessId: string,
    ): Effect.Effect<HarnessAccount, NotFound | InvalidState | SqlError> =>
      build(providerAccountId, harnessId, true),

    /**
     * Returns what the runner needs to sign the account in, which is
     * `prepare` without the credential. A sign-in is how a token account gets
     * its first token or a new one, so it must work when the account has no
     * token yet or the token has expired, and the old token must not reach
     * the login. It fails for the same reasons as `prepare` except those that
     * concern the stored credential.
     */
    prepareSignIn: (
      providerAccountId: string,
      harnessId: string,
    ): Effect.Effect<HarnessAccount, NotFound | InvalidState | SqlError> =>
      build(providerAccountId, harnessId, false),
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
