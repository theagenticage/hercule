import { useEffect, useRef, useState, type JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet, useMatch } from "@tanstack/react-router";
import { resolveDisplayTimezone } from "@hercule/client-core";
import { settingsQuery } from "../../../../app/queries";
import { WorkflowList } from "../../../../screens/workflows/workflow-list";
import {
  WorkflowColumnTop,
  WorkflowSearchField,
  WorkflowTableTop,
} from "../../../../screens/workflows/workflow-list-header";
import { WorkflowTableHeads } from "../../../../screens/workflows/workflow-list-rows";
import {
  triggersQuery,
  waitingRunSessionsQuery,
  workflowListQuery,
} from "../../../../screens/workflows/workflow-queries";
import {
  buildWorkflowListItems,
  buildWorkflowRows,
  countWorkflowsByFilter,
  type WorkflowListFilter,
} from "../../../../screens/workflows/workflow-rows";
import { WorkflowsFrame, type WorkflowsView } from "../../../../screens/workflows/workflows-frame";

/**
 * PROTOTYPE. Workflows: the layout route of the workflow list and the open
 * workflow. The list is one list at three widths: a table while no workflow
 * is open, a column beside the open one, and hidden while the open one
 * fills the pane (`full`).
 *
 * The filter and the search belong to this route, so they stay as they are
 * when a workflow opens or closes. So does the floating header, which this
 * route draws over every width. The loader reads everything the list
 * draws; three of those reads need a contract addition, so outside a
 * specimen the page fails to load (see workflow-queries.ts).
 */
export const Route = createFileRoute("/_connected/_shell/workflows")({
  staticData: { title: "Workflows" },
  loader: async ({ context: { controller, queryClient } }) => {
    await Promise.all([
      queryClient.ensureQueryData(workflowListQuery()),
      queryClient.ensureQueryData(triggersQuery(controller.client)),
      queryClient.ensureQueryData(waitingRunSessionsQuery()),
      queryClient.ensureQueryData(settingsQuery(controller.client)),
    ]);
  },
  component: WorkflowsLayout,
});

function WorkflowsLayout(): JSX.Element {
  const { controller } = Route.useRouteContext();
  const workflows = useSuspenseQuery(workflowListQuery()).data;
  const triggers = useSuspenseQuery(triggersQuery(controller.client)).data;
  const waitingSessions = useSuspenseQuery(waitingRunSessionsQuery()).data;
  const settings = useSuspenseQuery(settingsQuery(controller.client)).data;
  const open = useMatch({ from: "/_connected/_shell/workflows/$workflowId", shouldThrow: false });
  const navigate = Route.useNavigate();
  const view: WorkflowsView =
    open === undefined ? "table" : open.search.full === true ? "full" : "column";

  // The rows' times are relative to when the page opened. The Workflows
  // ticket draws them from the age clock instead (app/age-clock.ts), so
  // "10:31" becomes "Wed" at midnight.
  const [openedAt] = useState(() => new Date());
  const [filter, setFilter] = useState<WorkflowListFilter>("all");
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  const rows = buildWorkflowRows(
    workflows,
    triggers,
    waitingSessions,
    resolveDisplayTimezone(settings.user.timezone),
    openedAt,
  );
  const items = buildWorkflowListItems(rows, filter, search);
  const emptyText = workflows.length === 0 ? "No workflows yet" : "No workflows match";

  // ⌘F focuses the search field, as in every Mac app's list.
  useEffect(() => {
    const focusSearch = (event: KeyboardEvent): void => {
      if (!event.metaKey || event.shiftKey || event.altKey || event.ctrlKey) return;
      if (event.key !== "f" || searchRef.current === null) return;
      event.preventDefault();
      searchRef.current.focus();
      searchRef.current.select();
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  // Esc closes the open workflow, and the list takes the pane again. A key
  // typed into a field is the field's: Esc there clears or leaves it. An open
  // card over a node of the graph closes itself on Esc, and the workflow
  // stays open.
  const isOpen = view !== "table";
  useEffect(() => {
    if (!isOpen) return;
    const closeWorkflow = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (event.target instanceof HTMLElement && event.target.closest("input, textarea")) return;
      if (document.querySelector(":popover-open") !== null) return;
      void navigate({ to: "/workflows" });
    };
    window.addEventListener("keydown", closeWorkflow);
    return () => window.removeEventListener("keydown", closeWorkflow);
  }, [isOpen, navigate]);

  // The toggle names the open workflow's route outright: "." would resolve
  // against this layout route, `/workflows`, and close the workflow.
  const header =
    open === undefined ? (
      <WorkflowTableTop
        filter={filter}
        counts={countWorkflowsByFilter(rows)}
        onPickFilter={setFilter}
        search={search}
        onSearch={setSearch}
        searchRef={searchRef}
      />
    ) : (
      <WorkflowColumnTop
        filter={filter}
        count={items.filter((item) => item.kind === "workflow-row").length}
        isListShown={view === "column"}
        onToggleList={() =>
          void navigate({
            to: "/workflows/$workflowId",
            params: open.params,
            search: { ...open.search, full: view === "column" ? true : undefined },
          })
        }
      />
    );

  const list =
    view === "table" ? (
      <WorkflowList
        items={items}
        layout="table"
        head={<WorkflowTableHeads />}
        emptyText={emptyText}
      />
    ) : (
      <WorkflowList
        items={items}
        layout="column"
        head={<WorkflowSearchField search={search} onSearch={setSearch} searchRef={searchRef} />}
        emptyText={emptyText}
      />
    );

  return (
    <WorkflowsFrame view={view} header={header} list={list}>
      <Outlet />
    </WorkflowsFrame>
  );
}
