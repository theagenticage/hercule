/**
 * What a Draft Thread knows about its skills before it has a session. A
 * started thread reads its skills from its session; a draft has none, so the
 * composer asks the controller what the draft would have, or falls back to
 * the Skill Library.
 */
import type { SessionSkill, Skill, SkillsPreviewFilter, Workspace } from "@hercule/contract";
import type { WorkspacePick } from "./workspaces";

/** Returns the ids of the repos a workspace pick would open, in the pick's order. */
const listPickedResourceIds = (
  pick: WorkspacePick,
  workspaces: readonly Workspace[],
): readonly string[] => {
  switch (pick.kind) {
    case "none":
      return [];
    case "primary":
      return [pick.resourceId];
    case "ephemeral":
      return pick.checkouts.map((checkout) => checkout.resourceId);
    case "existing":
      return (
        workspaces
          .find((each) => each.id === pick.workspaceId)
          ?.checkouts.map((checkout) => checkout.resourceId) ?? []
      );
  }
};

/**
 * Returns what `session.previewSkills` needs to list the skills a draft would
 * have: the runner it would run on, and the repos it would open. Returns
 * `null` when there is no runner or the pick opens no repo, which the
 * endpoint refuses. Such a draft has only the library's skills; see
 * `listLibrarySessionSkills`.
 *
 * `pick` and `runnerId` are the ones the draft settled on, not the user's
 * raw picks: a draft that has picked nothing still opens its project's repos
 * on the machine it would be placed on (`DraftView.fields`).
 */
export const findDraftSkillsPreview = (
  pick: WorkspacePick,
  runnerId: string | null,
  workspaces: readonly Workspace[],
): SkillsPreviewFilter | null => {
  const resourceIds = [...new Set(listPickedResourceIds(pick, workspaces))];
  if (runnerId === null || resourceIds.length === 0) return null;
  return { runnerId, resourceId: resourceIds };
};

/**
 * Returns the Skill Library's skills as a session lists them: the skills
 * that have a current revision, which is what a thread gets, in the order of
 * `skills`. The library's list holds no descriptions, so each description is
 * empty.
 */
export const listLibrarySessionSkills = (skills: readonly Skill[]): readonly SessionSkill[] =>
  skills
    .filter((skill) => skill.currentRevisionHash !== null)
    .map((skill) => ({ source: "library", name: skill.name, description: "" }));
