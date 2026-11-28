/**
 * The one rule for whether a Provider Account's kind can run in a harness at
 * all (spec 06 §15.4). The controller uses it when it refuses a profile write,
 * an account update or a session start, and the clients use it to strike a
 * harness through. Because they share one implementation, the UI never offers a
 * harness the controller refuses, nor hides one it allows. Each side keeps its
 * own words for the reasons.
 */
import type { Harness } from "./groups/harness";
import type { AccountKind } from "./groups/provider";
import type { ProviderAccount } from "./groups/provider-account";

/**
 * Whether an account kind can run in a harness, and when it cannot, which of
 * the two conditions failed:
 *
 * - `runs`: the kind can run in the harness;
 * - `disallowed-by-provider`: the provider's terms do not allow the kind in
 *   the harness, because the kind's `harnesses` does not list it;
 * - `unsupported-by-harness`: the provider's terms allow it, but the harness's
 *   `runs` does not list the provider and the kind.
 */
export type AccountKindHarnessVerdict =
  | "runs"
  | "disallowed-by-provider"
  | "unsupported-by-harness";

/**
 * Decides whether the account's kind can run in the harness. `kind` is the
 * Account Kind the account was created as, which the caller looks up in the
 * provider's `kinds`. Returns the first condition that fails, checking the
 * provider's terms before the harness's support, so a caller that words
 * the reason reports them in the order of spec 06 §15.4.
 *
 * It does not ask whether the harness is installed on any machine: that
 * changes with the machines, and this does not.
 */
export const decideAccountKindHarness = (
  account: Pick<ProviderAccount, "providerId" | "kind">,
  kind: Pick<AccountKind, "harnesses">,
  harness: Pick<Harness, "id" | "runs">,
): AccountKindHarnessVerdict => {
  if (!kind.harnesses.includes(harness.id)) return "disallowed-by-provider";
  const supportsKind = harness.runs
    .find((support) => support.providerId === account.providerId)
    ?.kinds.some((each) => each.kind === account.kind);
  return supportsKind === true ? "runs" : "unsupported-by-harness";
};
