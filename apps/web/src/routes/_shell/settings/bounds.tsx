import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { buildSpawnBoundRows } from "@hercule/client-core";
import { EmptyState } from "@hercule/ui";
import { useLiveInvalidation } from "../../../app/live-invalidation";
import { startTriggersQuery, workflowsQuery } from "../../../app/queries";
import { BoundTable } from "./-bound-table";
import { DefaultBound } from "./-default-bound";

export const Route = createFileRoute("/_shell/settings/bounds")({
  staticData: { title: "Bounds" },
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(startTriggersQuery(context.client)),
      context.queryClient.ensureQueryData(workflowsQuery(context.client)),
    ]);
  },
  component: Bounds,
});

/**
 * Renders the Bounds screen: the default spawn bound, and every start trigger
 * with the bound it runs under, how much of its window it used, what lets it
 * start runs or stops it, and how many held events it holds.
 *
 * A `workflow` push refetches both lists while the screen is open: a saved
 * source can change a trigger or its bound, a trigger is paused or resumed on
 * its workflow, and a workflow can be disabled or stop validating. Runs are
 * pushed on another topic, which refetches neither list, so the triggers'
 * query refetches the window counts every minute on its own.
 */
function Bounds(): JSX.Element {
  const { client, queryClient, live } = Route.useRouteContext();
  useLiveInvalidation(live, queryClient, "workflow");
  const triggers = useSuspenseQuery(startTriggersQuery(client)).data;
  const workflows = useSuspenseQuery(workflowsQuery(client)).data;
  const rows = buildSpawnBoundRows(triggers, workflows);

  return (
    <div className="flex flex-col gap-7">
      <DefaultBound client={client} />
      {rows.length === 0 ? (
        <EmptyState
          className="mt-0"
          headline="No trigger has a bound to show yet."
          lead="A spawn bound caps how often a trigger may start runs. Every start trigger is listed here with its bound, its current window, and whether it is paused."
        />
      ) : (
        <BoundTable client={client} rows={rows} />
      )}
    </div>
  );
}
