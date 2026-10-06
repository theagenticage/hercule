import { useState, type JSX } from "react";
import { describeBriefSource, type SubagentBrief } from "@hercule/client-core";
import type { Subagent } from "@hercule/contract";
import { cn } from "@hercule/ui";

/**
 * Renders the card at the top of a subagent's page: "Brief from <parent> ·
 * <agent type> agent", then the brief its parent gave it, cut to three lines
 * until clicked (spec 14 §Subagents on the thread surface).
 *
 * While the brief has not been read, the card shows the "Brief from" line
 * alone.
 */
export function BriefCard({
  subagents,
  subagent,
  brief,
}: {
  /** Every subagent of the session, oldest first, which name the parent. */
  readonly subagents: readonly Subagent[];
  /** The subagent whose page this is. */
  readonly subagent: Subagent;
  /** The brief, as `findSubagentBrief` finds it; undefined while it is not read. */
  readonly brief: SubagentBrief | undefined;
}): JSX.Element {
  const [isWhole, setIsWhole] = useState(false);
  const source = describeBriefSource(subagent, subagents);
  return (
    <div className="flex flex-col gap-1 rounded-[10px] border border-line-soft bg-surface px-3.5 py-2.5">
      <span className="text-meta text-muted">
        Brief from <span className="font-emph text-ink">{source.parent}</span>
        {source.agentType === undefined ? null : (
          <>
            {" · "}
            <span className="font-mono text-fine">{source.agentType}</span> agent
          </>
        )}
      </span>
      {brief === undefined ? null : (
        <button
          type="button"
          aria-expanded={isWhole}
          onClick={() => {
            setIsWhole(!isWhole);
          }}
          className="cursor-pointer text-left text-row whitespace-pre-wrap text-ink"
        >
          <span className={cn(!isWhole && "line-clamp-3")}>{brief.text}</span>
        </button>
      )}
    </div>
  );
}
