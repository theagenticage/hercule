import type { JSX } from "react";
import "./relation-rows.css";

/**
 * Renders how far along a source says something is: a 4px bar in ink at 55%,
 * with `words` such as "4 of 9" beside it when there are any. `fraction` is
 * from 0 to 1. The bar is a short 36px inside a row and, with `wide`, the 72px
 * the head of a place draws.
 *
 * Only a source's own report belongs here: the page never works progress out
 * from the cards it can see. With `words`, the words are the text and the bar
 * is hidden from assistive technology. Without them, the bar says its share.
 */
export function ProgressBar({
  fraction,
  words,
  wide = false,
}: {
  readonly fraction: number;
  readonly words?: string;
  readonly wide?: boolean;
}): JSX.Element {
  const percent = Math.round(fraction * 100);
  return (
    <span className={wide ? "relation-progress is-wide" : "relation-progress"}>
      <span
        className="relation-bar"
        {...(words === undefined
          ? { role: "img", "aria-label": `${String(percent)} percent done` }
          : { "aria-hidden": true })}
      >
        <i style={{ width: `${String(percent)}%` }} />
      </span>
      {words !== undefined && <span className="relation-progress-words">{words}</span>}
    </span>
  );
}
