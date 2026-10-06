import type { JSX } from "react";
import { Link } from "@tanstack/react-router";
import { NotFound } from "../not-found";

/**
 * Renders the screen shown when the thread does not exist, with a link to the
 * new-thread screen.
 */
export function ThreadNotFound(): JSX.Element {
  return (
    <NotFound headline="This thread was not found.">
      <Link to="/" className="btn btn--accent">
        Start a new thread
      </Link>
    </NotFound>
  );
}
