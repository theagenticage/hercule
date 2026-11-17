import { useEffect, type JSX } from "react";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import {
  findCurrentSkillRevision,
  findSkillMdSize,
  isNotFound,
  resolveDisplayTimezone,
} from "@hercule/client-core";
import type { SkillRevision } from "@hercule/contract";
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
import { NewSkillLead, Proposal } from "./-skill-proposal";
import { SkillUpdateSection } from "./-skill-update";
import { UploadVersion } from "./-upload-version";

/**
 * Settings > Skills, the page of one skill: its description and source, the
 * warning lines for its approval effects, the update waiting on it and the
 * revisions sessions proposed, each with what it changes, its `SKILL.md`, its
 * files, its History and Delete (spec 17 §Settings, Skills). The header
 * reads "Settings / Skills / <name>", with the list linked. For a skill from
 * GitHub it has "Checked 2 hours ago" and Check now, then Upload new version.
 *
 * A skill with no current revision exists only as proposals. Its page shows
 * the newest proposal's band, the lead from that proposal's description,
 * "What it adds", then any older proposals, and no `SKILL.md`, Files,
 * History, Upload new version or Delete.
 *
 * The section's layout holds the `skill` topic, which keeps the skill
 * current, so the loader reads it only when it is not cached yet; the
 * controller's first push on the topic reads it again. The loader also reads
 * what a waiting update and the newest proposal change, and the topic reads
 * those again with the skill. An older proposal reads its changes when the
 * user opens them. A name that names no skill goes back to the list, and so does a
 * page whose skill is deleted while it is open. The section remembers its
 * list, never one skill's page.
 */
export const Route = createFileRoute("/_connected/_shell/settings/skills/$name")({
  staticData: { title: "Skills" },
  loader: async ({ context: { controller, queryClient }, params: { name } }) => {
    const { client } = controller;
    try {
      const [{ skill, proposedRevisions }] = await Promise.all([
        queryClient.ensureQueryData(skillQuery(client, name)),
        queryClient.ensureQueryData(settingsQuery(client)),
      ]);
      // Only the newest proposal's diff is read up front: an older proposal
      // reads its own when the user opens it.
      const revisionHashes = proposedRevisions.slice(0, 1).map(({ revisionHash }) => revisionHash);
      if (skill.availableRevisionHash !== null && skill.currentRevisionHash !== null) {
        revisionHashes.push(skill.availableRevisionHash);
      }
      await Promise.all(
        revisionHashes.map((revisionHash) =>
          queryClient.ensureQueryData(skillDiffQuery(client, name, revisionHash)),
        ),
      );
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
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();
  const query = useSuspenseQuery(skillQuery(client, name));
  // Once the page has drawn, a failed read keeps the skill it read last. A
  // read that finds no skill means it was deleted, here or elsewhere. The
  // page leaves, then drops the deleted skill's reads, its diff included:
  // a skill created again with this name must not open on the old reads
  // and their refusal.
  const deleted = isNotFound(query.error);
  useEffect(() => {
    if (!deleted) return;
    void navigate({ to: "/settings/skills", replace: true }).then(() => {
      queryClient.removeQueries({ queryKey: skillQuery(client, name).queryKey });
    });
  }, [deleted, navigate, queryClient, client, name]);
  const detail = query.data;
  const timezone = resolveDisplayTimezone(
    useSuspenseQuery(settingsQuery(client)).data.user.timezone,
  );
  const { skill, files, skillMd, history, proposedRevisions } = detail;
  const current = findCurrentSkillRevision(detail);
  const isNewSkill = skill.currentRevisionHash === null;
  const now = new Date(query.dataUpdatedAt);
  const [newest, ...older] = proposedRevisions;
  const proposal = (revision: SkillRevision, lead?: JSX.Element): JSX.Element => (
    <Proposal
      key={revision.revisionHash}
      name={name}
      revision={revision}
      isNewSkill={isNewSkill}
      isNewest={revision === newest}
      now={now}
      timezone={timezone}
      lead={lead}
    />
  );
  return (
    <>
      {/* The header's actions and their lines sit above the record, under
          the header. Check now comes first, so its actions come before
          Upload new version's in the header. */}
      {skill.source.kind === "github" && (
        <CheckNow name={name} lastCheckedAt={skill.lastCheckedAt} />
      )}
      {!isNewSkill && <UploadVersion skill={skill} />}
      <div className="set-record skill-record">
        <SettingsHeaderTitle parent={{ title: "Skills", to: "/settings/skills" }} title={name} />
        {isNewSkill ? (
          <>
            {newest !== undefined &&
              proposal(newest, <NewSkillLead skill={skill} revision={newest} />)}
            {older.map((revision) => proposal(revision))}
          </>
        ) : (
          <>
            {current !== undefined && (
              <SkillLead
                skill={skill}
                revision={current}
                approvalEffects={skill.currentApprovalEffects}
              />
            )}
            <SkillUpdateSection key={skill.availableRevisionHash} skill={skill} />
            {proposedRevisions.map((revision) => proposal(revision))}
            {skillMd !== null && (
              <SkillMdSection text={skillMd} sizeBytes={findSkillMdSize(files)} />
            )}
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
              now={now}
              timezone={timezone}
            />
            <DeleteSection name={name} />
          </>
        )}
      </div>
    </>
  );
}
