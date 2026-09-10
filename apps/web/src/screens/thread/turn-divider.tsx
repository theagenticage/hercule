/**
 * The "Worked for" / "Working for" divider: collapsed by default, expanding to
 * a quiet mono `verb · target · result` list per tool item (spec 14 §The
 * thread surface). The live reading ticks every second and carries the shimmer
 * in the live hue. `prefers-reduced-motion` drops the sweep and keeps the hue
 * (design language §Semantic encodings); that rule is the stylesheet's alone -
 * `.hydra-thread-shimmer` in `@hydra/ui` answers the media query - so there is
 * no second copy of it here to drift from it.
 */
import { useEffect, useState, type JSX } from "react";
import { cn } from "@hydra/ui";
import { formatDuration, type ThreadItem } from "@hydra/client-core";

export function TurnDivider({
  live,
  duration,
  startedAt,
  items,
}: {
  readonly live: boolean;
  /**
   * Milliseconds; null for a turn with no `turn.completed` row. A live turn
   * reads its own elapsed time instead; one that is not live and still has no
   * duration was abandoned rather than finished, so its reading omits a number.
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

  // A turn that is neither live nor carries a duration was abandoned before
  // `turn.completed` ever arrived - an interrupt, most often - so there is no
  // honest number to read; "0s" would claim it finished instantly, which it
  // did not.
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
          live ? "hydra-thread-shimmer" : "text-faint",
        )}
      >
        {reading}
        <span aria-hidden="true">{open ? "⌄" : "›"}</span>
      </button>
      {open ? (
        <ul className="mt-1 flex flex-col gap-0.5 font-mono text-fine text-muted">
          {items.map((item) => (
            <li key={item.itemId} className={item.result === "running" ? "text-live" : undefined}>
              {item.verb} · {item.target} · {item.result}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
