import type { JSX } from "react";
import { Link } from "@tanstack/react-router";

/**
 * Renders the crumb of a step session: which step and run started it, such
 * as "step implement · run 3db7d6bb", as one link to the run's page. The
 * words come from `describeStartingStep`, so the crumb reads like the
 * session's row on All sessions.
 */
export function StepSessionCrumb({
  runId,
  label,
}: {
  readonly runId: string;
  /** The step and run, from `describeStartingStep`. */
  readonly label: string;
}): JSX.Element {
  return (
    <Link
      to="/runs/$runId"
      params={{ runId }}
      className="rounded-control hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live"
    >
      {label}
    </Link>
  );
}
