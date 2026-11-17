import { useState, type JSX, type ReactNode } from "react";
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
 * Renders one proposed revision of skill `name` on its page: its band
 * (`ProposalBand`) and its changes (`ProposalChanges`), with `lead` between
 * them when given. A skill with no current revision puts the lead of its
 * newest proposal there (`NewSkillLead`), so the page reads band, lead,
 * "What it adds".
 *
 * `isNewest` is true for the newest proposal of the skill, whose changes are
 * open. An older one starts with a button that opens them. The warning lines
 * for the revision's approval effects sit in the changes, unless `lead` is
 * given: then the lead shows them.
 */
export function Proposal({
  name,
  revision,
  isNewSkill,
  isNewest,
  now,
  timezone,
  lead,
}: {
  readonly name: string;
  readonly revision: SkillRevision;
  readonly isNewSkill: boolean;
  readonly isNewest: boolean;
  readonly now: Date;
  readonly timezone: string;
  readonly lead?: ReactNode;
}): JSX.Element {
  return (
    <>
      <ProposalBand
        name={name}
        revision={revision}
        isNewSkill={isNewSkill}
        now={now}
        timezone={timezone}
      />
      {lead}
      <ProposalChanges
        name={name}
        revisionHash={revision.revisionHash}
        isNewSkill={isNewSkill}
        isOpen={isNewest}
        warnsInLead={lead !== undefined}
      />
    </>
  );
}

/**
 * Renders the lead of a skill with no current revision, from its newest
 * proposal `revision`: the description and chips of `SkillLead`, and the
 * warning lines for the approval effects the proposal's diff gives, worded as
 * for a current revision. The effects are null until the diff is read, which
 * the page's loader does before it draws.
 */
export function NewSkillLead({
  skill,
  revision,
}: {
  readonly skill: Skill;
  readonly revision: SkillRevision;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const diff = useQuery(skillDiffQuery(client, skill.name, revision.revisionHash));
  return (
    <SkillLead
      skill={skill}
      revision={revision}
      approvalEffects={diff.data?.approvalEffects ?? null}
    />
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
 * Renders the section under a proposal's band: "What it changes", or "What
 * it adds" for a skill with no current revision (`isNewSkill`). It holds the
 * files the revision changes, read with `skill.diff`, and the warning lines
 * for its approval effects, unless `warnsInLead`: the page's lead shows them
 * then.
 *
 * An open section (`isOpen`) is the newest proposal's: the page's loader
 * reads its diff when it opens, so the section draws at once, and a proposal
 * that arrives while the page is open is read here, with "Reading the
 * changes…" until it is. A section that is not open draws a button, "Show
 * what it changes" ("Show what it adds"), and reads nothing until it is
 * pressed. This bounds a page's cost to two diffs, whatever the number of
 * proposals.
 */
function ProposalChanges({
  name,
  revisionHash,
  isNewSkill,
  isOpen,
  warnsInLead,
}: {
  readonly name: string;
  readonly revisionHash: string;
  readonly isNewSkill: boolean;
  readonly isOpen: boolean;
  readonly warnsInLead: boolean;
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
      name={name}
      revisionHash={revisionHash}
      isNewSkill={isNewSkill}
      warnsInLead={warnsInLead}
    />
  );
}

/** Renders the open section of `ProposalChanges`, which reads the revision's diff. */
function OpenProposalChanges({
  name,
  revisionHash,
  isNewSkill,
  warnsInLead,
}: {
  readonly name: string;
  readonly revisionHash: string;
  readonly isNewSkill: boolean;
  readonly warnsInLead: boolean;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const diff = useQuery(skillDiffQuery(client, name, revisionHash));
  return (
    <section className="set-sec">
      <h2>{isNewSkill ? "What it adds" : "What it changes"}</h2>
      {!warnsInLead && (
        <SkillApprovalWarnings effects={diff.data?.approvalEffects ?? null} wording="afterApply" />
      )}
      {diff.data !== undefined && <SkillFileChanges files={diff.data.files} />}
      {diff.isPending && <p className="set-note">Reading the changes…</p>}
      {diff.error !== null && (
        <p className="set-err" role="alert">
          {`Could not read the changes: ${readErrorMessage(diff.error)}`}
        </p>
      )}
    </section>
  );
}
