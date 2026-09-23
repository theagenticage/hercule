import type { JSX } from "react";
import { Link } from "@tanstack/react-router";
import { buildButtonClassName } from "@hercule/ui";

/**
 * Create new thread, wherever it appears as a plain primary affordance: the
 * Sessions home's ready state and All sessions. The sidebar's own carries a
 * `+` and a card look of its own, so it is not built from this.
 */
export function CreateThreadLink(): JSX.Element {
  return (
    <Link to="/threads/new" className={buildButtonClassName("primary", undefined)}>
      Create new thread
    </Link>
  );
}
