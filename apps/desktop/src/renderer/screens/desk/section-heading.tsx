import type { JSX } from "react";
import "./section-heading.css";

/**
 * Renders the heading of a stage or a section: its `name` in 12px medium ink,
 * with `count` small and faint beside it, such as "Exploring 13". A count of
 * zero is left out, because a heading with "0" beside it is noise.
 * `className` is added to the heading, for the page to place it.
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
  return (
    <h3 className={className === undefined ? "desk-heading" : `desk-heading ${className}`}>
      <span>{name}</span>
      {count > 0 && <span className="desk-heading-count">{count}</span>}
    </h3>
  );
}
