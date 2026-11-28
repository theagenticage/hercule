import type { JSX } from "react";
import { Link } from "@tanstack/react-router";
import { NotFound } from "../../../../screens/not-found";

/**
 * Renders the screen of a machine that does not exist or is retired, with a
 * link back to Fleet. A machine's page and its activity both show it:
 * retired machines are not shown anywhere on Fleet.
 */
export function RunnerNotFound(): JSX.Element {
  return (
    <NotFound headline="This machine was not found.">
      <Link to="/fleet" className="btn btn--accent">
        Fleet
      </Link>
    </NotFound>
  );
}
