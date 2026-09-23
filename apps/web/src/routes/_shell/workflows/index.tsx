import type { JSX } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { ageOf } from "@hercule/client-core";
import { EmptyState, buttonClassName, useMinuteClock } from "@hercule/ui";
import { useLiveInvalidation } from "../../../app/live-invalidation";
import { workflowsQuery } from "../../../app/queries";
import { WorkflowRow } from "./-row";

export const Route = createFileRoute("/_shell/workflows/")({
  staticData: { title: "Workflows" },
  // Answered before it is shown, so the screen never renders as a frame
  // around nothing and never grows rows under the reader a moment later.
  loader: ({ context }) => context.queryClient.ensureQueryData(workflowsQuery(context.client)),
  component: Workflows,
});

/** The way to write a workflow. It is a link, because it opens a page of its own. */
function NewWorkflowLink(): JSX.Element {
  return (
    <Link to="/workflows/new" className={buttonClassName("form", "self-start")}>
      New workflow
    </Link>
  );
}

/**
 * Every workflow, in the order the controller lists them, each with the
 * switch that turns its triggers on or off.
 */
function Workflows(): JSX.Element {
  const { client, queryClient, live } = Route.useRouteContext();

  useLiveInvalidation(live, queryClient, "workflow");

  const workflows = useSuspenseQuery(workflowsQuery(client)).data.items;
  // Ages read the clock, not the last invalidation, so an age moves on by
  // itself as a thread row's does.
  const now = useMinuteClock();

  if (workflows.length === 0) {
    return (
      <EmptyState
        headline="No workflows yet."
        lead="A workflow is written as YAML: what starts it, the steps it runs, and where they run. Its triggers make it standing work."
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
            age={ageOf(workflow.updatedAt, now)}
          />
        ))}
      </ul>
    </div>
  );
}
