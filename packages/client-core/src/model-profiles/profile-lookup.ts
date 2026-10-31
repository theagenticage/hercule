/**
 * Finds the Model Profiles a project or a Provider Account relates to, and the
 * projects a profile serves. The composer, the new-thread start rule and the
 * desktop's project, account and Models screens all ask these questions, so
 * none of them holds its own copy.
 */
import type { ModelProfile, Project } from "@hercule/contract";

/**
 * Returns the Model Profile that project `projectId` names, or `undefined`
 * when the project names none, names a profile that was deleted, does not
 * exist, or `projectId` is `null` (a thread outside any project).
 */
export const findProjectModelProfile = (
  projects: readonly Project[],
  modelProfiles: readonly ModelProfile[],
  projectId: string | null | undefined,
): ModelProfile | undefined => {
  const modelProfileId = projects.find((project) => project.id === projectId)?.modelProfileId;
  return modelProfiles.find((profile) => profile.id === modelProfileId);
};

/**
 * Returns the profile that has the id `id`, or the first profile when `id` is
 * `undefined` or names no profile, such as one that was deleted. Returns
 * `undefined` only when there is no profile at all.
 */
export const findModelProfileOrFirst = (
  profiles: readonly ModelProfile[],
  id: string | undefined,
): ModelProfile | undefined => profiles.find((profile) => profile.id === id) ?? profiles[0];

/**
 * Returns the Model Profiles that hold the account `providerAccountId`, in
 * the profiles' order. A profile holds an account when it has a section for
 * it, even when the section has no entries yet.
 */
export const listAccountModelProfiles = (
  modelProfiles: readonly ModelProfile[],
  providerAccountId: string,
): readonly ModelProfile[] =>
  modelProfiles.filter((profile) =>
    profile.accounts.some((section) => section.providerAccountId === providerAccountId),
  );

/** Returns the projects whose Model Profile is `modelProfileId`, in the order given. */
export const listProjectsOfModelProfile = (
  projects: readonly Project[],
  modelProfileId: string,
): readonly Project[] => projects.filter((project) => project.modelProfileId === modelProfileId);
