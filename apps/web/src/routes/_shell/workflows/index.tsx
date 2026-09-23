import type { JSX } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { formatAge } from "@hercule/client-core";
import { EmptyState, buildButtonClassName, useMinuteClock } from "@hercule/ui";
import { useLiveInvalidation } from "../../../app/live-invalidation";
import { workflowsQuery } from "../../../app/queries";
import { WorkflowRow } from "./-row";

export const Route = createFileRoute("/_shell/workflows/")({
  staticData: { title: "Workflows" },
  // Loads the list before rendering, so the screen never shows an empty
  // frame and then shifts when the rows arrive.
  loader: ({ context }) => context.queryClient.ensureQueryData(workflowsQuery(context.client)),
  component: Workflows,
});

/** Renders the New workflow button. It is a link, because it opens a page of its own. */
function NewWorkflowLink(): JSX.Element {
  return (
    <Link to="/workflows/new" className={buildButtonClassName("form", "self-start")}>
      New workflow
    </Link>
  );
}

/**
 * Renders the workflows in the order the controller returns them, or an
 * empty state when there are none.
 */
function Workflows(): JSX.Element {
  const { client, queryClient, live } = Route.useRouteContext();

  useLiveInvalidation(live, queryClient, "workflow");

  const workflows = useSuspenseQuery(workflowsQuery(client)).data.items;
  // Ages come from a clock that ticks every minute, not from the last
  // refetch, so they stay current, like the ages on thread rows.
  const now = useMinuteClock();

  if (workflows.length === 0) {
    return (
      <EmptyState
        headline="No workflows yet."
        lead="A workflow is written in YAML: what starts it, the steps it runs, and where they run. Its triggers start it automatically."
      >
        <NewWorkflowLink />
      </EmptyState>
    );
  }

  return (
    <div className="flex max-w-[940px] flex-col gap-4">
      <NewWorkflowLink />
      <ul className="flex flex-col rounded-card border border-line-soft bg-surface px-1.5 py-1">
        {workflows.map((workflow) => (
          <WorkflowRow
            key={workflow.id}
            client={client}
            workflow={workflow}
            age={formatAge(workflow.updatedAt, now)}
          />
        ))}
      </ul>
    </div>
  );
}
