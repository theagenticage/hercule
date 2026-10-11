import { Suspense, useId, useState, type JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import {
  isNotFound,
  parseWorkflowSourceWithRanges,
  resolveDisplayTimezone,
} from "@hercule/client-core";
import { buildGraphDrawing } from "@hercule/client-core/graph-model";
import { buildNodeCard } from "@hercule/client-core/node-details";
import { buildTimelineHours, computeTimelineDay } from "@hercule/client-core/run-timeline";
import {
  buildInputRows,
  buildTriggerRows,
  buildWorkflowChips,
} from "@hercule/client-core/workflow-detail-rows";
import { throwScreenNotFound } from "../../../../app/last-screen";
import {
  agentsQuery,
  providersQuery,
  readOnOpen,
  settingsQuery,
  triggersQuery,
  workflowActionsQuery,
  workflowDayRunsQuery,
  workflowQuery,
  workflowRunsQuery,
} from "../../../../app/queries";
import { NotFound } from "../../../../screens/not-found";
import {
  RunsViewPicker,
  TimelineAxis,
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
  WorkflowTabBar,
  buildTabElementId,
  type WorkflowTab,
} from "../../../../screens/workflows/workflow-detail";
import { WorkflowGraph } from "../../../../screens/workflows/workflow-graph";
import { RunDayLanes, RunList, useShownDay, useTimelineNow } from "./-runs";
import { useTriggerSwitches, useWorkflowSwitch } from "./-switches";

/**
 * The search params of an open workflow (spec 17 §Workflows, "The routes"):
 *
 * - `full`: the open workflow fills the pane, and the list is hidden;
 * - `runsView`: the Runs tab shows its runs on a timeline; without it, as a
 *   list;
 * - `daysBack`: the day the timeline shows, counted back from today; without
 *   it, today.
 */
export interface WorkflowSearch {
  readonly full?: true;
  readonly runsView?: "timeline";
  readonly daysBack?: number;
}

/**
 * Returns an open workflow's search params from the URL's. A param with any
 * other value is dropped, so the page shows its default: a `full` that is
 * not `true`, a `runsView` that is not `timeline`, and a `daysBack` that is
 * not a whole number above 0.
 */
const validateWorkflowSearch = (search: Record<string, unknown>): WorkflowSearch => ({
  ...(search.full === true ? { full: true } : {}),
  ...(search.runsView === "timeline" ? { runsView: "timeline" } : {}),
  ...(Number.isSafeInteger(search.daysBack) && (search.daysBack as number) > 0
    ? { daysBack: search.daysBack as number }
    : {}),
});

/**
 * An open workflow (spec 17 §Workflows, "The open workflow"). A row of the
 * workflow list links here, and its row is selected while the workflow is
 * open.
 *
 * Its loader reads everything the page draws before it renders:
 *
 * - the workflow, whose source is parsed here to draw the lead, the graph
 *   and the tabs; when no workflow has the id, the route shows
 *   `WorkflowNotFound`;
 * - the Agents and the workflow actions, which name the graph's steps, read
 *   each time the page opens because no topic covers them;
 * - the Runs tab's first page of runs, or the day its timeline shows.
 *
 * The triggers, the settings and the provider instances are read by the
 * Workflows layout and the shell, and are cached already. Stepping the day
 * or switching the view runs the loader again, with `cause` "stay", and
 * reads only the runs it has not read.
 */
export const Route = createFileRoute("/_connected/_shell/workflows/$workflowId")({
  staticData: { title: "Workflows" },
  validateSearch: validateWorkflowSearch,
  loaderDeps: ({ search }) => ({ runsView: search.runsView, daysBack: search.daysBack ?? 0 }),
  loader: async ({
    context: { controller, queryClient },
    params: { workflowId },
    deps: { runsView, daysBack },
    location,
    cause,
  }) => {
    const { client } = controller;
    const readRuns = async (): Promise<unknown> => {
      if (runsView !== "timeline") {
        return queryClient.ensureInfiniteQueryData(workflowRunsQuery(client, workflowId));
      }
      const settings = await queryClient.ensureQueryData(settingsQuery(client));
      const timezone = resolveDisplayTimezone(settings.user.timezone);
      const day = computeTimelineDay(new Date(), daysBack, timezone);
      return queryClient.ensureQueryData(
        workflowDayRunsQuery(client, workflowId, day.start.toISOString(), day.end.toISOString()),
      );
    };
    try {
      await Promise.all([
        queryClient.ensureQueryData(workflowQuery(client, workflowId)),
        queryClient.ensureQueryData(triggersQuery(client)),
        queryClient.ensureQueryData(providersQuery(client)),
        cause === "stay"
          ? queryClient.ensureQueryData(agentsQuery(client))
          : readOnOpen(queryClient, agentsQuery(client)),
        cause === "stay"
          ? queryClient.ensureQueryData(workflowActionsQuery(client))
          : readOnOpen(queryClient, workflowActionsQuery(client)),
        readRuns(),
      ]);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      throwScreenNotFound(location);
    }
  },
  component: OpenWorkflowRoute,
  notFoundComponent: WorkflowNotFound,
});

/** Renders the screen of a workflow that does not exist, with a link back to the list. */
function WorkflowNotFound(): JSX.Element {
  return (
    <NotFound headline="This workflow was not found.">
      <Link to="/workflows" className="btn btn--accent">
        Workflows
      </Link>
    </NotFound>
  );
}

/**
 * Draws the open workflow afresh for each workflow, so it opens on the Runs
 * tab and settles in again. Widening it to fill the pane keeps it.
 */
function OpenWorkflowRoute(): JSX.Element {
  const { workflowId } = Route.useParams();
  return <OpenWorkflow key={workflowId} workflowId={workflowId} />;
}

/**
 * Reads the open workflow and draws it: the lead with its switch, the
 * graph, and the four tabs. It holds the open tab, and saves the workflow's
 * switch and its triggers' pause switches.
 */
function OpenWorkflow({ workflowId }: { readonly workflowId: string }): JSX.Element {
  const { controller } = Route.useRouteContext();
  const { client } = controller;
  const { runsView = "list", daysBack = 0 } = Route.useSearch();
  const navigate = Route.useNavigate();

  const { data: workflow } = useSuspenseQuery(workflowQuery(client, workflowId));
  const { data: everyTrigger } = useSuspenseQuery(triggersQuery(client));
  const { data: settings } = useSuspenseQuery(settingsQuery(client));
  const { data: agents } = useSuspenseQuery(agentsQuery(client));
  const { data: actions } = useSuspenseQuery(workflowActionsQuery(client));
  const { data: instances } = useSuspenseQuery(providersQuery(client));
  const timezone = resolveDisplayTimezone(settings.user.timezone);

  const { definition } = parseWorkflowSourceWithRanges(workflow.source);
  if (definition === undefined) {
    // The controller saves only a source that parses, so this is a bug.
    throw new Error(`The saved source of the workflow "${workflowId}" does not parse.`);
  }

  const enabled = useWorkflowSwitch(client, workflow);
  const switches = useTriggerSwitches(
    client,
    workflowId,
    everyTrigger.filter((trigger) => trigger.workflowId === workflowId),
  );
  const { triggers } = switches;

  const [tab, setTab] = useState<WorkflowTab>("runs");
  const baseId = useId();
  // The pane is kept in state, not in a ref, so the Runs list draws again
  // once the pane is mounted. React sets a parent's ref only after its
  // children's layout effects ran, so the list's virtualizer would find no
  // pane to measure on its first render, and nothing would make it look again.
  const [pane, setPane] = useState<HTMLElement | null>(null);

  const shown = useShownDay(daysBack, timezone);
  const now = useTimelineNow(shown.day, timezone);
  const hours = buildTimelineHours(shown.day, timezone);

  const triggerRows = buildTriggerRows(definition, enabled.value, triggers);
  const inputRows = buildInputRows(definition);

  // Picking a view goes back to today, and stepping the day keeps the view.
  // Both replace the history entry, so Back leaves the workflow.
  const pickView = (view: RunsView): void => {
    void navigate({
      to: ".",
      search: (previous) => {
        const kept = { ...previous };
        delete kept.runsView;
        delete kept.daysBack;
        return view === "timeline" ? { ...kept, runsView: "timeline" as const } : kept;
      },
      replace: true,
    });
  };
  const showDay = (next: number): void => {
    void navigate({
      to: ".",
      search: (previous) => {
        const kept = { ...previous };
        delete kept.daysBack;
        return next === 0 ? kept : { ...kept, daysBack: next };
      },
      replace: true,
    });
  };

  const panelProps = {
    role: "tabpanel",
    id: buildTabElementId(baseId, tab, "panel"),
    "aria-labelledby": buildTabElementId(baseId, tab, "tab"),
  } as const;

  return (
    <section ref={setPane} className="open-pane" aria-label={definition.name}>
      <div className="pill-room" />
      <WorkflowLead
        name={definition.name}
        description={definition.description}
        isEnabled={enabled.value}
        error={enabled.error}
        chips={buildWorkflowChips(definition, enabled.value, triggers)}
        timezone={timezone}
        onToggle={() => {
          enabled.save(!enabled.value);
        }}
      />
      <WorkflowGraph
        drawing={buildGraphDrawing(definition, agents, actions)}
        readCard={(nodeId) =>
          buildNodeCard(definition, nodeId, {
            triggers,
            agents,
            actions,
            instances,
            isWorkflowEnabled: enabled.value,
          })
        }
        timezone={timezone}
        label={`The steps of ${definition.name}`}
      />
      <div className="tab-band">
        <WorkflowTabBar
          baseId={baseId}
          tab={tab}
          triggerCount={triggerRows.length}
          inputCount={inputRows.length}
          onSelect={setTab}
          tools={
            tab === "runs" ? (
              <>
                {runsView === "timeline" ? (
                  <TimelineDayStepper
                    dayText={shown.dayText}
                    isToday={shown.day.isToday}
                    onStepBack={() => {
                      showDay(daysBack + 1);
                    }}
                    onStepOn={() => {
                      showDay(daysBack - 1);
                    }}
                    onShowToday={() => {
                      showDay(0);
                    }}
                  />
                ) : null}
                <RunsViewPicker view={runsView} onPick={pickView} />
              </>
            ) : null
          }
        />
        {tab === "runs" && runsView === "list" ? <RunTableHeads /> : null}
        {tab === "runs" && runsView === "timeline" ? (
          <TimelineAxis hours={hours} now={now} />
        ) : null}
        {tab === "triggers" ? <TriggerTableHeads /> : null}
        {tab === "inputs" ? <InputTableHeads /> : null}
      </div>
      {tab === "runs" ? (
        <div {...panelProps}>
          {runsView === "list" ? (
            <RunList
              client={client}
              workflowId={workflowId}
              definition={definition}
              timezone={timezone}
              pane={pane}
            />
          ) : (
            // The loader reads the day before it shows. Only when the day
            // turns at midnight is the new day read here, and the lanes
            // stay empty until it answers.
            <Suspense fallback={<div className="lanes" style={{ "--tracks": 1 }} />}>
              <RunDayLanes
                client={client}
                workflowId={workflowId}
                definition={definition}
                isEnabled={enabled.value}
                triggers={triggers}
                shown={shown}
                hours={hours}
                now={now}
                timezone={timezone}
              />
            </Suspense>
          )}
        </div>
      ) : null}
      {tab === "triggers" ? (
        <div {...panelProps}>
          <TriggerTable
            rows={triggerRows}
            error={switches.error}
            timezone={timezone}
            onToggle={switches.toggle}
          />
        </div>
      ) : null}
      {tab === "inputs" ? (
        <div {...panelProps}>
          <InputTable rows={inputRows} />
        </div>
      ) : null}
      {tab === "source" ? (
        <pre className="codeblock" {...panelProps}>
          {workflow.source}
        </pre>
      ) : null}
    </section>
  );
}
