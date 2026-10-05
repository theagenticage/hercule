import type { JSX } from "react";
import { Link } from "@tanstack/react-router";

/**
 * Renders the crumb of a step session: the run that started it, such as
 * "run 3db7d6bb", linked to the run's page. It is set in the crumb's sans
 * like every other crumb, because mono at title size outweighs the title. The
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
      className="rounded-control hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live"
    >
      {label}
    </Link>
  );
}
