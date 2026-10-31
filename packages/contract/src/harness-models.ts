/**
 * What a Provider Account's own probes say about a model in a harness
 * (spec 06 §15.4). The controller uses these functions when it resolves a
 * Model Profile entry and when it writes a profile, and the clients use the
 * same functions to draw an entry the harness does not know. Because they
 * share one implementation, a refusal and its warning in the UI never
 * disagree.
 */
import type { Harness } from "./groups/harness";
import type { ModelDescriptor, ProviderAccount } from "./groups/provider-account";

/**
 * Returns the model as the account's newest `ok` snapshot in the harness
 * lists it, or `undefined` when no `ok` snapshot lists the slug. `harnessId`
 * is a qualified harness id.
 */
export const findSnapshotModel = (
  account: Pick<ProviderAccount, "snapshots">,
  harnessId: string,
  slug: string,
): ModelDescriptor | undefined => {
  let newest: { readonly probedAt: string; readonly model: ModelDescriptor } | undefined;
  for (const snapshot of account.snapshots) {
    if (snapshot.harnessId !== harnessId || snapshot.auth.status !== "ok") continue;
    const model = snapshot.models.find((one) => one.slug === slug);
    if (model !== undefined && (newest === undefined || snapshot.probedAt > newest.probedAt)) {
      newest = { probedAt: snapshot.probedAt, model };
    }
  }
  return newest?.model;
};

/**
 * Returns whether the harness is known not to list the model for the account:
 * the harness lists its own models for the account's provider, at least one
 * successful snapshot of the account in it exists, and none lists the model.
 * A missing snapshot is no evidence, so it returns `false` then, and `false`
 * for a harness that takes its models from the provider's catalog or that is
 * `undefined` (not registered).
 */
export const isModelMissingFromHarness = (
  account: Pick<ProviderAccount, "providerId" | "snapshots">,
  harness: Pick<Harness, "id" | "runs"> | undefined,
  slug: string,
): boolean => {
  if (harness === undefined) return false;
  const ownsModelList =
    harness.runs.find((support) => support.providerId === account.providerId)?.models ===
    "own-list";
  if (!ownsModelList) return false;
  const hasProbe = account.snapshots.some(
    (snapshot) => snapshot.harnessId === harness.id && snapshot.auth.status === "ok",
  );
  return hasProbe && findSnapshotModel(account, harness.id, slug) === undefined;
};
