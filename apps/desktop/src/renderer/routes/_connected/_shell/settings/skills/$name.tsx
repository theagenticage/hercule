import type { JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import {
  findCurrentSkillRevision,
  findSkillMdSize,
  isNotFound,
  resolveDisplayTimezone,
} from "@hercule/client-core";
import { rememberSettingsSection } from "../../../../../app/last-settings-section";
import { readOnOpen, settingsQuery, skillQuery } from "../../../../../app/queries";
import { SettingsHeaderTitle } from "../../../../../screens/settings/settings-frame";
import {
  SkillFilesSection,
  SkillHistorySection,
  SkillLead,
  SkillMdSection,
} from "../../../../../screens/settings/skills/skill-page";
import { DeleteSection } from "./-delete-section";
import { UploadVersion } from "./-upload-version";

/**
 * Settings > Skills, the page of one skill: its description and source, the
 * warning lines for its approval effects, its `SKILL.md`, its files, its
 * History and Delete (spec 17 §Settings, Skills). The header reads "Settings
 * / Skills / <name>", with the list linked, and has Upload new version.
 *
 * The library has no live topic, so the loader reads the skill each time the
 * page opens. A name that names no skill goes back to the list. The section
 * remembers its list, never one skill's page.
 */
export const Route = createFileRoute("/_connected/_shell/settings/skills/$name")({
  staticData: { title: "Skills" },
  loader: async ({ context: { controller, queryClient }, params: { name } }) => {
    const { client } = controller;
    try {
      await Promise.all([
        readOnOpen(queryClient, skillQuery(client, name)),
        queryClient.ensureQueryData(settingsQuery(client)),
      ]);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      // oxlint-disable-next-line typescript/only-throw-error -- the router's way to redirect
      throw redirect({ to: "/settings/skills", replace: true });
    }
  },
  onEnter: () => {
    rememberSettingsSection("/settings/skills");
  },
  component: SkillPage,
});

function SkillPage(): JSX.Element {
  const { client } = Route.useRouteContext().controller;
  const { name } = Route.useParams();
  const query = useSuspenseQuery(skillQuery(client, name));
  const detail = query.data;
  const timezone = resolveDisplayTimezone(
    useSuspenseQuery(settingsQuery(client)).data.user.timezone,
  );
  const { skill, files, skillMd, history } = detail;
  const current = findCurrentSkillRevision(detail);
  return (
    <>
      {/* The upload's lines sit above the record, under the header. */}
      <UploadVersion skill={skill} />
      <div className="set-record skill-record">
        <SettingsHeaderTitle parent={{ title: "Skills", to: "/settings/skills" }} title={name} />
        {/* A skill with no current revision exists only as a proposed
            revision. This page does not draw proposed revisions yet (spec 17
            §Settings, Skills, Proposed revisions, #736), so such a skill
            shows only its History and Delete. */}
        {current !== undefined && <SkillLead skill={skill} description={current.description} />}
        {skillMd !== null && <SkillMdSection text={skillMd} sizeBytes={findSkillMdSize(files)} />}
        {skill.currentFileCount !== null && skill.currentSizeBytes !== null && (
          <SkillFilesSection
            files={files}
            fileCount={skill.currentFileCount}
            sizeBytes={skill.currentSizeBytes}
          />
        )}
        <SkillHistorySection
          history={history}
          currentRevisionHash={skill.currentRevisionHash}
          now={new Date(query.dataUpdatedAt)}
          timezone={timezone}
        />
        <DeleteSection name={name} />
      </div>
    </>
  );
}
