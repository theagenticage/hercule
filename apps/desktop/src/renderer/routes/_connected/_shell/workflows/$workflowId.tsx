import { useRef, useState, type JSX } from "react";
import { useSuspenseInfiniteQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { resolveDisplayTimezone } from "@hercule/client-core";
import { isId, type Trigger, type WorkflowDefinition } from "@hercule/contract";
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
  DrawnRunHeading,
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
  buildRunRow,
  buildTriggerRows,
  buildWorkflowChips,
} from "../../../../screens/workflows/workflow-detail-rows";
import { WorkflowGraph } from "../../../../screens/workflows/workflow-graph";
import {
  runQuery,
  runSessionsQuery,
  triggersQuery,
  workflowActionsQuery,
  workflowQuery,
  workflowRunningRunsQuery,
  workflowRunsBetweenQuery,
  workflowRunsQuery,
} from "../../../../screens/workflows/workflow-queries";
import { RunsPanel, RunsTimeline } from "./-runs";

/**
 * The search params of an open workflow:
 *
 * - `run`: the run drawn on the graph; with none, the graph shows the
 *   workflow's latest run;
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
  readonly run?: string | undefined;
  readonly full?: boolean | undefined;
  readonly runsView?: "timeline" | undefined;
  readonly daysBack?: number | undefined;
}

/**
 * Returns an open workflow's search params from the URL's. A `run` that is
 * not an id, and a `daysBack` that is not a whole number above 0, are
 * dropped, so the screen never acts on a malformed link.
 */
const validateWorkflowSearch = (search: Record<string, unknown>): WorkflowSearch => ({
  ...(isId(search.run) ? { run: search.run } : {}),
  ...(search.full === true ? { full: true } : {}),
  ...(search.runsView === "timeline" ? { runsView: "timeline" } : {}),
  ...(typeof search.daysBack === "number" &&
  Number.isSafeInteger(search.daysBack) &&
  search.daysBack > 0
    ? { daysBack: search.daysBack }
    : {}),
});

/**
 * PROTOTYPE. One workflow, beside the list or filling the pane: its lead,
 * the graph with one of its runs drawn on it, and its tabs.
 *
 * The loader reads everything the page draws before it renders, in two
 * steps: the workflow, the first page of its runs, and the timeline's day
 * when the Runs tab shows one, then the run the graph draws, which is the
 * latest unless the URL picks one. Picking a run or a day changes the URL,
 * so the loader reads what it draws before the page shows it.
 */
export const Route = createFileRoute("/_connected/_shell/workflows/$workflowId")({
  validateSearch: validateWorkflowSearch,
  loaderDeps: ({ search }) => ({
    run: search.run,
    runsView: search.runsView,
    daysBack: search.daysBack,
  }),
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
    const [, runs] = await Promise.all([
      queryClient.ensureQueryData(workflowQuery(workflowId)),
      queryClient.ensureInfiniteQueryData(workflowRunsQuery(client, workflowId)),
      queryClient.ensureQueryData(agentsQuery(client)),
      queryClient.ensureQueryData(providersQuery(client)),
      queryClient.ensureQueryData(workflowActionsQuery(client)),
      readTimeline(),
    ]);
    const drawnRunId = deps.run ?? runs.pages[0]?.items[0]?.id;
    if (drawnRunId === undefined) return;
    await Promise.all([
      queryClient.ensureQueryData(runQuery(client, drawnRunId)),
      queryClient.ensureQueryData(runSessionsQuery(client, drawnRunId)),
    ]);
  },
  component: WorkflowRoute,
});

/** Renders the open workflow's page, afresh for each workflow, so its tab starts at Runs. */
function WorkflowRoute(): JSX.Element {
  const { workflowId } = Route.useParams();
  return <WorkflowPage key={workflowId} workflowId={workflowId} />;
}

/** The room the sticky pill cap takes at the top of the page, `.wfd-cap` in workflow-detail.css. */
const CAP_HEIGHT = 56;

