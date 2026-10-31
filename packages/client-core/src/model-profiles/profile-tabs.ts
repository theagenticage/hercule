/**
 * What the Models section's profile tabs and their dialogs need to know about
 * the Model Profiles and the projects that use them (spec 17, Settings >
 * Providers, Models).
 */
import type { ModelProfile, Project } from "@hercule/contract";

/**
 * Returns the profile that has the id `id`, or the first profile when `id` is
 * `undefined` or names no profile, such as one that was deleted. Returns
 * `undefined` only when there is no profile at all.
 */
export const findOpenModelProfile = (
  profiles: readonly ModelProfile[],
  id: string | undefined,
): ModelProfile | undefined => profiles.find((profile) => profile.id === id) ?? profiles[0];

/** Returns how many entries the profile's menu holds, across all its accounts. */
export const countModelProfileEntries = (profile: ModelProfile): number =>
  profile.accounts.reduce((total, section) => total + section.entries.length, 0);

/**
 * Returns the name a copy of the profile called `name` starts with: "Main
 * copy", or "Main copy 2", "Main copy 3" and so on when the profiles in
 * `profiles` already use the earlier ones.
 */
export const buildModelProfileCopyName = (
  profiles: readonly ModelProfile[],
  name: string,
): string => {
  const taken = new Set(profiles.map((profile) => profile.name));
  const first = `${name} copy`;
  if (!taken.has(first)) return first;
  for (let number = 2; ; number++) {
    const candidate = `${first} ${String(number)}`;
    if (!taken.has(candidate)) return candidate;
  }
};

/** Returns the projects whose Model Profile is `modelProfileId`, in the order given. */
export const listProjectsOfModelProfile = (
  projects: readonly Project[],
  modelProfileId: string,
): readonly Project[] => projects.filter((project) => project.modelProfileId === modelProfileId);
