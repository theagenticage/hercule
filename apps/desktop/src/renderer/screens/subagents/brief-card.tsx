/**
 * The brief card: the first block of a subagent's page, holding the work its
 * parent handed it (spec 14 §Subagents on the thread surface, spec 17
 * §Thread, Subagents).
 */
import { useState, type JSX } from "react";
import { describeBriefSource } from "@hercule/client-core";
import type { Subagent } from "@hercule/contract";
import { Face, buildHueStyle, buildLook } from "../../faces";
import { buildAgentFaceSeed, buildSubagentLook } from "./subagent-face";
import "./brief-card.css";

/** The size of the parent's face in the card's top line, in CSS pixels, as the prototype draws it. */
const PARENT_FACE_SIZE = 18;

/**
 * Renders the brief card of `subagent`: "Brief from <parent> · <agent type>
 * agent" beside the parent's face, then the brief, cut to three lines until
 * the user clicks it. A second click cuts it again.
 *
 * - `subagents` are the session's subagents, which hold the parent.
 * - `brief` is the brief's text, as `splitSubagentBrief` finds it. While it
 *   is undefined, the card shows the top line alone.
 *
 * The card is tinted in the subagent's hue, so the page cannot pass for a
 * thread. It is not a user's bubble, because nobody typed the brief here.
 * The parent's face is still, as every face but the running turn's is.
 */
export function BriefCard({
  subagent,
  subagents,
  brief,
}: {
  readonly subagent: Subagent;
  readonly subagents: readonly Subagent[];
  readonly brief: string | undefined;
}): JSX.Element {
  const [isWhole, setIsWhole] = useState(false);
  const source = describeBriefSource(subagent, subagents);
  const parentLook = buildLook(buildAgentFaceSeed(subagent.sessionId, subagent.parentSubagentId));
  return (
    <div className="brief-card" style={buildHueStyle(buildSubagentLook(subagent).hue)}>
      <div className="brief-card-source">
        <Face look={parentLook} pose="idle" size={PARENT_FACE_SIZE} />
        <span>
          Brief from <b>{source.parent}</b>
          {source.agentType === undefined ? null : ` · ${source.agentType} agent`}
        </span>
      </div>
      {brief === undefined ? null : (
        <button
          type="button"
          className={isWhole ? "brief-card-text" : "brief-card-text is-clamped"}
          aria-expanded={isWhole}
          onClick={() => {
            setIsWhole(!isWhole);
          }}
        >
          {brief}
        </button>
      )}
    </div>
  );
}
