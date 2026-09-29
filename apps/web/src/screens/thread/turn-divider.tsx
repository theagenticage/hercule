/**
 * The divider under a turn that shows how long the agent worked, or how the
 * turn ended; `describeTurnDivider` in client-core picks the words. A turn
 * with tool items can open the divider into a quiet mono list with one
 * `verb · target · result` line per item. A turn with none has nothing to
 * list, so its divider is plain text with no chevron. Spec 14 §The thread
 * surface owns the divider.
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

/**
 * Returns the text colour class for a tool item's result: the live colour
 * while it runs, the attention colour while it awaits approval, and none
 * otherwise.
 */
const chooseResultHue = (result: ThreadItem["result"]): string | undefined =>
  result === "running" ? "text-live" : result === "awaiting approval" ? "text-attn" : undefined;

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
      <button type="button" onClick={() => setOpen((was) => !was)} className={style}>
        {reading}
        {/* One glyph, turned when the list is open, so the chevron keeps
            its baseline, as the pulse's chevron does. */}
        <span aria-hidden="true" className={cn("transition-transform", open && "rotate-90")}>
          ›
        </span>
      </button>
      {open ? (
        <ul className="mt-1 flex flex-col gap-0.5 font-mono text-fine text-muted">
          {turn.items.map((item) => (
            <li key={item.itemId} className={chooseResultHue(item.result)}>
              {describeThreadItem(item)}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
