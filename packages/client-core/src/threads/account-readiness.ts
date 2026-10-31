/**
 * Decides whether a Provider Account can run in a harness on a runner (spec 03
 * section 5.1, spec 06 section 15.5). Every place that offers or dims a runner
 * for a thread reads it from here, so they cannot disagree.
 *
 * Where an account works depends on its kind:
 *
 * The harness must be able to run on the runner first, for every kind of
 * account: installed, with an adapter in the runner's build, and not older than
 * this build supports. Then the kind decides:
 *
 * - An account whose credential the controller keeps (a key, or a token
 *   Hercule made) works on every runner that has the harness. A probe that
 *   failed for a moment does not make it need a sign-in. A token works only
 *   from the moment it is stored (`expiresAt` is set) until its `expiresAt`.
 * - An account that signs in on each machine works on a runner where its
 *   latest probe found it signed in, as the person the account belongs to.
 */
import type { Harness, Provider, ProviderAccount, Runner } from "@hercule/contract";
import { decideStoredCredentialState } from "../provider-accounts";
import { describeHarnessOnRunner } from "../provider-rows";
import { findSnapshotOn } from "./catalog";

/** The reads that say what an account's kind is and what a harness needs to run. */
export interface AccountCatalogs {
  readonly providers: readonly Provider[];
  readonly harnesses: readonly Harness[];
}

/**
 * Whether the account can run in the harness on a runner:
 *
 * - `ready`: it can;
 * - `not-signed-in`: the account signs in on each machine, and its latest
 *   probe of the runner did not find it signed in as its own person, or there
 *   is none yet;
 * - `token-missing`: the account's token has not been made yet, so it works
 *   nowhere until one is;
 * - `token-expired`: the account's token is past its `expiresAt`, so it works
 *   nowhere until a new token is made;
 * - `harness-missing`: the runner does not have the harness, or its build has
 *   no adapter for it;
 * - `harness-too-old`: the runner has the harness, but older than this build
 *   supports.
 */
export type AccountReadiness =
  | "ready"
  | "not-signed-in"
  | "token-missing"
  | "token-expired"
  | "harness-missing"
  | "harness-too-old";

/** Checks that two identities are the same person: emails differ in case but name one mailbox. */
const isSameIdentity = (accountIdentity: string | null, snapshotIdentity: string | undefined) =>
  accountIdentity === null ||
  snapshotIdentity === undefined ||
  accountIdentity.toLowerCase() === snapshotIdentity.toLowerCase();

/**
 * Returns whether `account` can run in `harnessId` on `runner`. Whether the
 * runner is online or draining is not part of it; the callers check that.
 * An account whose kind the provider no longer declares is judged by its
 * probe, like an account that signs in on each machine. A token is judged
 * against the clock at the call, so a caller that draws again later sees it
 * expire.
 */
export const decideAccountReadiness = (
  catalogs: AccountCatalogs,
  account: ProviderAccount,
  harnessId: string,
  runner: Runner,
): AccountReadiness => {
  const harness = catalogs.harnesses.find(({ id }) => id === harnessId);
  if (harness === undefined) return "harness-missing";
  const { adapter, present } = describeHarnessOnRunner(runner, harness);
  if (!adapter || !present) return "harness-missing";
  const verdict = harness.runners.find(({ runnerId }) => runnerId === runner.id)?.versionVerdict;
  if (verdict === "below-floor") return "harness-too-old";
  const credential = decideStoredCredentialState(catalogs.providers, account);
  if (credential === "usable") return "ready";
  if (credential !== "not-kept") return credential;
  const snapshot = findSnapshotOn(account, harnessId, runner.id);
  return snapshot?.auth.status === "ok" && isSameIdentity(account.identity, snapshot.auth.identity)
    ? "ready"
    : "not-signed-in";
};
