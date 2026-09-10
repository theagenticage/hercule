/**
 * Settings > Threads' model field: the picked instance's models, read from the
 * local runner's snapshot when it has one, else the instance's first snapshot
 * - the same runner-scoped catalog rule the composer's model menu reads
 * (`model-menu.ts`). A stored slug the snapshot no longer offers stays
 * selectable, marked as missing, so a choice made on a runner since replaced
 * does not silently disappear from the field.
 */
import type { ProviderInstance } from "@hydra/contract";

export interface ThreadModelFieldOption {
  readonly slug: string;
  readonly name: string;
  readonly isDefault: boolean;
  /** The stored slug, kept on the list even though the snapshot does not offer it. */
  readonly missing: boolean;
}

export interface ThreadModelField {
  /** Why there is nothing to offer; the field has no options when this is set. */
  readonly dimmed: string | null;
  readonly options: readonly ThreadModelFieldOption[];
}

export const threadModelField = (
  instance: Pick<ProviderInstance, "snapshots">,
  localRunnerId: string | null,
  current: string | undefined,
): ThreadModelField => {
  const snapshot =
    (localRunnerId === null
      ? undefined
      : instance.snapshots.find((each) => each.runnerId === localRunnerId)) ??
    instance.snapshots[0];

  // An unauthenticated probe still reports a catalog (the harness answers from
  // its own cache), so a snapshot alone is not "logged in" - the model menu
  // reads the same `auth.status` for the same reason.
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
