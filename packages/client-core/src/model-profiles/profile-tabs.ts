/**
 * What the Models section's Duplicate needs to know about the Model Profiles
 * (spec 17, Settings > Providers, Models).
 */
import { MAX_MODEL_PROFILE_NAME_LENGTH, type ModelProfile } from "@hercule/contract";

/**
 * Returns the name a copy of the profile called `name` starts with: "Main
 * copy", or "Main copy 2", "Main copy 3" and so on when the profiles in
 * `profiles` already use the earlier ones. The name is cut short when the
 * copy's name would be longer than a profile name may be, so the controller
 * accepts the result.
 */
export const buildModelProfileCopyName = (
  profiles: readonly ModelProfile[],
  name: string,
): string => {
  const taken = new Set(profiles.map((profile) => profile.name));
  const buildCandidate = (suffix: string): string =>
    `${name.slice(0, MAX_MODEL_PROFILE_NAME_LENGTH - suffix.length).trimEnd()}${suffix}`;
  const first = buildCandidate(" copy");
  if (!taken.has(first)) return first;
  for (let number = 2; ; number++) {
    const candidate = buildCandidate(` copy ${String(number)}`);
    if (!taken.has(candidate)) return candidate;
  }
};
