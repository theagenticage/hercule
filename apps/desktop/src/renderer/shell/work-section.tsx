import type { JSX } from "react";
import { countToDo } from "@hercule/client-core";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link, useMatch, useRouteContext } from "@tanstack/react-router";
import { signalsToDoQuery } from "../app/queries";
import { IntakeIcon } from "../icons/intake";
import { WorkflowsIcon } from "../icons/workflows";
import { SELECTED_LINK_PROPS } from "../screens/selected-link-props";

/**
 * Renders the Hercule face's Work section, each row selected while its
 * screen is open:
 *
 * - Intake, ending in its To do count in marigold. The count is hidden at 0.
 * - Workflows, with no count: a total of the user's workflows gives the user
 *   nothing to act on. What a run waits on the user for shows in Waiting on
 *   you instead. The row is also selected on a run's page, because a run
 *   belongs to its workflow, as the book draws it.
 *
 * The shell's loader reads the To do list and keeps it cached for the life
 * of the window, so nothing here waits in practice.
 */
export function WorkSection(): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const toDoCount = useSuspenseQuery({
    ...signalsToDoQuery(client),
    select: (signals) => countToDo(signals),
  }).data;
  const runOpen =
    useMatch({ from: "/_connected/_shell/runs/$runId", shouldThrow: false }) !== undefined;
  return (
    <section className="side-sec">
      <h3 className="side-h">
        <span>Work</span>
      </h3>
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
    </section>
  );
}
