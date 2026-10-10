import { useEffect, useRef, useState, type JSX } from "react";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link, createFileRoute, notFound } from "@tanstack/react-router";
import {
  isNotFound,
  isRunLive,
  listRerunChoices,
  parseWorkflowSourceWithRanges,
  queryKeys,
  readErrorMessage,
  readTimestamps,
  resolveDisplayTimezone,
} from "@hercule/client-core";
import type { RerunMode } from "@hercule/contract";
import { useDurationClock } from "../../../../app/age-clock";
import { agentsQuery, providersQuery, settingsQuery } from "../../../../app/queries";
import { NotFound } from "../../../../screens/not-found";
import { buildGraphDrawing } from "../../../../screens/workflows/graph-model";
import { buildNodeDetails } from "../../../../screens/workflows/node-details";
import {
  CancelRunDialog,
  EarlierVersionNote,
  RerunDialog,
  RunLeadView,
  RunTop,
  StepAxis,
  StepTimeline,
  StepsBar,
  useAxisWidth,
  type RunCrumbWorkflow,
  type StepsView,
} from "../../../../screens/workflows/run-page";
import {
  buildRunLead,
  buildStepTimelineRows,
  describeRunDuration,
  isPlanCurrent,
  listInputFacts,
} from "../../../../screens/workflows/run-page-rows";
import { WorkflowGraph } from "../../../../screens/workflows/workflow-graph";
import {
  runQuery,
  runSessionsQuery,
  workflowActionsQuery,
  workflowQuery,
} from "../../../../screens/workflows/workflow-queries";
import "../../../../screens/workflows/workflows-frame.css";

/**
 * The search params of a run's page. `view` shows the steps on a time axis;
 * with none, as the graph of the run's plan. A param set to `undefined` is
 * left out of the URL.
 */
export interface RunSearch {
  readonly view?: "timeline" | undefined;
}

/** Returns a run page's search params from the URL's, dropping any it does not know. */
const validateRunSearch = (search: Record<string, unknown>): RunSearch =>
  search.view === "timeline" ? { view: "timeline" } : {};

/**
 * PROTOTYPE. One run's page, filling the main pane: how the run stands,
 * what it asks the user or why it failed, its inputs, and its steps, as the
 * graph of the plan it froze or on a time axis. A live run can be
 * cancelled, and an ended one re-run.
 *
 * The loader reads the run and everything its page draws before the page
 * renders. A run outlives its workflow, so the loader reads the workflow
 * without failing: a workflow that is gone is a crumb with no link, and
 * leaves only one way to re-run. When no run has the id, the route shows
 * `RunNotFound`.
 */
export const Route = createFileRoute("/_connected/_shell/runs/$runId")({
  // The loader goes in the component's chunk. The router splits off only the
  // component by default, so the loader, and every module it imports, would
  // otherwise load with the first screen.
  codeSplitGroupings: [["loader", "component", "notFoundComponent"]],
  staticData: { title: "Run" },
  validateSearch: validateRunSearch,
  loader: async ({ context: { controller, queryClient }, params: { runId } }) => {
    const client = controller.client;
    const run = await queryClient
      .ensureQueryData(runQuery(client, runId))
      .catch((error: unknown) => {
        if (!isNotFound(error)) throw error;
        // The router acts on a thrown `notFound`, which is a plain descriptor
        // rather than an Error.
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw notFound();
      });
    await Promise.all([
      queryClient.ensureQueryData(runSessionsQuery(client, runId)),
      queryClient.ensureQueryData(agentsQuery(client)),
      queryClient.ensureQueryData(providersQuery(client)),
      queryClient.ensureQueryData(workflowActionsQuery(client)),
      queryClient.ensureQueryData(settingsQuery(client)),
      // A prefetch keeps a failed read in the cache instead of failing the
      // loader, so the page can tell a deleted workflow by its error.
      run.workflowId === null
        ? undefined
        : queryClient.prefetchQuery(workflowQuery(client, run.workflowId)),
    ]);
  },
  component: RunRoute,
  notFoundComponent: RunNotFound,
});

