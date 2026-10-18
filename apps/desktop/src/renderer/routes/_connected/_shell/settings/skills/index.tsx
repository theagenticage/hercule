import { useState, type JSX } from "react";
import { useMutation, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { listSkillUpdates, readErrorMessage } from "@hercule/client-core";
import { rememberSettingsSection } from "../../../../../app/last-settings-section";
import { skillsQuery } from "../../../../../app/queries";
import { SettingsHeaderActions } from "../../../../../screens/settings/settings-frame";
import { SkillList } from "../../../../../screens/settings/skills/skill-list";
import { CheckNow } from "./-check-now";
import { ImportDialog } from "./-import-dialog";
import { UpdateAllDialog } from "./-update-all-dialog";

/**
 * Settings > Skills, the list: the built-in skill, then one row per skill of
 * the Skill Library, each leading to the skill's page (spec 17 §Settings,
 * Skills). The header has:
 *
 * - Check now, while any skill has a GitHub source, which starts an update
 *   check of every such skill. The check answers at once; its results come
 *   with the `skill` topic, which the section's layout holds.
 * - Update all, with the number of updates, while any skill has an update,
 *   which asks first in a confirmation.
 * - Import from a folder, like the empty block's button, which asks main for
 *   a folder and opens the import dialog on the skills it holds.
 *
 * The section's layout holds the `skill` topic, which keeps the list
 * current, so the loader reads it only when it is not cached yet; the
 * controller's first push on the topic reads it again. After each of the
 * section's own writes, the list is read again.
 */
export const Route = createFileRoute("/_connected/_shell/settings/skills/")({
  staticData: { title: "Skills" },
  loader: async ({ context: { controller, queryClient } }) => {
    await queryClient.ensureQueryData(skillsQuery(controller.client));
  },
  onEnter: () => {
    rememberSettingsSection("/settings/skills");
  },
  component: Skills,
});

function Skills(): JSX.Element {
  const { bridge, controller } = Route.useRouteContext();
  const { client } = controller;
  const skills = useSuspenseQuery(skillsQuery(client)).data;
  const updateCount = listSkillUpdates(skills).length;
  const [confirmingUpdates, setConfirmingUpdates] = useState(false);
  // The answer of the last pick is the dialog's input, so the dialog is open
  // while the answer is `Picked`, and closing it resets the pick.
  const pick = useMutation({ mutationFn: () => bridge.skillFolders.pick() });
  const startImport = (): void => {
    if (!pick.isPending) pick.mutate();
  };
  const hasGithubSkill = skills.some(({ source }) => source.kind === "github");
  return (
    <>
      {hasGithubSkill && <CheckNow />}
      {/* The header draws its actions in the order they were added. The rest
          is one set, so Update all keeps its place when it comes and goes.
          The set is drawn afresh when Check now comes or goes, so it stays
          after Check now, also when the first GitHub skill is imported. */}
      <SettingsHeaderActions key={hasGithubSkill ? "after-check-now" : "alone"}>
        {updateCount > 0 && (
          <button type="button" className="btn btn--sm" onClick={() => setConfirmingUpdates(true)}>
            {`Update all ${String(updateCount)}`}
          </button>
        )}
        <button
          type="button"
          className="btn btn--sm"
          aria-disabled={pick.isPending}
          onClick={startImport}
        >
          Import from a folder
        </button>
      </SettingsHeaderActions>
      {pick.data?._tag === "Unreadable" && (
        <p className="set-err" role="alert">
          {pick.data.reason}
        </p>
      )}
      {pick.error !== null && (
        <p className="set-err" role="alert">
          {`Could not open the folder: ${readErrorMessage(pick.error)}`}
        </p>
      )}
      <SkillList skills={skills} onImport={startImport} />
      {pick.data?._tag === "Picked" && (
        <ImportDialog
          folder={pick.data}
          onClose={() => {
            pick.reset();
          }}
        />
      )}
      {confirmingUpdates && <UpdateAllDialog onClose={() => setConfirmingUpdates(false)} />}
    </>
  );
}
