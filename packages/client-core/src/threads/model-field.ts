/**
 * Builds the model field of Settings > Threads: the models of the picked
 * account in the harness a thread runs in, read from the snapshot of the
 * runner a new thread would be placed on when it is signed in, and from the
 * most recently probed signed-in snapshot on any runner otherwise
 * (`findModelSnapshot`). The composer's model
 * menu reads the catalog per runner in the same way (`model-menu.ts`).
 *
 * A stored model slug that the snapshot no longer offers stays in the list,
 * marked as missing. A choice made on a runner that has since been replaced
 * then does not silently disappear from the field.
 */
import type { ProviderAccount } from "@hercule/contract";
import { findModelSnapshot } from "./catalog";

export interface ThreadModelFieldOption {
  readonly slug: string;
  readonly name: string;
  readonly isDefault: boolean;
  /** The stored slug, kept on the list even though the snapshot does not offer it. */
  readonly missing: boolean;
}

export interface ThreadModelField {
  /** Why there are no models to offer. When this is set, `options` is empty. */
  readonly dimmed: string | null;
  readonly options: readonly ThreadModelFieldOption[];
}

export const buildThreadModelField = (
  account: Pick<ProviderAccount, "snapshots">,
  harnessId: string,
  runnerId: string | null,
  current: string | undefined,
): ThreadModelField => {
  // A probe that is not signed in still reports a catalog (the harness returns
  // its cached list), so only a signed-in snapshot counts.
  const snapshot = findModelSnapshot(account, harnessId, runnerId);
  if (snapshot === undefined) {
    return { dimmed: "sign in on a runner first", options: [] };
  }

  const options: ThreadModelFieldOption[] = snapshot.models.map((model) => ({
    slug: model.slug,
    name: model.name,
    isDefault: model.isDefault === true,
    missing: false,
  }));

  if (current !== undefined && !options.some((option) => option.slug === current)) {
    options.push({ slug: current, name: current, isDefault: false, missing: true });
  }

  return { dimmed: null, options };
};
