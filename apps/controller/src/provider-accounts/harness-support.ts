import type { HarnessProviderSupport } from "@hercule/plugin-host";
import type { RegisteredHarness, RegisteredProvider } from "../plugins";
import type { StoredProviderAccount } from "./repository";

/** How a harness runs an account: the entry of the harness's `runs` that covers the account's provider and kind. */
export interface HarnessSupport {
  readonly _tag: "supported";
  /** How the harness names a model of this provider, with `{model}` where the model id goes. */
  readonly modelArgument: string;
  /** Which of the account's models the harness can run: all of them, or those in its own list. */
  readonly models: HarnessProviderSupport["models"];
  /** The environment variable the account's key goes in, or absent when the login is in the Harness Home. */
  readonly credentialVariable: string | undefined;
}

/** The account cannot run in the harness, and `reason` says why in words a user can act on. */
export interface HarnessRefusal {
  readonly _tag: "refused";
  readonly reason: string;
}

/**
 * Decides whether an account can run in a harness. Two things must hold, and
 * the first that fails gives the reason (spec 06 section 15.4):
 *
 * - the provider's account kind lists the harness, because the provider's
 *   terms allow it;
 * - the harness's `runs` lists the provider and that account kind, because
 *   the harness supports it.
 *
 * It also refuses an account whose provider or kind this build does not have,
 * since nothing is known then about what it may run in.
 */
export const checkHarnessSupport = (
  providers: ReadonlyArray<RegisteredProvider>,
  harness: RegisteredHarness,
  account: Pick<StoredProviderAccount, "providerId" | "kind">,
): HarnessSupport | HarnessRefusal => {
  const provider = providers.find((candidate) => candidate.id === account.providerId);
  if (provider === undefined) {
    return {
      _tag: "refused",
      reason: `this build has no ${account.providerId} provider, so its accounts cannot run in any harness`,
    };
  }
  const kind = provider.kinds.find((candidate) => candidate.id === account.kind);
  if (kind === undefined) {
    return {
      _tag: "refused",
      reason: `${provider.displayName} has no account kind ${account.kind} in this build`,
    };
  }
  if (!kind.harnesses.includes(harness.id)) {
    return {
      _tag: "refused",
      reason: `${provider.displayName} does not allow ${kind.title} accounts to run in ${harness.displayName}`,
    };
  }
  const support = harness.runs.find((candidate) => candidate.providerId === provider.id);
  const supportedKind = support?.kinds.find((candidate) => candidate.kind === kind.id);
  if (support === undefined || supportedKind === undefined) {
    return {
      _tag: "refused",
      reason: `${harness.displayName} cannot run ${provider.displayName} ${kind.title} accounts`,
    };
  }
  return {
    _tag: "supported",
    modelArgument: support.modelArgument,
    models: support.models,
    credentialVariable: supportedKind.credentialVariable,
  };
};
