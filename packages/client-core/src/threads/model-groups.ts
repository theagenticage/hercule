/**
 * The grouping the composer's model selector renders today: a picked model
 * under the provider instance that holds it. `model-menu.ts` is the shape that
 * replaces it, and this goes when the composer reads that one.
 *
 * Everything here reads one runner's snapshot per instance, because a catalog
 * is scoped instance x runner (spec 06 §3.1): switching the runner is what
 * re-resolves this whole menu.
 */
import type { ModelOption, ProviderInstance, Runner } from "@hydra/contract";

export interface ModelGroupRow {
  readonly slug: string;
  readonly name: string;
  readonly isDefault: boolean;
  readonly isLegacy: boolean;
  readonly current: boolean;
  readonly dimmed: string | null;
  readonly options: readonly ModelOption[];
}

export interface ModelGroup {
  readonly instanceId: string;
  readonly displayName: string;
  readonly name: string;
  readonly identity: string | null;
  readonly planLabel: string | null;
  readonly dimmed: string | null;
  readonly expanded: boolean;
  readonly models: readonly ModelGroupRow[];
}

export const modelGroups = (
  instances: readonly ProviderInstance[],
  /** The runner whose catalog this menu reads, or none: no runner exists at all. */
  runner: Pick<Runner, "id" | "name"> | null,
  current: { readonly instanceId: string | null; readonly model: string | null },
): readonly ModelGroup[] => {
  // With no runner there is no machine to name, so the copy says "this
  // runner" rather than printing a dangling "on ".
  const runnerName = runner?.name ?? "this runner";

  return instances.map((instance) => {
    const snapshot = instance.snapshots.find((each) => each.runnerId === runner?.id);
    const expanded = instance.id === current.instanceId;

    const models: ModelGroupRow[] = (snapshot?.models ?? []).map((descriptor) => ({
      slug: descriptor.slug,
      name: descriptor.name,
      isDefault: descriptor.isDefault === true,
      isLegacy: descriptor.isLegacy === true,
      current: expanded && descriptor.slug === current.model,
      dimmed: null,
      options: descriptor.options,
    }));

    if (expanded && current.model !== null && !models.some((row) => row.slug === current.model)) {
      models.push({
        slug: current.model,
        name: current.model,
        isDefault: false,
        isLegacy: false,
        current: true,
        dimmed: `not offered on ${runnerName}`,
        options: [],
      });
    }

    const dimmed =
      snapshot === undefined
        ? "found, not logged in"
        : snapshot.auth.status === "ok"
          ? null
          : `not logged in on ${runnerName}`;

    return {
      instanceId: instance.id,
      displayName: instance.displayName,
      name: instance.name,
      identity: snapshot?.auth.identity ?? null,
      planLabel: snapshot?.auth.planLabel ?? null,
      dimmed,
      expanded,
      models,
    };
  });
};
