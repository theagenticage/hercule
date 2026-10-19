/**
 * What a Draft Thread knows about its skills before it has a session. A
 * started thread reads its skills from its session; a draft has none, so the
 * composer asks the controller what the draft would have.
 */
import type { SkillsPreviewFilter, Workspace } from "@hercule/contract";
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
 * Builds what `session.previewSkills` needs to list the skills a draft would
 * have: the runner it would run on, and the repos it would open. Returns the
 * empty filter when there is no runner or the pick opens no repo, which the
 * endpoint answers with the Skill Library's skills alone. It never returns a
 * runner without repos, or repos without a runner, which the endpoint refuses.
 *
 * `pick` and `runnerId` are the ones the draft settled on, not the user's
 * raw picks: a draft that has picked nothing still opens its project's repos
 * on the machine it would be placed on (`DraftView.fields`).
 */
export const buildDraftSkillsPreview = (
  pick: WorkspacePick,
  runnerId: string | null,
  workspaces: readonly Workspace[],
): SkillsPreviewFilter => {
  const resourceIds = [...new Set(listPickedResourceIds(pick, workspaces))];
  if (runnerId === null || resourceIds.length === 0) return {};
  return { runnerId, resourceId: resourceIds };
};
