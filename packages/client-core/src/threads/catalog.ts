/**
 * Reads a Provider Account's catalog. A catalog belongs to one account in one
 * harness on one runner, because each runner has its own copy of the harness,
 * with its own version and login (spec 06 §3.1). So every function here takes
 * the harness the thread runs in and the runner it is placed on: the same
 * account can offer a model list on one runner and nothing at all on another.
 *
 * The harness a thread runs in is the one it names, else the account's
 * `defaultHarnessId`.
 */
import type { CapabilitySnapshot, Provider, ProviderAccount, Runner } from "@hercule/contract";
import { buildProviderAccountName } from "../provider-accounts";

/**
 * Returns the account's capability snapshot in `harnessId` on a runner, or
 * `undefined` when it has none there.
 */
export const findSnapshotOn = (
  account: Pick<ProviderAccount, "snapshots">,
  harnessId: string,
  runnerId: string | undefined,
): CapabilitySnapshot | undefined =>
  account.snapshots.find(
    (snapshot) => snapshot.harnessId === harnessId && snapshot.runnerId === runnerId,
  );

/**
 * Returns the snapshot whose model list stands in for the account's Model
 * Catalog in `harnessId` on a runner (until the catalog exists): the `ok`
 * snapshot of `runnerId` when that runner has one, else the most recently
 * probed `ok` snapshot on any runner, else `undefined`. The controller picks
 * models the same way (`findModels` in its provider-accounts domain), so the
 * composer offers the models the controller will accept. An account whose
 * credential every runner uses can run on a runner that was never probed, and
 * the fallback keeps its models on offer there.
 */
export const findModelSnapshot = (
  account: Pick<ProviderAccount, "snapshots">,
  harnessId: string,
  runnerId: string | null | undefined,
): CapabilitySnapshot | undefined => {
  const signedIn = account.snapshots.filter(
    (snapshot) => snapshot.harnessId === harnessId && snapshot.auth.status === "ok",
  );
  return (
    signedIn.find((snapshot) => snapshot.runnerId === runnerId) ??
    signedIn.reduce<CapabilitySnapshot | undefined>(
      (best, snapshot) =>
        best === undefined || snapshot.probedAt > best.probedAt ? snapshot : best,
      undefined,
    )
  );
};

/**
 * What a "Sign in" action signs in: the account, the runner, and a label for
 * the pair. The runner is needed because a credential is stored on one runner
 * only, and the caller may be showing a different row.
 */
export interface SignInTarget {
  readonly providerAccountId: string;
  readonly runnerId: string;
  /** What the sign-in is for, in full: `Anthropic · work on atlas`. */
  readonly subject: string;
}

export const buildSignInTarget = (
  providers: readonly Provider[],
  account: ProviderAccount,
  runner: Runner,
): SignInTarget => ({
  providerAccountId: account.id,
  runnerId: runner.id,
  subject: `${buildProviderAccountName(providers, account)} on ${runner.name}`,
});