function WorkflowPage({ workflowId }: { readonly workflowId: string }): JSX.Element {
  const { controller } = Route.useRouteContext();
  const client = controller.client;
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const workflow = useSuspenseQuery(workflowQuery(workflowId)).data;
  const allTriggers = useSuspenseQuery(triggersQuery(client)).data;
  const settings = useSuspenseQuery(settingsQuery(client)).data;
  const runs = useSuspenseInfiniteQuery(workflowRunsQuery(client, workflowId)).data;

  // Times are relative to when the page opened, as the list's are.
  const [openedAt] = useState(() => new Date());
  const [tab, setTab] = useState<WorkflowTab>("runs");
  const drawnRef = useRef<HTMLDivElement>(null);

  const { definition } = workflow;
  const timezone = resolveDisplayTimezone(settings.user.timezone);
  const triggers = allTriggers.filter((trigger) => trigger.workflowId === workflowId);
  const triggerRows = buildTriggerRows(definition, workflow.enabled, triggers, timezone, openedAt);
  const inputRows = buildInputRows(definition);
  const latestRunId = runs.pages[0]?.items[0]?.id;
  const drawnRunId = search.run ?? latestRunId;
  const runsView: RunsView = search.runsView ?? "list";
  const daysBack = search.daysBack ?? 0;
  const day = computeTimelineDay(openedAt, daysBack, timezone);
  const axis = buildTimelineAxis(day, timezone, openedAt);

  const openSession = (sessionId: string): void => {
    void navigate({ to: "/threads/$sessionId", params: { sessionId } });
  };

  // Picking the latest run follows the latest, so a run that starts later
  // takes its place on the graph. The graph scrolls into view, because a
  // run picked far down the table would otherwise change nothing in sight.
  const pickRun = (runId: string): void => {
    void navigate({
      to: ".",
      search: (prev) => ({ ...prev, run: runId === latestRunId ? undefined : runId }),
    });
    const reducesMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    drawnRef.current?.scrollIntoView({
      block: "nearest",
      behavior: reducesMotion ? "instant" : "smooth",
    });
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
    tab !== "runs" || latestRunId === undefined ? null : (
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
      latestRunId === undefined ? null : runsView === "timeline" ? (
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
          chips={buildWorkflowChips(definition, workflow.enabled, triggers, timezone, openedAt)}
        />
        <div ref={drawnRef} className="wfd-run" style={{ scrollMarginTop: CAP_HEIGHT }}>
          {drawnRunId === undefined ? (
            <WorkflowWithoutRun
              definition={definition}
              triggers={triggers}
              onOpenSession={openSession}
              timezone={timezone}
              now={openedAt}
            />
          ) : (
            <DrawnRun
              definition={definition}
              runId={drawnRunId}
              isLatest={drawnRunId === latestRunId}
              onShowLatest={() =>
                void navigate({ to: ".", search: (prev) => ({ ...prev, run: undefined }) })
              }
              triggers={triggers}
              onOpenSession={openSession}
              timezone={timezone}
              now={openedAt}
            />
          )}
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
        {tab === "runs" && runsView === "timeline" && latestRunId !== undefined ? (
          <RunsTimeline
            // Each day's board is drawn afresh, so its bars arrive again.
            key={day.start.toISOString()}
            client={client}
            workflowId={workflowId}
            definition={definition}
            enabled={workflow.enabled}
            triggers={triggers}
            day={day}
            axis={axis}
            drawnRunId={drawnRunId}
            onPickRun={pickRun}
            timezone={timezone}
            now={openedAt}
          />
        ) : tab === "runs" ? (
          <RunsPanel
            client={client}
            workflowId={workflowId}
            definition={definition}
            drawnRunId={drawnRunId}
            onPickRun={pickRun}
            timezone={timezone}
            now={openedAt}
          />
        ) : tab === "triggers" ? (
          <TriggerTable rows={triggerRows} />
        ) : tab === "inputs" ? (
          <InputTable rows={inputRows} />
        ) : (
          <WorkflowSource source={workflow.source} />
        )}
      </div>
    </section>
  );
}

/**
 * Draws the graph of a workflow that has never run, with its heading. A
 * node's card shows what the definition and the workflow's `triggers` say.
 */
function WorkflowWithoutRun({
  definition,
  triggers,
  onOpenSession,
  timezone,
  now,
}: {
  readonly definition: WorkflowDefinition;
  readonly triggers: ReadonlyArray<Trigger>;
  readonly onOpenSession: (sessionId: string) => void;
  readonly timezone: string;
  readonly now: Date;
}): JSX.Element {
  const { controller } = Route.useRouteContext();
  const agents = useSuspenseQuery(agentsQuery(controller.client)).data;
  const instances = useSuspenseQuery(providersQuery(controller.client)).data;
  const actions = useSuspenseQuery(workflowActionsQuery(controller.client)).data;
  const drawing = buildGraphDrawing(definition, undefined, [], agents, actions);
  const records = { definition, run: undefined, sessions: [], triggers, agents, instances };
  return (
    <>
      <DrawnRunHeading run={undefined} isLatest onShowLatest={() => undefined} />
      <div className="wfd-graph">
        <WorkflowGraph
          drawing={drawing}
          details={buildNodeDetails(drawing, records, timezone, now)}
          label={`${definition.name}, its steps`}
          onOpenSession={onOpenSession}
        />
      </div>
    </>
  );
}

/**
 * Draws the graph with the run `runId` on it, under a heading that names the
 * run. The run's sessions say which step waits on the user, and fill each
 * agent step's card with what its sessions used.
 */
function DrawnRun({
  definition,
  runId,
  isLatest,
  onShowLatest,
  triggers,
  onOpenSession,
  timezone,
  now,
}: {
  readonly definition: WorkflowDefinition;
  readonly runId: string;
  readonly isLatest: boolean;
  readonly onShowLatest: () => void;
  readonly triggers: ReadonlyArray<Trigger>;
  readonly onOpenSession: (sessionId: string) => void;
  readonly timezone: string;
  readonly now: Date;
}): JSX.Element {
  const { controller } = Route.useRouteContext();
  const client = controller.client;
  const run = useSuspenseQuery(runQuery(client, runId)).data;
  const sessions = useSuspenseQuery(runSessionsQuery(client, runId)).data;
  const agents = useSuspenseQuery(agentsQuery(client)).data;
  const instances = useSuspenseQuery(providersQuery(client)).data;
  const actions = useSuspenseQuery(workflowActionsQuery(client)).data;
  const row = buildRunRow(run, definition, sessions, timezone, now);
  const drawing = buildGraphDrawing(definition, run, sessions, agents, actions);
  const records = { definition, run, sessions, triggers, agents, instances };
  return (
    <>
      <DrawnRunHeading run={row} isLatest={isLatest} onShowLatest={onShowLatest} />
      <div className="wfd-graph">
        <WorkflowGraph
          drawing={drawing}
          details={buildNodeDetails(drawing, records, timezone, now)}
          label={`${definition.name}, ${isLatest ? "its latest run" : "a run"}: ${row.status.text}`}
          onOpenSession={onOpenSession}
        />
      </div>
    </>
  );
}
