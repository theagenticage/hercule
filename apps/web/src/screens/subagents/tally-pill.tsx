import type { JSX } from "react";
import { describeSubagentTally, toggleSidePaneSurface } from "@hercule/client-core";
import type { Session, Subagent } from "@hercule/contract";
import { DecisionMark, DoneMark, WorkingMark, cn } from "@hercule/ui";
import { useSidePaneLayout } from "./use-side-pane";

/**
 * The pill above the composer, or above a subagent's status card, that reads
 * `Subagents · n of m running` while the thread has any subagent. A click
 * shows the side pane on its Subagents surface, or hides the pane when that
 * surface already shows (spec 14 §Subagents on the thread surface). Renders
 * nothing while the thread has no subagent.
 */
export function TallyPill({
  session,
  subagents,
}: {
  readonly session: Session;
  /** Every subagent of the session, oldest first. */
  readonly subagents: readonly Subagent[];
}): JSX.Element | null {
  const { layout, changeLayout } = useSidePaneLayout();
  if (subagents.length === 0) return null;
  const tally = describeSubagentTally(subagents, session.openRequests);
  const shown = layout.open && layout.shown === "subagents";
  return (
    <div className="flex px-1">
      <button
        type="button"
        aria-pressed={shown}
        title={shown ? "Hide the side pane" : "Show the subagents in the side pane"}
        onClick={() => {
          changeLayout((current) => toggleSidePaneSurface(current, "subagents"));
        }}
        className={cn(
          "inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-line bg-raised py-[3px] pr-[11px] pl-2 text-meta whitespace-nowrap hover:bg-line-soft hover:text-ink",
          "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live",
          shown ? "text-ink" : "text-muted",
        )}
      >
        <span className="flex w-3 shrink-0 justify-center">
          {tally.mark === "done" ? (
            <DoneMark />
          ) : tally.mark === "waiting" ? (
            <DecisionMark />
          ) : (
            <WorkingMark />
          )}
        </span>
        Subagents
        <span className="font-mono text-fine text-faint tabular-nums">{tally.count}</span>
      </button>
    </div>
  );
}
