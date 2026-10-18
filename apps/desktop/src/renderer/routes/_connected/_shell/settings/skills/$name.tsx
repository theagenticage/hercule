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
import { settingsQuery, skillDiffQuery, skillQuery } from "../../../../../app/queries";
import { SettingsHeaderTitle } from "../../../../../screens/settings/settings-frame";
import {
  SkillFilesSection,
  SkillHistorySection,
  SkillLead,
  SkillMdSection,
} from "../../../../../screens/settings/skills/skill-page";
import { CheckNow } from "./-check-now";
import { DeleteSection } from "./-delete-section";
import { SkillUpdate } from "./-skill-update";
import { UploadVersion } from "./-upload-version";

/**
 * Settings > Skills, the page of one skill: its description and source, the
 * warning lines for its approval effects, the update waiting on it with what
 * it changes, its `SKILL.md`, its files, its History and Delete (spec 17
 * §Settings, Skills). The header reads "Settings / Skills / <name>", with
 * the list linked. For a skill from GitHub it has "Checked 2 hours ago" and
 * Check now, then Upload new version for every skill.
 *
 * The section's layout holds the `skill` topic, which keeps the skill
 * current, so the loader reads it only when it is not cached yet; the
 * controller's first push on the topic reads it again. The loader also reads
 * what a waiting update changes, once per revision. A name that names no
 * skill goes back to the list. The section remembers its list, never one
 * skill's page.
 */
export const Route = createFileRoute("/_connected/_shell/settings/skills/$name")({
  staticData: { title: "Skills" },
  loader: async ({ context: { controller, queryClient }, params: { name } }) => {
    const { client } = controller;
    try {
      const [{ skill }] = await Promise.all([
        queryClient.ensureQueryData(skillQuery(client, name)),
        queryClient.ensureQueryData(settingsQuery(client)),
      ]);
      if (skill.availableRevisionHash !== null && skill.currentRevisionHash !== null) {
        await queryClient.ensureQueryData(
          skillDiffQuery(client, name, skill.availableRevisionHash, skill.currentRevisionHash),
        );
      }
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
      {/* The header's actions and their lines sit above the record, under
          the header. Check now comes first, so its actions come before
          Upload new version's in the header. */}
      {skill.source.kind === "github" && (
        <CheckNow name={name} lastCheckedAt={skill.lastCheckedAt} />
      )}
      <UploadVersion skill={skill} />
      <div className="set-record skill-record">
        <SettingsHeaderTitle parent={{ title: "Skills", to: "/settings/skills" }} title={name} />
        {/* A skill with no current revision exists only as a proposed
            revision. This page does not draw proposed revisions yet (spec 17
            §Settings, Skills, Proposed revisions, #736), so such a skill
            shows only its History and Delete. */}
        {current !== undefined && <SkillLead skill={skill} description={current.description} />}
        {skill.source.kind === "github" &&
          skill.availableRevisionHash !== null &&
          skill.currentRevisionHash !== null && (
            <SkillUpdate
              skill={skill}
              repo={skill.source.repo}
              revisionHash={skill.availableRevisionHash}
              currentRevisionHash={skill.currentRevisionHash}
            />
          )}
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
