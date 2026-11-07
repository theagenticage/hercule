import { useState, type JSX } from "react";
import "./section-heading.css";

/**
 * Renders the heading of a stage or a section: its `name` in 12px medium ink,
 * with `count` small and faint beside it, such as "Exploring 13". A count of
 * zero is left out, because a heading with "0" beside it is noise. When
 * `count` changes, the new number rolls into place, upward for a larger count
 * and downward for a smaller one; the first count drawn does not move. `className` is added to the heading, for the page to place it.
 */
export function SectionHeading({
  name,
  count,
  className,
}: {
  readonly name: string;
  readonly count: number;
  readonly className?: string;
}): JSX.Element {
  // Set while drawing, so the number that changes already carries the mark on
  // the draw that shows it.
  const [shownCount, setShownCount] = useState(count);
  const [change, setChange] = useState<"rises" | "falls" | null>(null);
  if (shownCount !== count) {
    setShownCount(count);
    setChange(count > shownCount ? "rises" : "falls");
  }
  return (
    <h3 className={className === undefined ? "desk-heading" : `desk-heading ${className}`}>
      <span>{name}</span>
      {count > 0 && (
        // The key makes a new number a new element, so its entrance plays again.
        <span
          key={count}
          className="desk-heading-count"
          data-rises={change === "rises" ? "" : undefined}
          data-falls={change === "falls" ? "" : undefined}
        >
          {count}
        </span>
      )}
    </h3>
  );
}
