import type { JSX } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { readErrorMessage } from "@hercule/client-core";
import type { Skill } from "@hercule/contract";
import { readSkillsAgain, skillDiffQuery } from "../../../../../app/queries";
import {
  SkillFileChanges,
  SkillUpdateBand,
  SkillUpdateWarnings,
} from "../../../../../screens/settings/skills/skill-changes";

/**
 * Renders the update waiting on `skill`, from the GitHub repository `repo`,
 * under the lead of its page (spec 17 §Settings, Skills, Updates): the band
 * with Update, which applies the revision with `skill.apply`, then the
 * section "What it changes", with the warning lines for the update's
 * approval effects and the files it changes, read with `skill.diff`.
 *
 * The page's loader reads the diff when the page opens on an update. An
 * update that a check finds while the page is open is read here, so the
 * page shows it without waiting: the section says the changes are being
 * read until they are.
 */
export function SkillUpdate({
  skill,
  repo,
  revisionHash,
  currentRevisionHash,
}: {
  readonly skill: Skill;
  readonly repo: string;
  readonly revisionHash: string;
  readonly currentRevisionHash: string;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const queryClient = useQueryClient();
  const { name } = skill;
  const diff = useQuery(skillDiffQuery(client, name, revisionHash, currentRevisionHash));
  const apply = useMutation({
    mutationFn: () => client.skill.apply({ params: { name, revisionHash } }),
    onSettled: () => readSkillsAgain(queryClient),
  });
  return (
    <>
      <div className="skill-update">
        <SkillUpdateBand
          repo={repo}
          action={
            <button
              type="button"
              className="btn btn--accent btn--sm"
              aria-disabled={apply.isPending}
              onClick={() => {
                if (!apply.isPending) apply.mutate();
              }}
            >
              {apply.isPending ? "Updating…" : "Update"}
            </button>
          }
        />
        {apply.error !== null && (
          <p className="set-err" role="alert">
            {`Could not update: ${readErrorMessage(apply.error)}`}
          </p>
        )}
      </div>
      <section className="set-sec">
        <h2>What it changes</h2>
        <SkillUpdateWarnings effects={skill.availableApprovalEffects} />
        {diff.data !== undefined && <SkillFileChanges files={diff.data.files} />}
        {diff.isPending && <p className="set-note">Reading the changes…</p>}
        {diff.error !== null && (
          <p className="set-err" role="alert">
            {`Could not read the changes: ${readErrorMessage(diff.error)}`}
          </p>
        )}
      </section>
    </>
  );
}
