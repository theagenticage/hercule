/**
 * Builds the model field of Settings > Threads: the models of the picked
 * instance, read from the snapshot of the runner a new thread would be placed
 * on when there is one, and from the instance's first snapshot otherwise. The composer's model menu reads
 * the catalog per runner in the same way (`model-menu.ts`).
 *
 * A stored model slug that the snapshot no longer offers stays in the list,
 * marked as missing. A choice made on a runner that has since been replaced
 * then does not silently disappear from the field.
 */
import type { ProviderInstance } from "@hercule/contract";

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
  instance: Pick<ProviderInstance, "snapshots">,
  runnerId: string | null,
  current: string | undefined,
): ThreadModelField => {
  const snapshot =
    (runnerId === null
      ? undefined
      : instance.snapshots.find((each) => each.runnerId === runnerId)) ?? instance.snapshots[0];

  // A probe that is not logged in still reports a catalog (the harness returns
  // its cached list), so having a snapshot does not mean "logged in". The model
  // menu checks `auth.status` for the same reason.
  if (snapshot === undefined || snapshot.auth.status !== "ok") {
    return { dimmed: "log in on a runner first", options: [] };
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
