/**
 * Returns the id of the Provider Account a new thread starts on when no
 * Model Profile entry decides it. Returns, in order of preference:
 *
 * - the first account that is ready in its default harness on some runner;
 * - otherwise the first account;
 * - otherwise `null`, when no account exists.
 *
 * A ready account comes first because the controller never places a session
 * on a runner where the account is not ready (spec 06 §15.5). Readiness is the
 * controller's own answer, on each account's `readiness` rows.
 */
import type { ProviderAccount } from "@hercule/contract";

export const findDefaultProviderAccountId = (accounts: readonly ProviderAccount[]): string | null =>
  accounts.find((account) =>
    account.readiness.some(
      (row) => row.harnessId === account.defaultHarnessId && row.state === "ready",
    ),
  )?.id ??
  accounts[0]?.id ??
  null;
