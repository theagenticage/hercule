/**
 * Names the model a thread runs on, as its Provider Account's catalogs name
 * it. The sidebar's second line and an agent message's meta line both use
 * these functions, so the two never disagree.
 */
import type { Provider, ProviderAccount } from "@hercule/contract";
import { buildProviderAccountName } from "../provider-accounts";

/**
 * Returns the display name of the model `slug`, such as `Opus 5.5` for
 * `claude-opus-5-5`, from any runner's catalog of the account in `harnessId`.
 * Returns the slug itself when no catalog lists it any more, or when the
 * account is gone, rather than a blank: the thread still ran on that model.
 */
export const findModelName = (
  account: ProviderAccount | undefined,
  harnessId: string,
  slug: string,
): string => {
  for (const snapshot of account?.snapshots ?? []) {
    if (snapshot.harnessId !== harnessId) continue;
    const model = snapshot.models.find((each) => each.slug === slug);
    if (model !== undefined) return model.name;
  }
  return slug;
};

/**
 * Returns the start of an agent message's meta line: the account's name and
 * the model's display name, such as `Anthropic · Opus 5.5`. Returns the
 * model's name alone when the account no longer exists.
 */
export const describeAgent = (
  providers: readonly Provider[],
  account: ProviderAccount | undefined,
  harnessId: string,
  model: string,
): string => {
  const name = findModelName(account, harnessId, model);
  return account === undefined ? name : `${buildProviderAccountName(providers, account)} · ${name}`;
};
