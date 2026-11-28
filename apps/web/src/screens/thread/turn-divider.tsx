/**
 * The divider under a turn that shows how long the agent worked, or how the
 * turn ended; `describeTurnDivider` in client-core picks the words. A turn
 * with tool items can open the divider into a quiet mono list with one
 * `verb · target · result` line per item, and under a todo list's line one
 * indented line per step. A compaction line that has a summary opens, with the
 * same chevron, to the summary the harness wrote, as wrapped prose in the UI
 * face in a quiet box that scrolls past about ten lines; a compaction with no
 * summary is a plain line. Every line of the list wraps at any character, so a
 * long path never overflows a narrow column. A turn with no tool items has
 * nothing to list, so its divider is plain text with no chevron. Spec 14 §The
 * thread surface owns the divider.
 *
 * While the turn is live, the time updates every second and shimmers in the
 * live colour. With `prefers-reduced-motion`, the shimmer stops and the colour
 * stays (design language §Semantic encodings). Only the stylesheet handles
 * that: `.hercule-thread-shimmer` in `@hercule/ui` has the media query, so
 * there is no second copy of the rule here that could drift.
 */
import { useEffect, useState, type JSX } from "react";
import { cn } from "@hercule/ui";
import {
  describeThreadItem,
  describeTurnDivider,
  type ThreadItem,
  type ThreadTurn,
} from "@hercule/client-core";
import type { TodoStep } from "@hercule/contract";

/**
 * Returns the text colour class for a tool item's result: the live colour
 * while it runs, the attention colour while it awaits approval, and none
 * otherwise.
 */
const chooseResultHue = (result: ThreadItem["result"]): string | undefined =>
  result === "running" ? "text-live" : result === "awaiting approval" ? "text-attn" : undefined;

/**
 * The mark and the accessible name of each todo step status, and its text
 * colour class. The marks are three circles that the mono face draws at the
 * same size and weight, filling up as the step does: a full circle for done,
 * a half circle in the live colour for the step the agent is on, an empty
 * circle for one still waiting. A check or a dot beside them draws larger or
 * smaller, so no check is used.
 */
const STEP_MARKS: Record<
  TodoStep["status"],
  { readonly mark: string; readonly name: string; readonly hue: string | undefined }
> = {
  completed: { mark: "●", name: "Completed", hue: undefined },
  in_progress: { mark: "◐", name: "In progress", hue: "text-live" },
  pending: { mark: "○", name: "Pending", hue: undefined },
};

/** Draws the steps of a todo list, one indented line per step, under the list's own line. */
function TodoSteps({ steps }: { readonly steps: readonly TodoStep[] }): JSX.Element {
  return (
    <ul className="mt-0.5 flex flex-col gap-0.5 pl-4">
      {steps.map((step, index) => {
        const { mark, name, hue } = STEP_MARKS[step.status];
        return (
          // A step has no id and its text can repeat; the list keeps its order, so the position names it.
          <li key={index} className={cn("flex gap-1.5", hue)}>
            <span role="img" aria-label={name}>
              {mark}
            </span>
            <span>{step.text}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** The ring a focused line draws, as every other focusable control in the web app does. */
const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live";

/** Draws a compaction's line as a disclosure, closed at first, that opens to the summary the harness wrote. */
function CompactionLine({
  line,
  summary,
}: {
  readonly line: string;
  readonly summary: string;
}): JSX.Element {
  return (
    <details className="group/compaction">
      <summary
        className={cn(
          "w-fit cursor-pointer list-none rounded-control [&::-webkit-details-marker]:hidden",
          FOCUS_RING,
        )}
      >
        {line}
        {/* Inline after the last word, so a wrapped line keeps the chevron beside its text. */}
        <span
          aria-hidden="true"
          className="ml-1.5 inline-block transition-transform group-open/compaction:rotate-90"
        >
          ›
        </span>
      </summary>
      {/* A stop in the tab order, so a keyboard user can scroll it. The inset is a transparent
          border outside the scrolling area, so no half line shows at the bottom. */}
      <div
        role="region"
        aria-label="Compaction summary"
        tabIndex={0}
        className={cn(
          "mt-1 mb-1 ml-4 max-h-54 overflow-y-auto rounded-card border-x-12 border-y-8 border-transparent bg-surface",
          "font-sans text-fine leading-5 whitespace-pre-wrap text-muted",
          "outline outline-1 -outline-offset-1 outline-line-soft",
          FOCUS_RING,
        )}
      >
        {summary}
      </div>
    </details>
  );
}

export function TurnDivider({
  turn,
  live,
}: {
  readonly turn: ThreadTurn;
  /** Whether the turn is running; its elapsed time is shown instead of its duration. */
  readonly live: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [live]);

  const reading = describeTurnDivider(turn, live, now);
  const style = cn(
    "flex items-center gap-1.5 font-mono text-fine tabular-nums",
    live ? "hercule-thread-shimmer" : "text-faint",
  );

  if (turn.items.length === 0) return <p className={style}>{reading}</p>;

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
        className={cn(style, "rounded-control", FOCUS_RING)}
      >
        {reading}
        {/* One glyph, turned when the list is open, so the chevron keeps
            its baseline, as the pulse's chevron does. */}
        <span aria-hidden="true" className={cn("transition-transform", open && "rotate-90")}>
          ›
        </span>
      </button>
      {open ? (
        <ul className="mt-1 flex flex-col gap-0.5 font-mono text-fine wrap-anywhere text-muted">
          {turn.items.map((item) => (
            <li key={item.itemId} className={chooseResultHue(item.result)}>
              {item.compactionSummary === undefined ? (
                describeThreadItem(item)
              ) : (
                <CompactionLine line={describeThreadItem(item)} summary={item.compactionSummary} />
              )}
              {item.todoSteps.length > 0 ? <TodoSteps steps={item.todoSteps} /> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
