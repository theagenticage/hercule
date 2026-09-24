/**
 * The "Worked for" / "Working for" divider. It is collapsed by default and
 * expands to a quiet mono list with one `verb · target · result` line per tool
 * item (spec 14 §The thread surface).
 *
 * While the turn is live, the time updates every second and shimmers in the
 * live colour. With `prefers-reduced-motion`, the shimmer stops and the colour
 * stays (design language §Semantic encodings). Only the stylesheet handles
 * that: `.hercule-thread-shimmer` in `@hercule/ui` has the media query, so
 * there is no second copy of the rule here that could drift.
 */
import { useEffect, useState, type JSX } from "react";
import { cn } from "@hercule/ui";
import { formatDuration, type ThreadItem } from "@hercule/client-core";

/**
 * Returns the text colour class for a tool item's result: the live colour
 * while it runs, the attention colour while it awaits approval, and none
 * otherwise.
 */
const chooseResultHue = (result: ThreadItem["result"]): string | undefined =>
  result === "running" ? "text-live" : result === "awaiting approval" ? "text-attn" : undefined;

export function TurnDivider({
  live,
  duration,
  startedAt,
  items,
}: {
  readonly live: boolean;
  /**
   * The turn's duration in milliseconds; null for a turn with no
   * `turn.completed` row. A live turn shows its elapsed time instead. A turn
   * that is not live and has no duration was abandoned rather than finished,
   * so it shows no number.
   */
  readonly duration: number | null;
  readonly startedAt: string;
  readonly items: readonly ThreadItem[];
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [live]);

  // A turn that is not live and has no duration was abandoned before
  // `turn.completed` arrived, most often by an interrupt. There is no true
  // number to show, and "0s" would wrongly suggest it finished instantly.
  const reading = live
    ? `Working for ${formatDuration(now - Date.parse(startedAt))}`
    : duration === null
      ? "Worked for —"
      : `Worked for ${formatDuration(duration)}`;

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((was) => !was)}
        className={cn(
          "flex items-center gap-1.5 font-mono text-fine tabular-nums",
          live ? "hercule-thread-shimmer" : "text-faint",
        )}
      >
        {reading}
        <span aria-hidden="true">{open ? "⌄" : "›"}</span>
      </button>
      {open ? (
        <ul className="mt-1 flex flex-col gap-0.5 font-mono text-fine text-muted">
          {items.map((item) => (
            <li key={item.itemId} className={chooseResultHue(item.result)}>
              {item.verb} · {item.target} · {item.result}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
