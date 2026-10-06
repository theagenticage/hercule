import { useState, type JSX } from "react";
import { nameSubagent, type ThreadTurn } from "@hercule/client-core";
import type { Subagent } from "@hercule/contract";
import { cn } from "@hercule/ui";

/**
 * Renders the card at the top of a subagent's page: "Brief from <parent> ·
 * <agent type> agent", then the brief its parent gave it, cut to three lines
 * until clicked (spec 14 §Subagents on the thread surface).
 *
 * The brief is the user message of the subagent's first turn, which is how a
 * harness hands a subagent its brief. While that turn has not been read, the
 * card shows its first line alone.
 */
export function BriefCard({
  subagents,
  subagent,
  turns,
}: {
  /** Every subagent of the session, oldest first, which name the parent. */
  readonly subagents: readonly Subagent[];
  /** The subagent whose page this is. */
  readonly subagent: Subagent;
  /** The subagent's turns, oldest first. */
  readonly turns: readonly ThreadTurn[];
}): JSX.Element {
  const [isWhole, setIsWhole] = useState(false);
  const parent = subagents.find((each) => each.id === subagent.parentSubagentId);
  const brief = turns[0]?.user ?? "";
  return (
    <div className="flex flex-col gap-1 rounded-[10px] border border-line-soft bg-surface px-3.5 py-2.5">
      <span className="text-meta text-muted">
        Brief from{" "}
        <span className="font-emph text-ink">
          {parent === undefined ? "the main agent" : nameSubagent(parent)}
        </span>
        {subagent.agentType === undefined ? null : (
          <>
            {" · "}
            <span className="font-mono text-fine">{subagent.agentType}</span> agent
          </>
        )}
      </span>
      {brief === "" ? null : (
        <button
          type="button"
          aria-expanded={isWhole}
          onClick={() => {
            setIsWhole(!isWhole);
          }}
          className="cursor-pointer text-left text-row whitespace-pre-wrap text-ink"
        >
          <span className={cn(!isWhole && "line-clamp-3")}>{brief}</span>
        </button>
      )}
    </div>
  );
}
