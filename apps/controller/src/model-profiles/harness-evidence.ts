/**
 * What the account's own probes say about a model in a harness. Two places
 * use it and must agree: resolving an entry (it reports `harness-lacks-model`
 * when an entry cannot run) and writing a profile (it refuses to add an entry
 * the harness is known not to list).
 */
import type { ProviderAccount } from "@hercule/contract";
import type { RegisteredHarness } from "../plugins";

type SnapshotModel = ProviderAccount["snapshots"][number]["models"][number];

/**
 * Returns the model as the account's newest `ok` snapshot in the harness
 * lists it, or `undefined` when no `ok` snapshot lists the slug.
 *
 * The running-thread descriptor fallback in client-core (`findProbedModel` in
 * `packages/client-core/src/threads/resolve-thread.ts`) mirrors this rule, so
 * a change to one is made in both.
 */
export const findSnapshotModel = (
  account: ProviderAccount,
  harnessId: string,
  slug: string,
): SnapshotModel | undefined => {
  let newest: { readonly probedAt: string; readonly model: SnapshotModel } | undefined;
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
 * for a harness that takes its models from the provider's catalog.
 */
export const isModelMissingFromHarness = (
  account: ProviderAccount,
  harness: RegisteredHarness | undefined,
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

/**
 * Returns the sentence for a model a harness does not list for an account.
 * The entry's `problem` and the refusal of a write say the same thing.
 */
export const describeHarnessLacksModel = (
  harnessName: string,
  slug: string,
  accountName: string,
): string =>
  `${harnessName} does not list ${slug} for ${accountName}. Choose another harness or model.`;
