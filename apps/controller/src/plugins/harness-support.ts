import type { AccountKind } from "@hercule/plugin-host";
import type { RegisteredHarness } from "./harnesses";
import { findCredentialSecretName, type RegisteredProvider } from "./providers";

/**
 * Returns every environment variable the harness reads a credential from,
 * across all the providers and account kinds it runs, each once. The runner
 * removes all of them from the harness's environment, so a key in the
 * runner's own environment never stands in for an account's login.
 */
export const listCredentialVariables = (harness: RegisteredHarness): ReadonlyArray<string> => [
  ...new Set(
    harness.runs.flatMap((support) =>
      support.kinds.flatMap(({ credentialVariable }) =>
        credentialVariable === undefined ? [] : [credentialVariable],
      ),
    ),
  ),
];

/** How a harness runs a Provider Account: the entry of the harness's `runs` that covers the account's provider and kind. */
interface HarnessSupport {
  /** How the harness names a model of this provider for accounts of this kind, with `{model}` where the model id goes. */
  readonly modelArgument: string;
  /** The environment variable the account's key goes in, or absent when the login is in the Harness Home. */
  readonly credentialVariable: string | undefined;
  /** The name of the Secret that holds the account's credential, or absent when the login is in the Harness Home. */
  readonly credentialSecretName: string | undefined;
}

/**
 * The harness a Provider Account runs in, and how that harness runs it. It
 * carries the account's provider and account kind the decision looked up, so a
 * caller that needs them does not look them up again.
 */
interface HarnessChoice {
  readonly _tag: "chosen";
  readonly provider: RegisteredProvider;
  readonly kind: AccountKind;
  readonly harness: RegisteredHarness;
  readonly support: HarnessSupport;
}

/**
 * The account cannot run in the harness. `reason` says why in words a user
 * can act on, and `field` names the input the caller should report it
 * against: `harnessId` when the caller named the harness, else
 * `providerAccountId`, since then the account itself is the problem.
 */
interface HarnessRefusal {
  readonly _tag: "refused";
  readonly field: "harnessId" | "providerAccountId";
  readonly reason: string;
}

/**
 * Decides which harness a Provider Account runs in and whether it can. The
 * harness is `harnessId` when given, else `account.defaultHarnessId`. Returns
 * the harness, how it runs the account, and the provider and account kind
 * the account has, or a refusal. Returns a refusal
 * for the first of these that holds, in this order (spec 06 section 15.4):
 *
 * - this build has no such provider, or no such account kind of it, so
 *   nothing is known about what the account may run in;
 * - this build carries no such harness;
 * - the provider's account kind does not list the harness, because the
 *   provider's terms do not allow it;
 * - the harness's `runs` does not list the provider and that account kind,
 *   because the harness does not support it.
 *
 * It is the one place that decides this, so every caller (probes, sessions,
 * settings, text generation) agrees. Each caller turns a refusal into its own
 * error.
 */
export const decideProviderAccountHarness = (
  providers: ReadonlyArray<RegisteredProvider>,
  harnesses: ReadonlyArray<RegisteredHarness>,
  account: {
    readonly providerId: string;
    readonly kind: string;
    readonly defaultHarnessId: string;
  },
  harnessId?: string | null,
): HarnessChoice | HarnessRefusal => {
  const provider = providers.find((candidate) => candidate.id === account.providerId);
  if (provider === undefined) {
    return {
      _tag: "refused",
      field: "providerAccountId",
      reason: `this build has no ${account.providerId} provider, so its accounts cannot run in any harness`,
    };
  }
  const kind = provider.kinds.find((candidate) => candidate.id === account.kind);
  if (kind === undefined) {
    return {
      _tag: "refused",
      field: "providerAccountId",
      reason: `${provider.displayName} has no account kind ${account.kind} in this build`,
    };
  }
  const wanted = harnessId ?? account.defaultHarnessId;
  const field = harnessId === undefined || harnessId === null ? "providerAccountId" : "harnessId";
  const harness = harnesses.find((candidate) => candidate.id === wanted);
  if (harness === undefined) {
    return { _tag: "refused", field, reason: `this build carries no ${wanted} harness` };
  }
  if (!kind.harnesses.includes(harness.id)) {
    return {
      _tag: "refused",
      field,
      reason: `${provider.displayName} does not allow ${kind.title} accounts to run in ${harness.displayName}`,
    };
  }
  const support = harness.runs.find((candidate) => candidate.providerId === provider.id);
  const supportedKind = support?.kinds.find((candidate) => candidate.kind === kind.id);
  if (supportedKind === undefined) {
    return {
      _tag: "refused",
      field,
      reason: `${harness.displayName} cannot run ${provider.displayName} ${kind.title} accounts`,
    };
  }
  return {
    _tag: "chosen",
    provider,
    kind,
    harness,
    support: {
      modelArgument: supportedKind.modelArgument,
      credentialVariable: supportedKind.credentialVariable,
      credentialSecretName: findCredentialSecretName(kind),
    },
  };
};
