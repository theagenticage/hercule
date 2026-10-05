import type { JSX } from "react";
import { Link } from "@tanstack/react-router";

/**
 * Renders the crumb of a step session: the run that started it, such as
 * "run 3db7d6bb", in mono as ids are, and linked to the run's page. The
 * words come from `describeStartingRun`, so the crumb reads like the
 * session's row on All sessions. The step is left out because the session's
 * title beside the crumb already names it.
 */
export function StepSessionCrumb({
  runId,
  label,
}: {
  readonly runId: string;
  /** The run, from `describeStartingRun`. */
  readonly label: string;
}): JSX.Element {
  return (
    <Link
      to="/runs/$runId"
      params={{ runId }}
      className="rounded-control font-mono tracking-normal hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live"
    >
      {label}
    </Link>
  );
}
