import { useState, type JSX } from "react";
import { useSuspenseInfiniteQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { parseWorkflowSourceWithRanges, resolveDisplayTimezone } from "@hercule/client-core";
import { agentsQuery, providersQuery, settingsQuery } from "../../../../app/queries";
import { buildGraphDrawing } from "../../../../screens/workflows/graph-model";
import { buildNodeDetails } from "../../../../screens/workflows/node-details";
import {
  buildTimelineAxis,
  computeTimelineDay,
  computeTimelineReadRange,
} from "../../../../screens/workflows/run-timeline";
import {
  RunsViewPicker,
  TimelineAxisRow,
  TimelineDayStepper,
  type RunsView,
} from "../../../../screens/workflows/run-timeline-board";
import {
  InputTable,
  InputTableHeads,
  RunTableHeads,
  TriggerTable,
  TriggerTableHeads,
  WorkflowLead,
  WorkflowSource,
  WorkflowTabBar,
  type WorkflowTab,
} from "../../../../screens/workflows/workflow-detail";
import {
  buildInputRows,
  buildTriggerRows,
  buildWorkflowChips,
} from "../../../../screens/workflows/workflow-detail-rows";
import { WorkflowGraph } from "../../../../screens/workflows/workflow-graph";
import {
  workflowActionsQuery,
  workflowQuery,
  workflowRunningRunsQuery,
  workflowRunsBetweenQuery,
  workflowRunsQuery,
  workflowTriggersQuery,
} from "../../../../screens/workflows/workflow-queries";
import { RunsPanel, RunsTimeline } from "./-runs";
import { useTriggerSwitches, useWorkflowSwitch } from "./-switches";

/**
 * The search params of an open workflow:
 *
 * - `full`: the workflow fills the main pane, and the list is hidden;
 * - `runsView`: the Runs tab shows its runs on a timeline; with none, in a
 *   list;
 * - `daysBack`: the day the timeline draws, as the number of days before
 *   today; with none, today.
 *
 * A param set to `undefined` is left out of the URL, which is how a
 * navigation drops it.
 */
export interface WorkflowSearch {
  readonly full?: boolean | undefined;
  readonly runsView?: "timeline" | undefined;
  readonly daysBack?: number | undefined;
}

/**
 * Returns an open workflow's search params from the URL's. A `daysBack`
 * that is not a whole number above 0 is dropped, so the screen never acts
 * on a malformed link.
 */
const validateWorkflowSearch = (search: Record<string, unknown>): WorkflowSearch => ({
  ...(search.full === true ? { full: true } : {}),
  ...(search.runsView === "timeline" ? { runsView: "timeline" } : {}),
  ...(typeof search.daysBack === "number" &&
  Number.isSafeInteger(search.daysBack) &&
  search.daysBack > 0
    ? { daysBack: search.daysBack }
    : {}),
});

/**
 * PROTOTYPE. One workflow, beside the list or filling the pane: its lead
 * with its switch, the graph of its steps, and its tabs. The graph shows
 * what the workflow does, not how a run went: a run's row, or its bar on
 * the timeline, opens the run's own page.
 *
 * The loader reads everything the page draws before it renders: the
 * workflow, its triggers, the first page of its runs, and the timeline's
 * day when the Runs tab shows one. Picking a day changes the URL, so the
 * loader reads it before the page shows it.
 */
export const Route = createFileRoute("/_connected/_shell/workflows/$workflowId")({
  codeSplitGroupings: [["loader", "component"]],
  validateSearch: validateWorkflowSearch,
  loaderDeps: ({ search }) => ({ runsView: search.runsView, daysBack: search.daysBack }),
  loader: async ({ context: { controller, queryClient }, params, deps }) => {
    const client = controller.client;
    const { workflowId } = params;
    const readTimeline = async (): Promise<void> => {
      if (deps.runsView !== "timeline") return;
      const settings = await queryClient.ensureQueryData(settingsQuery(client));
      const timezone = resolveDisplayTimezone(settings.user.timezone);
      const day = computeTimelineDay(new Date(), deps.daysBack ?? 0, timezone);
      const { since, until } = computeTimelineReadRange(day, timezone);
      await Promise.all([
        queryClient.ensureQueryData(workflowRunsBetweenQuery(client, workflowId, since, until)),
        queryClient.ensureQueryData(workflowRunningRunsQuery(client, workflowId)),
      ]);
    };
    await Promise.all([
      queryClient.ensureQueryData(workflowQuery(client, workflowId)),
      queryClient.ensureQueryData(workflowTriggersQuery(client, workflowId)),
      queryClient.ensureInfiniteQueryData(workflowRunsQuery(client, workflowId)),
      queryClient.ensureQueryData(agentsQuery(client)),
      queryClient.ensureQueryData(providersQuery(client)),
      queryClient.ensureQueryData(workflowActionsQuery(client)),
      queryClient.ensureQueryData(settingsQuery(client)),
      readTimeline(),
    ]);
  },
  component: WorkflowRoute,
});

/** Renders the open workflow's page, afresh for each workflow, so its tab starts at Runs. */
function WorkflowRoute(): JSX.Element {
  const { workflowId } = Route.useParams();
  return <WorkflowPage key={workflowId} workflowId={workflowId} />;
}

function WorkflowPage({ workflowId }: { readonly workflowId: string }): JSX.Element {
  const { controller } = Route.useRouteContext();
  const client = controller.client;
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const workflow = useSuspenseQuery(workflowQuery(client, workflowId)).data;
  const storedTriggers = useSuspenseQuery(workflowTriggersQuery(client, workflowId)).data;
  const settings = useSuspenseQuery(settingsQuery(client)).data;
  const runs = useSuspenseInfiniteQuery(workflowRunsQuery(client, workflowId)).data;
  const agents = useSuspenseQuery(agentsQuery(client)).data;
  const instances = useSuspenseQuery(providersQuery(client)).data;
  const actions = useSuspenseQuery(workflowActionsQuery(client)).data;
  const enabled = useWorkflowSwitch(client, workflow);
  const triggerSwitches = useTriggerSwitches(client, workflowId, storedTriggers);

  // Times are relative to when the page opened, as the list's are.
  const [openedAt] = useState(() => new Date());
  const [tab, setTab] = useState<WorkflowTab>("runs");

  // The YAML parser loads with this page, not with the first screen.
  const { definition } = parseWorkflowSourceWithRanges(workflow.source);
  if (definition === undefined) {
    throw new Error(`The stored source of the workflow ${workflowId} does not parse.`);
  }
  const { triggers } = triggerSwitches;
  const timezone = resolveDisplayTimezone(settings.user.timezone);
  const triggerRows = buildTriggerRows(definition, enabled.value, triggers, timezone, openedAt);
  const inputRows = buildInputRows(definition);
  const hasRuns = runs.pages[0]?.items[0] !== undefined;
  const runsView: RunsView = search.runsView ?? "list";
  const daysBack = search.daysBack ?? 0;
  const day = computeTimelineDay(openedAt, daysBack, timezone);
  const axis = buildTimelineAxis(day, timezone, openedAt);
  const drawing = buildGraphDrawing(definition, undefined, [], agents, actions);
  const records = {
    definition,
    run: undefined,
    sessions: [],
    triggers,
    agents,
    actions,
    instances,
  };

  const openSession = (sessionId: string): void => {
    void navigate({ to: "/threads/$sessionId", params: { sessionId } });
  };
  const openRun = (runId: string): void => {
    void navigate({ to: "/runs/$runId", params: { runId } });
  };

  // The view and the day are how the tab shows its runs, not places to go
  // back to, so changing them replaces the page's history entry.
  const pickRunsView = (view: RunsView): void => {
    void navigate({
      to: ".",
      search: (prev) => ({
        ...prev,
        runsView: view === "timeline" ? "timeline" : undefined,
        daysBack: undefined,
      }),
      replace: true,
    });
  };
  const showDay = (next: number): void => {
    void navigate({
      to: ".",
      search: (prev) => ({ ...prev, daysBack: next === 0 ? undefined : next }),
      replace: true,
    });
  };

  // A workflow with no runs has nothing to show either way, so the tab
  // offers no choice.
  const runsTools =
    tab !== "runs" || !hasRuns ? null : (
      <div className="wfd-tools">
        {runsView === "timeline" ? (
          <TimelineDayStepper
            dayText={axis.dayText}
            isToday={daysBack === 0}
            onStepBack={() => showDay(daysBack + 1)}
            onStepOn={() => showDay(daysBack - 1)}
            onShowToday={() => showDay(0)}
          />
        ) : null}
        <RunsViewPicker view={runsView} onPickView={pickRunsView} />
      </div>
    );

  const heads =
    tab === "runs" ? (
      !hasRuns ? null : runsView === "timeline" ? (
        <TimelineAxisRow axis={axis} />
      ) : (
        <RunTableHeads />
      )
    ) : tab === "triggers" ? (
      triggerRows.length === 0 ? null : (
        <TriggerTableHeads />
      )
    ) : tab === "inputs" ? (
      inputRows.length === 0 ? null : (
        <InputTableHeads />
      )
    ) : null;

  return (
    <section className="wf-open" aria-label={definition.name}>
      <div className="wfd">
        <div className="wfd-cap" />
        <WorkflowLead
          name={definition.name}
          description={definition.description}
          chips={buildWorkflowChips(definition, enabled.value, triggers, timezone, openedAt)}
          enabled={enabled.value}
          onToggleEnabled={() => enabled.save(!enabled.value)}
          error={enabled.error}
        />
        <div className="wfd-graph">
          <WorkflowGraph
            drawing={drawing}
            details={buildNodeDetails(drawing, records, timezone, openedAt)}
            label={`${definition.name}, its steps`}
            onOpenSession={openSession}
          />
        </div>
        <div className="wfd-band">
          <div className="wfd-bar">
            <WorkflowTabBar
              tab={tab}
              counts={{ triggers: triggerRows.length, inputs: inputRows.length }}
              onPickTab={setTab}
            />
            {runsTools}
          </div>
          {heads}
        </div>
        {tab === "runs" && runsView === "timeline" && hasRuns ? (
          <RunsTimeline
            // Each day's board is drawn afresh, so its bars arrive again.
            key={day.start.toISOString()}
            client={client}
            workflowId={workflowId}
            definition={definition}
            enabled={enabled.value}
            triggers={triggers}
            day={day}
            axis={axis}
            onOpenRun={openRun}
            timezone={timezone}
            now={openedAt}
          />
        ) : tab === "runs" ? (
          <RunsPanel
            client={client}
            workflowId={workflowId}
            definition={definition}
            onOpenRun={openRun}
            timezone={timezone}
            now={openedAt}
          />
        ) : tab === "triggers" ? (
          <TriggerTable
            rows={triggerRows}
            onToggleTrigger={triggerSwitches.toggle}
            error={triggerSwitches.error}
          />
        ) : tab === "inputs" ? (
          <InputTable rows={inputRows} />
        ) : (
          <WorkflowSource source={workflow.source} />
        )}
      </div>
    </section>
  );
}
