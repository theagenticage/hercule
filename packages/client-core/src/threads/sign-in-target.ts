/**
 * What a "Sign in" action signs in: the account, the runner, and a label for
 * the pair. The runner is needed because a credential is stored on one runner
 * only, and the caller may be showing a different row.
 */
import type { Provider, ProviderAccount, Runner } from "@hercule/contract";
import { buildProviderAccountName } from "../provider-accounts";

export interface SignInTarget {
  readonly providerAccountId: string;
  readonly runnerId: string;
  /** What the sign-in is for, in full: `Anthropic · work on atlas`. */
  readonly subject: string;
}

/** Returns the sign-in of `account` on `runner`, with its label. */
export const buildSignInTarget = (
  providers: readonly Provider[],
  account: ProviderAccount,
  runner: Runner,
): SignInTarget => ({
  providerAccountId: account.id,
  runnerId: runner.id,
  subject: `${buildProviderAccountName(providers, account)} on ${runner.name}`,
});
