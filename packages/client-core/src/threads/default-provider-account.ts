/**
 * Returns the id of the Provider Account a new thread starts on when
 * `thread.providerAccountId` is not set. Settings > Threads also uses it when
 * the stored id no longer matches an account. Returns, in order of preference:
 *
 * - the first account that is signed in on some runner, in its default harness;
 * - otherwise the first account;
 * - otherwise `null`, when no account exists.
 *
 * The composer and Settings > Threads both prefill from this rule (through
 * `computeThreadDefaults`). A signed-in account comes first because the
 * controller never places a session on a runner where the account is not
 * signed in (spec 06 §15.5).
 */
import type { ProviderAccount } from "@hercule/contract";
import { listSignedInDefaultHarnessSnapshots } from "../provider-accounts";

export const findDefaultProviderAccountId = (accounts: readonly ProviderAccount[]): string | null =>
  accounts.find((account) => listSignedInDefaultHarnessSnapshots(account).length > 0)?.id ??
  accounts[0]?.id ??
  null;
