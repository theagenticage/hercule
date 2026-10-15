import { useState, type JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Outlet, createFileRoute, useMatch, useNavigate } from "@tanstack/react-router";
import { resolveDisplayTimezone } from "@hercule/client-core";
import {
  buildWorkflowListItems,
  buildWorkflowRows,
  countWorkflowsByFilter,
  type WorkflowListFilter,
} from "@hercule/client-core/workflow-rows";
import { useScreenTopicsLive, WORKFLOW_TOPICS } from "../../../../app/live";
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
import {
  WorkflowColumnHeader,
  WorkflowListHeader,
  WorkflowSearchField,
} from "../../../../screens/workflows/workflow-list-header";
import { WorkflowTableHeads } from "../../../../screens/workflows/workflow-list-rows";
import {
  computeListPaneWidth,
  useCloseOnEscape,
  useLastOpenItemId,
  useRestoreRowFocus,
  useToggleListPane,
} from "../../../../screens/list-pane/list-with-open-pane";

/**
 * Workflows: the workflow list and the open workflow (spec 17 §Workflows).
 * It is the layout route of the workflow pages, so the list keeps its filter
 * and search while workflows open and close under it (`$workflowId.tsx`).
 * The list is one list at three widths:
 *
 * - the table, while no workflow is open, with the filters and the search in
 *   the floating header;
 * - a column beside the open workflow, with the search at its top;
 * - hidden, while the open workflow fills the pane (`full`).
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

/** The open workflow's route, whose search holds `full`. */
const OPEN_WORKFLOW_ROUTE = "/_connected/_shell/workflows/$workflowId";

/** Returns the row of the workflow `workflowId` in `list`, or `null` when it is not drawn. */
const findWorkflowRow = (list: Element, workflowId: string): HTMLElement | null =>
  // A workflow id is a UUID, which needs no escaping in a selector.
  list.querySelector<HTMLElement>(`[data-key="workflow:${workflowId}"]`);

/**
 * Keeps the workflow pages' reads current while the page is open, builds
 * the list's rows from them, and holds the filter and the search. It draws
 * the list at the width the route asks for, and the open workflow beside
 * it.
 *
 * While a workflow is open, Esc closes it, back to the table, unless
 * something else takes Esc first, such as a step's card
 * (`useCloseOnEscape`). After the list is drawn at a new width, focus moves
 * to the workflow's row (`useRestoreRowFocus`).
 */
function WorkflowsLayout(): JSX.Element {
  const { controller, queryClient } = Route.useRouteContext();
  const { client } = controller;
  useScreenTopicsLive(controller.live, queryClient, WORKFLOW_TOPICS);
  const [filter, setFilter] = useState<WorkflowListFilter>("all");
  const [search, setSearch] = useState("");
  const navigate = useNavigate();
  const openWorkflow = useMatch({ from: OPEN_WORKFLOW_ROUTE, shouldThrow: false });
  const width = computeListPaneWidth(openWorkflow);
  // The spec does not say whether hiding the list replaces the history
  // entry, so it pushes one, and Back shows the list again. `runsView` and
  // `daysBack` are kept.
  const toggleList = useToggleListPane(openWorkflow, width);
  const initialWorkflowId = useLastOpenItemId(openWorkflow?.params.workflowId);

  useRestoreRowFocus(width, initialWorkflowId, findWorkflowRow);
  useCloseOnEscape(openWorkflow !== undefined, () => void navigate({ to: "/workflows" }));

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
  const counts = countWorkflowsByFilter(rows);
  const items = buildWorkflowListItems(rows, filter, search);
  const timezone = resolveDisplayTimezone(settings.user.timezone);

  return (
    <div className="workflows-page">
      {openWorkflow === undefined ? (
        <WorkflowListHeader
          filter={filter}
          counts={counts}
          search={search}
          onFilterChange={setFilter}
          onSearchChange={setSearch}
        />
      ) : (
        <WorkflowColumnHeader
          filter={filter}
          counts={counts}
          isListShown={width === "column"}
          onToggleList={toggleList}
        />
      )}
      {/* Keyed by the width, because every item's height changes with it. */}
      {width === "full" ? null : (
        <WorkflowList
          key={width}
          width={width}
          initialItemId={initialWorkflowId}
          items={items}
          hasWorkflows={workflows.length > 0}
          timezone={timezone}
          head={
            width === "table" ? (
              <WorkflowTableHeads />
            ) : (
              <WorkflowSearchField search={search} onSearchChange={setSearch} isBoxed />
            )
          }
        />
      )}
      <Outlet />
    </div>
  );
}
