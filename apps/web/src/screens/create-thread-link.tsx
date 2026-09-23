import type { JSX } from "react";
import { Link } from "@tanstack/react-router";
import { buildButtonClassName } from "@hercule/ui";

/**
 * The Create new thread link, styled as a primary button. It is used on the
 * Sessions home's ready state and on All sessions. The sidebar has its own
 * version with a `+` and a card style, so it does not use this component.
 */
export function CreateThreadLink(): JSX.Element {
  return (
    <Link to="/threads/new" className={buildButtonClassName("primary", undefined)}>
      Create new thread
    </Link>
  );
}
