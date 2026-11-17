import { useState, type JSX } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  describeSkillProposal,
  describeSkillThirdPartyContent,
  readErrorMessage,
} from "@hercule/client-core";
import type { Skill, SkillRevision } from "@hercule/contract";
import { readSkillsAgain, skillDiffQuery } from "../../../../../app/queries";
import { ActorMark } from "../../../../../screens/actor/actor-mark";
import {
  SkillBand,
  SkillBandLine,
  SkillFileChanges,
} from "../../../../../screens/settings/skills/skill-changes";
import {
  SkillLead,
  SkillApprovalWarnings,
} from "../../../../../screens/settings/skills/skill-page";
import { useActorSenderReading } from "../../../../../screens/thread/use-sender-reading";

/** The size of the proposer's face in the band, in CSS pixels. */
const PROPOSER_MARK_SIZE = 22;

/**
 * Renders one proposed revision of `skill` on its page: its band
 * (`ProposalBand`), then its changes (`ProposalChanges`).
 *
 * The proposal lays itself out. For the newest proposal (`isNewest`) of a
 * skill with no current revision, the page reads band, lead, "What it adds":
 * the lead is the description and chips of `SkillLead` and carries the
 * warning lines for the approval effects, worded as for a current revision.
 * Any other proposal puts those warning lines in its changes, worded for
 * after it is applied.
 *
 * The changes of the newest proposal are open. An older one starts with a
 * button that opens them.
 *
 * `now` and `timezone` place the time of the proposal in its band.
 */
export function Proposal({
  skill,
  revision,
  isNewest,
  now,
  timezone,
}: {
  readonly skill: Skill;
  readonly revision: SkillRevision;
  readonly isNewest: boolean;
  readonly now: Date;
  readonly timezone: string;
}): JSX.Element {
  const isNewSkill = skill.currentRevisionHash === null;
  return (
    <>
      <ProposalBand
        name={skill.name}
        revision={revision}
        isNewSkill={isNewSkill}
        now={now}
        timezone={timezone}
      />
      <ProposalChanges
        skill={skill}
        revision={revision}
        isNewSkill={isNewSkill}
        isOpen={isNewest}
        hasLead={isNewest && isNewSkill}
      />
    </>
  );
}

/**
 * Renders the band over the revision a session proposed for skill `name`
 * (spec 17 §Settings, Skills, Proposed revisions): the proposer's face,
 * "Proposed by Ada, session 7c82ebeb, 14:02" with the chip "Includes
 * third-party content" when the session had read third-party messages, and
 * under it what applying does. Reject calls `skill.reject` and Apply calls
 * `skill.apply`; both then read the Skill Library again. While one runs,
 * both buttons are disabled, and a refusal shows under the band.
 *
 * `isNewSkill` is true for a skill with no current revision. Rejecting its
 * last proposal deletes it, so the page's next read answers "not found" and
 * the page goes back to the list, as it does for a skill deleted elsewhere.
 *
 * `now` and `timezone` place the time of the proposal, as the History does.
 * The band owns its writes, so a write on one proposal never draws another
 * proposal's band or the card of changes.
 */
