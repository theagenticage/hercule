import { useEffect, useRef, useState, type JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Outlet, createFileRoute, useMatch, useNavigate } from "@tanstack/react-router";
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
import {
  WorkflowColumnHeader,
  WorkflowListHeader,
  WorkflowSearchField,
} from "../../../../screens/workflows/workflow-list-header";
import { WorkflowTableHeads } from "../../../../screens/workflows/workflow-list-rows";

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

/** Returns true when `target`, the keyboard's focus, is a field, where keys edit text. */
const isTextField = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

/**
 * Keeps the workflow pages' reads current while the page is open, builds
 * the list's rows from them, and holds the filter and the search. It draws
 * the list at the width the route asks for, and the open workflow beside
 * it.
 *
 * While a workflow is open, Esc closes it, back to the table, unless
 * something else takes Esc first:
 *
 * - a step's card, or anything else that handles Esc and calls
 *   `preventDefault()`;
 * - an open dialog, or an open popover the browser closes on Esc (one with
 *   `popover="auto"`), which the browser closes without calling
 *   `preventDefault()`. A manual popover, such as the sidebar's hover card
 *   of a thread, does not close on Esc, so it does not take it;
 * - a focused text field, where Esc belongs to the field.
 *
 * Opening a workflow or closing it draws the list again at its new width,
 * which drops the keyboard's focus when it was in the list or the open
 * workflow. Focus then moves to the workflow's row in the list at its new
 * width, when that row is mounted.
 */
function WorkflowsLayout(): JSX.Element {
  const { controller, queryClient } = Route.useRouteContext();
  const { client } = controller;
  useWorkflowsLive(controller.live, queryClient);
  const [filter, setFilter] = useState<WorkflowListFilter>("all");
  const [search, setSearch] = useState("");
  const navigate = useNavigate();
  const openWorkflow = useMatch({ from: OPEN_WORKFLOW_ROUTE, shouldThrow: false });
  const width =
    openWorkflow === undefined ? "table" : openWorkflow.search.full === true ? "full" : "column";
  const isOpen = openWorkflow !== undefined;
  const openWorkflowId = openWorkflow?.params.workflowId;

  // The width the list was drawn at, and the workflow open last, so that its
  // row takes focus after the list is drawn at a new width.
  const lastWidth = useRef(width);
  const lastOpenWorkflowId = useRef(openWorkflowId);
  useEffect(() => {
    const workflowId = openWorkflowId ?? lastOpenWorkflowId.current;
    const isNewWidth = width !== lastWidth.current;
    lastWidth.current = width;
    lastOpenWorkflowId.current = workflowId;
    // Focus that the new width did not drop stays where it is, and a list
    // hidden behind a full open workflow has no row to focus.
    if (
      !isNewWidth ||
      width === "full" ||
      workflowId === undefined ||
      document.activeElement !== document.body
    ) {
      return;
    }
    const list = document.querySelector(".workflow-list");
    if (list === null) return;
    // Returns false while the list has drawn no row yet. A list at a new
    // width draws its rows only after it has measured itself, a render after
    // this effect runs, so the row is looked for again as the list changes.
    // When the open workflow's row is not among the rows drawn, the focus
    // stays where it is.
    const focusRow = (): boolean => {
      if (list.querySelector("[data-key]") === null) return false;
      if (document.activeElement === document.body) {
        // A workflow id is a UUID, which needs no escaping in a selector.
        list.querySelector<HTMLElement>(`[data-key="workflow:${workflowId}"]`)?.focus();
      }
      return true;
    };
    if (focusRow()) return;
    const observer = new MutationObserver(() => {
      if (focusRow()) observer.disconnect();
    });
    observer.observe(list, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [width, openWorkflowId]);

  useEffect(() => {
    if (!isOpen) return;
    const closeWorkflow = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (isTextField(event.target)) return;
      if (document.querySelector('dialog[open], [popover="auto"]:popover-open') !== null) return;
      void navigate({ to: "/workflows" });
    };
    window.addEventListener("keydown", closeWorkflow);
    return () => window.removeEventListener("keydown", closeWorkflow);
  }, [isOpen, navigate]);

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
          // The spec does not say whether hiding the list replaces the
          // history entry, so it pushes one, and Back shows the list again.
          // `runsView` and `daysBack` are kept.
          onToggleList={() =>
            void navigate({
              to: "/workflows/$workflowId",
              params: openWorkflow.params,
              search: (previous) => {
                const kept = { ...previous };
                delete kept.full;
                return width === "column" ? { ...kept, full: true } : kept;
              },
            })
          }
        />
      )}
      {/* Keyed by the width, because every item's height changes with it. */}
      {width === "full" ? null : (
        <WorkflowList
          key={width}
          width={width}
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
