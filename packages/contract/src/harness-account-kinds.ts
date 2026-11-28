import type { Harness } from "./groups/harness";
import type { AccountKind } from "./groups/provider";

/** What a harness declares for one account kind of one provider: its model argument, credential variable and so on. */
type HarnessKindSupport = Harness["runs"][number]["kinds"][number];

/**
 * Checks the declarations on both sides for whether an account kind can run in
 * a harness (spec 06 §15.4). Returns `disallowed-by-provider` when the kind's
 * `harnesses` does not list the harness, else `unsupported-by-harness` when
 * the harness's `runs` does not list the provider and the kind, else `runs`
 * with the harness's entry for the kind. The provider's terms are checked
 * first, so a caller that words the refusal reports them in that order.
 *
 * It does not ask whether the harness is installed anywhere.
 */
export const decideAccountKindHarnessSupport = (
  providerId: string,
  kind: Pick<AccountKind, "id" | "harnesses">,
  harness: Pick<Harness, "id" | "runs">,
):
  | { readonly _tag: "runs"; readonly support: HarnessKindSupport }
  | { readonly _tag: "disallowed-by-provider" }
  | { readonly _tag: "unsupported-by-harness" } => {
  if (!kind.harnesses.includes(harness.id)) return { _tag: "disallowed-by-provider" };
  const support = harness.runs
    .find((each) => each.providerId === providerId)
    ?.kinds.find((each) => each.kind === kind.id);
  return support === undefined ? { _tag: "unsupported-by-harness" } : { _tag: "runs", support };
};
