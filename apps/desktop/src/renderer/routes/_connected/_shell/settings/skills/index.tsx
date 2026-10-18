import type { JSX } from "react";
import { useMutation, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { readErrorMessage } from "@hercule/client-core";
import { rememberSettingsSection } from "../../../../../app/last-settings-section";
import { readOnOpen, skillsQuery } from "../../../../../app/queries";
import { SettingsHeaderActions } from "../../../../../screens/settings/settings-frame";
import { SkillList } from "../../../../../screens/settings/skills/skill-list";
import { ImportDialog } from "./-import-dialog";

/**
 * Settings > Skills, the list: the built-in skill, then one row per skill of
 * the Skill Library, each leading to the skill's page (spec 17 §Settings,
 * Skills). The header's Import from a folder button, like the empty block's,
 * asks main for a folder and opens the import dialog on the skills it holds.
 *
 * The library has no live topic, so the loader reads it each time the
 * section opens. The import dialog reads it again after it has imported.
 */
export const Route = createFileRoute("/_connected/_shell/settings/skills/")({
  staticData: { title: "Skills" },
  loader: async ({ context: { controller, queryClient } }) => {
    await readOnOpen(queryClient, skillsQuery(controller.client));
  },
  onEnter: () => {
    rememberSettingsSection("/settings/skills");
  },
  component: Skills,
});

function Skills(): JSX.Element {
  const { bridge, controller } = Route.useRouteContext();
  const skills = useSuspenseQuery(skillsQuery(controller.client)).data;
  // The answer of the last pick is the dialog's input, so the dialog is open
  // while the answer is `Picked`, and closing it resets the pick.
  const pick = useMutation({ mutationFn: () => bridge.skillFolders.pick() });
  const startImport = (): void => {
    if (!pick.isPending) pick.mutate();
  };
  return (
    <>
      <SettingsHeaderActions>
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
    </>
  );
}
