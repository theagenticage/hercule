import type { JSX } from "react";
import { OverlapIcon } from "../../icons/overlap";
import "./discussions.css";

/**
 * Renders the mark of a Discussion that an edit overlap opened, `size` CSS
 * pixels square. Hovering it shows why the Discussion exists.
 */
export function OverlapMark({ size }: { readonly size: number }): JSX.Element {
  return (
    <span className="overlap-mark" title="Opened by an edit overlap">
      <OverlapIcon size={size} />
    </span>
  );
}
