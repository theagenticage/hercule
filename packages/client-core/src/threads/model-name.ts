/**
 * Names the model a thread runs on, as its provider instance's catalogs name
 * it. The sidebar's second line and an agent message's meta line both use
 * these functions, so the two never disagree.
 */
import type { ProviderInstance } from "@hercule/contract";

/**
 * Returns the display name of the model `slug`, such as `Opus 5.5` for
 * `claude-opus-5-5`, from any runner's catalog of the instance. Returns the
 * slug itself when no catalog lists it any more, or when the instance is
 * gone, rather than a blank: the thread still ran on that model.
 */
export const findModelName = (instance: ProviderInstance | undefined, slug: string): string => {
  for (const snapshot of instance?.snapshots ?? []) {
    const model = snapshot.models.find((each) => each.slug === slug);
    if (model !== undefined) return model.name;
  }
  return slug;
};

/**
 * Returns the start of an agent message's meta line: the instance's display
 * name and the model's display name, such as `Claude Code · Opus 5.5`.
 * Returns the model's name alone when the instance no longer exists.
 */
export const describeAgent = (instance: ProviderInstance | undefined, model: string): string => {
  const name = findModelName(instance, model);
  return instance === undefined ? name : `${instance.displayName} · ${name}`;
};
