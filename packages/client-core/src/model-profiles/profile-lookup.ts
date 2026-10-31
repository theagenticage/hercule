/**
 * Finds the Model Profiles a project or a Provider Account relates to. The
 * composer, the new-thread start rule and the desktop's project and account
 * screens all ask these two questions, so none of them holds its own copy.
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