function ProposalBand({
  name,
  revision,
  isNewSkill,
  now,
  timezone,
}: {
  readonly name: string;
  readonly revision: SkillRevision;
  readonly isNewSkill: boolean;
  readonly now: Date;
  readonly timezone: string;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const queryClient = useQueryClient();
  const { revisionHash, createdBy } = revision;
  const sender = useActorSenderReading(createdBy);
  const settle = { onSettled: () => readSkillsAgain(queryClient) };
  const apply = useMutation({
    mutationFn: () => client.skill.apply({ params: { name, revisionHash } }),
    ...settle,
  });
  const reject = useMutation({
    mutationFn: () => client.skill.reject({ params: { name, revisionHash } }),
    ...settle,
  });
  const busy = apply.isPending || reject.isPending;
  return (
    <div className="skill-update">
      <SkillBand
        mark={<ActorMark actor={createdBy} size={PROPOSER_MARK_SIZE} />}
        actions={
          <>
            <button
              type="button"
              className="btn btn--quiet btn--sm"
              aria-disabled={busy}
              onClick={() => {
                if (busy) return;
                apply.reset();
                reject.mutate();
              }}
            >
              {reject.isPending ? "Rejecting…" : "Reject"}
            </button>
            <button
              type="button"
              className="btn btn--accent btn--sm"
              aria-disabled={busy}
              onClick={() => {
                if (busy) return;
                reject.reset();
                apply.mutate();
              }}
            >
              {apply.isPending ? "Applying…" : "Apply"}
            </button>
          </>
        }
      >
        <SkillBandLine>
          {describeSkillProposal(revision, sender, now, timezone)}
          {revision.includesThirdPartyContent && (
            <span
              className="chip chip--fail"
              title={describeSkillThirdPartyContent(createdBy, sender)}
            >
              Includes third-party content
            </span>
          )}
        </SkillBandLine>
        <SkillBandLine note>
          {isNewSkill
            ? "A new skill: no Thread gets it until you apply it."
            : "Nothing changes until you apply it."}
        </SkillBandLine>
      </SkillBand>
      {apply.error !== null && (
        <p className="set-err" role="alert">
          {`Could not apply: ${readErrorMessage(apply.error)}`}
        </p>
      )}
      {reject.error !== null && (
        <p className="set-err" role="alert">
          {`Could not reject: ${readErrorMessage(reject.error)}`}
        </p>
      )}
    </div>
  );
}

/**
 * Renders what a proposal changes under its band. An open section
 * (`isOpen`) is the newest proposal's: the page's loader reads its diff when
 * it opens, so the section draws at once, and a proposal that arrives while
 * the page is open is read here, with "Reading the changes…" until it is. A
 * section that is not open draws a button, "Show what it changes" ("Show
 * what it adds" for a skill with no current revision, `isNewSkill`), and
 * mounts nothing that reads until it is pressed. This bounds a page's cost to
 * two diffs, whatever the number of proposals.
 *
 * `hasLead` is true when the open section starts with the skill's lead.
 */
function ProposalChanges({
  skill,
  revision,
  isNewSkill,
  isOpen,
  hasLead,
}: {
  readonly skill: Skill;
  readonly revision: SkillRevision;
  readonly isNewSkill: boolean;
  readonly isOpen: boolean;
  readonly hasLead: boolean;
}): JSX.Element {
  const [wasOpened, setWasOpened] = useState(false);
  if (!isOpen && !wasOpened) {
    return (
      <div className="skill-proposal-more">
        <button type="button" className="btn btn--quiet btn--sm" onClick={() => setWasOpened(true)}>
          {isNewSkill ? "Show what it adds" : "Show what it changes"}
        </button>
      </div>
    );
  }
  return (
    <OpenProposalChanges
      skill={skill}
      revision={revision}
      isNewSkill={isNewSkill}
      hasLead={hasLead}
    />
  );
}

/**
 * Renders the open changes of a proposal, which read the revision's diff:
 * the lead when `hasLead`, then "What it changes" ("What it adds" for a new
 * skill) with the files. The warning lines for the approval effects go in
 * the lead when there is one, worded as for a current revision, and in the
 * section otherwise, worded for after the proposal is applied.
 */
function OpenProposalChanges({
  skill,
  revision,
  isNewSkill,
  hasLead,
}: {
  readonly skill: Skill;
  readonly revision: SkillRevision;
  readonly isNewSkill: boolean;
  readonly hasLead: boolean;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const diff = useQuery(skillDiffQuery(client, skill.name, revision.revisionHash));
  const approvalEffects = diff.data?.approvalEffects ?? null;
  return (
    <>
      {hasLead && <SkillLead skill={skill} revision={revision} approvalEffects={approvalEffects} />}
      <section className="set-sec">
        <h2>{isNewSkill ? "What it adds" : "What it changes"}</h2>
        {!hasLead && <SkillApprovalWarnings effects={approvalEffects} wording="afterApply" />}
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
