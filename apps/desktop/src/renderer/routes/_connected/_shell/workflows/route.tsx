import { useState, type JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Outlet, createFileRoute } from "@tanstack/react-router";
import { resolveDisplayTimezone } from "@hercule/client-core";
import {
  buildWorkflowListItems,
  buildWorkflowRows,
  countWorkflowsByFilter,
  type WorkflowListFilter,
} from "@hercule/client-core/workflow-rows";
import { useWorkflowsLive } from "../../../../app/live";
import {
  liveRunsQuery,
  newestRunsQuery,
  readOnOpen,
  settingsQuery,
  triggersQuery,
  workflowsQuery,
} from "../../../../app/queries";
import { useWaitingRunSessions } from "../../../../app/waiting";
import { WorkflowList } from "../../../../screens/workflows/workflow-list";
import { WorkflowListHeader } from "../../../../screens/workflows/workflow-list-header";

/**
 * Workflows: the workflow list, as a table with its filters and search in
 * the floating header (spec 17 §Workflows). It is the layout route of the
 * workflow pages, so the list stays mounted, with its filter and search,
 * while a workflow opens under it (`$workflowId.tsx`).
 *
 * The route is split into a chunk of its own, so the list's code loads the
 * first time it opens. Its loader reads everything the list draws before it
 * renders, so nothing on the page waits:
 *
 * - the workflows, every trigger, the live runs, and every workflow's
 *   newest runs for its strip, which the `workflow` and `run` topics keep
 *   current while the page is open;
 * - the settings, for the time zone the times are shown in, read each time
 *   the page opens because no topic covers them.
 *
 * The sessions of runs that wait on the user, which put a workflow in Needs
 * you, come from a shell read and are already cached.
 *
 * Opening a workflow runs the loader again with `cause` "stay". It then
 * reads nothing that is cached, so clicking a row sends no request.
 */
export const Route = createFileRoute("/_connected/_shell/workflows")({
  staticData: { title: "Workflows" },
  loader: async ({ context: { controller, queryClient }, cause }) => {
    const { client } = controller;
    await Promise.all([
      queryClient.ensureQueryData(workflowsQuery(client)),
      queryClient.ensureQueryData(triggersQuery(client)),
      queryClient.ensureQueryData(newestRunsQuery(client)),
      queryClient.ensureQueryData(liveRunsQuery(client, "running")),
      queryClient.ensureQueryData(liveRunsQuery(client, "pending")),
      cause === "stay"
        ? queryClient.ensureQueryData(settingsQuery(client))
        : readOnOpen(queryClient, settingsQuery(client)),
    ]);
  },
  component: WorkflowsLayout,
});

/**
 * Keeps the workflow pages' reads current while the page is open, builds
 * the list's rows from them, and holds the filter and the search.
 */
function WorkflowsLayout(): JSX.Element {
  const { controller, queryClient } = Route.useRouteContext();
  const { client } = controller;
  useWorkflowsLive(controller.live, queryClient);
  const [filter, setFilter] = useState<WorkflowListFilter>("all");
  const [search, setSearch] = useState("");

  const { data: workflows } = useSuspenseQuery(workflowsQuery(client));
  const { data: triggers } = useSuspenseQuery(triggersQuery(client));
  const { data: running } = useSuspenseQuery(liveRunsQuery(client, "running"));
  const { data: pending } = useSuspenseQuery(liveRunsQuery(client, "pending"));
  const waitingRunSessions = useWaitingRunSessions();
  const { data: settings } = useSuspenseQuery(settingsQuery(client));
  const { data: newestRuns } = useSuspenseQuery(newestRunsQuery(client));
  const rows = buildWorkflowRows({
    workflows,
    triggers,
    newestRuns,
    liveRuns: [...running, ...pending],
    waitingRunSessions,
  });

  return (
    <div className="workflows-page">
      <WorkflowListHeader
        filter={filter}
        counts={countWorkflowsByFilter(rows)}
        search={search}
        onFilterChange={setFilter}
        onSearchChange={setSearch}
      />
      <WorkflowList
        items={buildWorkflowListItems(rows, filter, search)}
        hasWorkflows={workflows.length > 0}
        timezone={resolveDisplayTimezone(settings.user.timezone)}
      />
      <Outlet />
    </div>
  );
}
