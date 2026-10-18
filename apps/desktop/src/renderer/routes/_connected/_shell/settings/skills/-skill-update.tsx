import type { JSX } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { readErrorMessage } from "@hercule/client-core";
import type { Skill } from "@hercule/contract";
import { readSkillsAgain, skillDiffQuery } from "../../../../../app/queries";
import {
  SkillFileChanges,
  SkillUpdateBand,
} from "../../../../../screens/settings/skills/skill-changes";
import { SkillApprovalWarnings } from "../../../../../screens/settings/skills/skill-page";

/**
 * Renders the update waiting on `skill` under the lead of its page (spec 17
 * §Settings, Skills, Updates): the band with Update, which applies the
 * revision with `skill.apply`, then the section "What it changes", with the
 * warning lines for the update's approval effects and the files it changes,
 * read with `skill.diff`. Renders nothing unless the skill has a GitHub
 * source, a current revision and an available one.
 *
 * The page's loader reads the diff when the page opens on an update. An
 * update that a check finds while the page is open is read here, so the
 * page shows it without waiting: the section says the changes are being
 * read until they are. The page draws this section afresh for each
 * available revision, so an error from Update on an older one goes with it.
 */
export function SkillUpdateSection({ skill }: { readonly skill: Skill }): JSX.Element | null {
  const { source, availableRevisionHash, currentRevisionHash } = skill;
  if (source.kind !== "github" || availableRevisionHash === null || currentRevisionHash === null)
    return null;
  return <WaitingUpdate skill={skill} repo={source.repo} revisionHash={availableRevisionHash} />;
}

/**
 * Renders the update `revisionHash` waiting on `skill` from the GitHub
 * repository `repo`, as `SkillUpdateSection` describes it.
 */
function WaitingUpdate({
  skill,
  repo,
  revisionHash,
}: {
  readonly skill: Skill;
  readonly repo: string;
  readonly revisionHash: string;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const queryClient = useQueryClient();
  const { name } = skill;
  const diff = useQuery(skillDiffQuery(client, name, revisionHash));
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
        <SkillApprovalWarnings effects={skill.availableApprovalEffects} wording="afterUpdate" />
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
