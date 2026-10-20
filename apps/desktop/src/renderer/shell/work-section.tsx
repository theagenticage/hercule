import type { JSX } from "react";
import { Link, useMatch } from "@tanstack/react-router";
import { useToDoCount } from "../app/tracking";
import { DiscussionsIcon } from "../icons/discussions";
import { IntakeIcon } from "../icons/intake";
import { OfficeIcon } from "../icons/office";
import { WikiIcon } from "../icons/wiki";
import { WorkflowsIcon } from "../icons/workflows";
import { SELECTED_LINK_PROPS } from "../screens/selected-link-props";

/**
 * Renders the Hercule face's Work section, each row selected while its
 * screen is open:
 *
 * - The office, first, with no count.
 * - Intake, ending in its To do count in marigold: the open signals and the
 *   rows of Tracking that wait on the user. The count is hidden at 0.
 * - Workflows, with no count: a total of the user's workflows gives the user
 *   nothing to act on. What a run waits on the user for shows in Waiting on
 *   you instead. The row is also selected on a run's page, because a run
 *   belongs to its workflow, as the book draws it.
 * - Discussions and Wiki, with no count either.
 *
 * The shell's loader reads the To do list and Tracking's reads, and keeps
 * them cached for the life of the window, so nothing here waits in practice.
 */
export function WorkSection(): JSX.Element {
  const toDoCount = useToDoCount();
  const runOpen =
    useMatch({ from: "/_connected/_shell/runs/$runId", shouldThrow: false }) !== undefined;
  return (
    <section className="side-sec">
      <h3 className="side-h">
        <span>Work</span>
      </h3>
      <Link to="/office" className="nav-row" activeProps={SELECTED_LINK_PROPS}>
        <OfficeIcon />
        <span>The office</span>
      </Link>
      {/* A screen reader reads the count with what it counts, as it does the
          Hercule segment's: "Intake, 8 to do". */}
      <Link
        to="/intake"
        className="nav-row"
        activeProps={SELECTED_LINK_PROPS}
        aria-label={toDoCount > 0 ? `Intake, ${String(toDoCount)} to do` : undefined}
      >
        <IntakeIcon />
        <span>Intake</span>
        {toDoCount > 0 && <b className="count count--you">{toDoCount}</b>}
      </Link>
      <Link
        to="/workflows"
        className={runOpen ? "nav-row is-on" : "nav-row"}
        aria-current={runOpen ? "page" : undefined}
        activeProps={SELECTED_LINK_PROPS}
      >
        <WorkflowsIcon />
        <span>Workflows</span>
      </Link>
      <Link to="/discussions" className="nav-row" activeProps={SELECTED_LINK_PROPS}>
        <DiscussionsIcon />
        <span>Discussions</span>
      </Link>
      <Link to="/wiki" className="nav-row" activeProps={SELECTED_LINK_PROPS}>
        <WikiIcon />
        <span>Wiki</span>
      </Link>
    </section>
  );
}