/** Renders the run's page afresh for each run, so its dialogs and bars start over. */
function RunRoute(): JSX.Element {
  const { runId } = Route.useParams();
  return <RunPage key={runId} runId={runId} />;
}

function RunPage({ runId }: { readonly runId: string }): JSX.Element {
  const { controller } = Route.useRouteContext();
  const client = controller.client;
  const queryClient = useQueryClient();
  const navigate = Route.useNavigate();
  const search = Route.useSearch();
  const run = useSuspenseQuery(runQuery(client, runId)).data;
  const sessions = useSuspenseQuery(runSessionsQuery(client, runId)).data;
  const agents = useSuspenseQuery(agentsQuery(client)).data;
  const instances = useSuspenseQuery(providersQuery(client)).data;
  const actions = useSuspenseQuery(workflowActionsQuery(client)).data;
  const settings = useSuspenseQuery(settingsQuery(client)).data;
  const workflowRead = useQuery({
    ...workflowQuery(client, run.workflowId ?? ""),
    enabled: run.workflowId !== null,
    // The loader read it; a deleted workflow stays deleted.
    retryOnMount: false,
  });

  const isLive = isRunLive(run.status);
  const { startedAt } = readTimestamps(run);
  const now = useDurationClock(startedAt ?? run.createdAt, isLive);
  const { axisRef, widthInCharacters } = useAxisWidth();
  const [dialog, setDialog] = useState<"cancel" | "rerun" | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const isWorkflowDeleted = isNotFound(workflowRead.error);
  const rerunChoices = listRerunChoices(run, isWorkflowDeleted);
  const [rerunMode, setRerunMode] = useState<RerunMode>(rerunChoices[0].mode);

  const timezone = resolveDisplayTimezone(settings.user.timezone);
  const nowDate = new Date(now);
  const lead = buildRunLead(run, sessions, timezone, nowDate);
  const view: StepsView = search.view === "timeline" ? "timeline" : "graph";
  const timeline = buildStepTimelineRows(run, sessions, now, widthInCharacters);
  const drawing = buildGraphDrawing(run.plan, run, sessions, agents, actions);
  const records = { definition: run.plan, run, sessions, triggers: [], agents, actions, instances };

  // The YAML parser loads with this page, not with the first screen.
  const workflow = workflowRead.data;
  const savedDefinition =
    workflow === undefined ? undefined : parseWorkflowSourceWithRanges(workflow.source).definition;
  const isEarlierVersion =
    savedDefinition !== undefined && !isPlanCurrent(run.plan, savedDefinition);
  const crumb: RunCrumbWorkflow =
    run.workflowId === null
      ? { kind: "gone", name: run.plan.name, why: "not saved" }
      : isWorkflowDeleted
        ? { kind: "gone", name: run.plan.name, why: "deleted" }
        : {
            kind: "saved",
            workflowId: run.workflowId,
            name: savedDefinition?.name ?? run.plan.name,
          };

  const cancel = useMutation({
    mutationFn: () => client.run.cancel({ params: { id: runId }, payload: {} }),
    onSuccess: async (cancelled) => {
      dialogRef.current?.close();
      queryClient.setQueryData(queryKeys.run(runId), cancelled);
      await queryClient.invalidateQueries({ queryKey: queryKeys.runs() });
    },
    // A refusal usually means the run ended meanwhile, so read it again.
    onError: () => queryClient.invalidateQueries({ queryKey: queryKeys.run(runId) }),
  });
  const rerun = useMutation({
    mutationFn: (mode: RerunMode) => client.run.rerun({ params: { id: runId }, payload: { mode } }),
    onSuccess: async ({ runId: newRunId }) => {
      dialogRef.current?.close();
      await queryClient.invalidateQueries({ queryKey: queryKeys.runs() });
      void navigate({ to: "/runs/$runId", params: { runId: newRunId } });
    },
  });

  const openSession = (sessionId: string): void => {
    void navigate({ to: "/threads/$sessionId", params: { sessionId } });
  };
  // The view is how the page shows the steps, not a place to go back to, so
  // changing it replaces the page's history entry.
  const pickView = (next: StepsView): void => {
    void navigate({
      to: ".",
      search: { view: next === "timeline" ? "timeline" : undefined },
      replace: true,
    });
  };

  // Esc goes back to the run's workflow, or to Workflows when it has none.
  // A key typed into a field is the field's, and an open card over a node
  // of the graph, or a dialog, closes itself on Esc.
  const workflowId = crumb.kind === "saved" ? crumb.workflowId : undefined;
  useEffect(() => {
    const leave = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (event.target instanceof HTMLElement && event.target.closest("input, textarea")) return;
      if (document.querySelector(":popover-open, dialog[open]") !== null) return;
      void (workflowId === undefined
        ? navigate({ to: "/workflows" })
        : navigate({ to: "/workflows/$workflowId", params: { workflowId } }));
    };
    window.addEventListener("keydown", leave);
    return () => window.removeEventListener("keydown", leave);
  }, [workflowId, navigate]);

  return (
    <div className="wf wf--full">
      <RunTop
        workflow={crumb}
        mark={lead.mark}
        timeText={lead.timeText}
        action={isLive ? "cancel" : "rerun"}
        onAction={() => {
          cancel.reset();
          rerun.reset();
          setRerunMode(rerunChoices[0].mode);
          setDialog(isLive ? "cancel" : "rerun");
        }}
      />
      <section
        className="wf-open run-page"
        aria-label={`${run.plan.name}, run of ${lead.timeText}`}
      >
        <div className="wfd">
          <div className="wfd-cap" />
          <RunLeadView
            lead={lead}
            durationText={describeRunDuration(run, now)}
            inputs={listInputFacts(run)}
            onOpenSession={openSession}
          />
          {isEarlierVersion ? <EarlierVersionNote name={crumb.name} /> : null}
          <div className="wfd-band">
            <StepsBar count={timeline.rows.length} view={view} onPickView={pickView} />
            {view === "timeline" ? <StepAxis timeline={timeline} axisRef={axisRef} /> : null}
          </div>
          {view === "timeline" ? (
            <StepTimeline timeline={timeline} isLive={isLive} onOpenSession={openSession} />
          ) : (
            <div className="wfd-graph">
              <WorkflowGraph
                drawing={drawing}
                details={buildNodeDetails(drawing, records, timezone, nowDate)}
                label={`${run.plan.name}, run of ${lead.timeText}`}
                onOpenSession={openSession}
              />
            </div>
          )}
        </div>
      </section>
      {dialog === "cancel" ? (
        <CancelRunDialog
          dialogRef={dialogRef}
          hasWorkspace={run.workspaceId !== undefined}
          pending={cancel.isPending}
          error={cancel.error === null ? null : `Not cancelled: ${readErrorMessage(cancel.error)}`}
          onConfirm={() => cancel.mutate()}
          onClose={() => setDialog(null)}
        />
      ) : dialog === "rerun" ? (
        <RerunDialog
          dialogRef={dialogRef}
          choices={rerunChoices}
          mode={rerunMode}
          onPickMode={setRerunMode}
          pending={rerun.isPending}
          error={rerun.error === null ? null : `Not re-run: ${readErrorMessage(rerun.error)}`}
          onConfirm={() => rerun.mutate(rerunMode)}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </div>
  );
}

/** Renders what the run's route shows when no run has the id in the link. */
function RunNotFound(): JSX.Element {
  return (
    <NotFound headline="There is no run with this id.">
      <Link to="/workflows" className="btn btn--accent">
        Go to Workflows
      </Link>
    </NotFound>
  );
}
