import { useEffect, useId, useState, type JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  describeRunWorkspace,
  isNotFound,
  isRunLive,
  listRerunChoices,
  readTimestamps,
  resolveDisplayTimezone,
} from "@hercule/client-core";
import {
  buildRunLead,
  countStepTimelineRows,
  describeRunWorkflow,
  ranOnEarlierVersion,
} from "@hercule/client-core/run-page-rows";
import { throwScreenNotFound } from "../../../../app/last-screen";
import { useScreenTopicsLive, WORKFLOW_TOPICS } from "../../../../app/live";
import {
  agentsQuery,
  controllerQuery,
  pluginsQuery,
  prefetchRunWorkflow,
  providerAccountsQuery,
  readOnOpen,
  rerunsQuery,
  runQuery,
  runSessionsQuery,
  settingsQuery,
  triggersQuery,
  workflowActionsQuery,
  workspacesQuery,
} from "../../../../app/queries";
import { isTextField } from "../../../../app/text-field";
import { NotFound } from "../../../../screens/not-found";
import { useRunWorkflow } from "../../../../screens/workflows/use-run-workflow";
import {
  RunPageLead,
  RunTop,
  StepsBand,
  TriggeringEvent,
  type RunAction,
} from "../../../../screens/workflows/run-page";
import {
  StepTimelineHead,
  StepTimelineRows,
  useStepTimeline,
} from "../../../../screens/workflows/step-timeline";
import { CancelRunDialog, RerunDialog } from "./-dialogs";
import { RunFactsSection } from "./-facts";
import { RunGraph } from "./-graph";

/** The search params of a run's page: `view` shows the steps on a timeline; without it, as a graph. */
interface RunSearch {
  readonly view?: "timeline" | undefined;
}

/**
 * A run's page (spec 17 §Workflows, "A run's page"). A row or a bar of a
 * workflow's Runs tab links here.
 *
 * Its loader reads everything the page draws before it renders:
 *
 * - the run; when no run has the id, the route shows `RunNotFound`;
 * - the run's sessions and its re-runs;
 * - the triggers, the provider instances, the plugins and the settings,
 *   which the step cards and the times need;
 * - the Agents and the workflow actions, which name the graph's steps, read
 *   each time the page opens because no topic covers them;
 * - for a run with a text generation step, once the run is read, the
 *   controller's own record, which tells whether text generation is
 *   available. It is read each time the page opens, because the model can
 *   change in the web app or the CLI with no push.
 *
 * Every other read starts at once. The run's workflow is read too, once the run
 * names it, but the page does not wait for it: it only tells whether the run
 * followed an earlier version, and whether the workflow was deleted. A
 * workflow that is gone answers `not_found`, which must not keep the page
 * from showing, and is not read again when another of its runs opens. The
 * runners, the workspaces and the resources are shell reads and are cached
 * already.
 */
export const Route = createFileRoute("/_connected/_shell/runs/$runId")({
  staticData: { title: "Run" },
  validateSearch: (search: Record<string, unknown>): RunSearch => ({
    view: search.view === "timeline" ? "timeline" : undefined,
  }),
  loader: async ({ context: { controller, queryClient }, params: { runId }, location }) => {
    const { client } = controller;
    await Promise.all([
      queryClient.ensureQueryData(runQuery(client, runId)).then(
        async (run) => {
          if (run.workflowId !== null)
            void prefetchRunWorkflow(queryClient, client, run.workflowId);
          if (run.plan.steps.some((step) => step.kind === "text-generation")) {
            await readOnOpen(queryClient, controllerQuery(client));
          }
        },
        (error: unknown) => {
          if (!isNotFound(error)) throw error;
          throwScreenNotFound(location);
        },
      ),
      queryClient.ensureQueryData(runSessionsQuery(client, runId)),
      queryClient.ensureQueryData(rerunsQuery(client, runId)),
      queryClient.ensureQueryData(triggersQuery(client)),
      queryClient.ensureQueryData(providerAccountsQuery(client)),
      queryClient.ensureQueryData(pluginsQuery(client)),
      queryClient.ensureQueryData(settingsQuery(client)),
      readOnOpen(queryClient, agentsQuery(client)),
      readOnOpen(queryClient, workflowActionsQuery(client)),
    ]);
  },
  component: RunRoute,
  notFoundComponent: RunNotFound,
});

/** Renders the screen of a run that does not exist, with a link to Workflows. */
function RunNotFound(): JSX.Element {
  return (
    <NotFound headline="This run was not found.">
      <Link to="/workflows" className="btn btn--accent">
        Workflows
      </Link>
    </NotFound>
  );
}

/**
 * Keeps the runs and the workflows current while the page is open, and
 * draws the run afresh for each run, so a re-run's page opens on its own
 * state.
 */
function RunRoute(): JSX.Element {
  const { controller, queryClient } = Route.useRouteContext();
  useScreenTopicsLive(controller.live, queryClient, WORKFLOW_TOPICS);
  const { runId } = Route.useParams();
  return <RunPage key={runId} runId={runId} />;
}

/** The dialog the page shows over the run, if any. */
type RunDialog = "cancel" | "rerun";

/**
 * Reads the run and draws its page: the header with its crumb and its
 * action, the lead, what the web app's page shows besides, and the steps as
 * a graph or a timeline. It opens the Cancel and Re-run dialogs.
 *
 * Esc goes to the run's workflow, or to Workflows when the run has none or
 * it was deleted, unless something else takes Esc first: a step's card or
 * anything else that calls `preventDefault()`, an open dialog or popover,
 * or a focused text field.
 */
function RunPage({ runId }: { readonly runId: string }): JSX.Element {
  const { controller } = Route.useRouteContext();
  const { client } = controller;
  const navigate = useNavigate();
  const view = Route.useSearch().view ?? "graph";
  const headingId = useId();
  const [dialog, setDialog] = useState<RunDialog | undefined>(undefined);

  const { data: run } = useSuspenseQuery(runQuery(client, runId));
  const { data: sessions } = useSuspenseQuery(runSessionsQuery(client, runId));
  const { data: settings } = useSuspenseQuery(settingsQuery(client));
  const { data: workspaces } = useSuspenseQuery(workspacesQuery(client));
  const { workflowId } = run;
  const { workflow, isDeleted: isWorkflowDeleted } = useRunWorkflow(client, workflowId);
  const steps = useStepTimeline(run, sessions, view === "timeline");
  const crumbWorkflow = describeRunWorkflow(run, isWorkflowDeleted);

  // Esc goes back to the workflow while it has a page to go back to.
  const escapeWorkflowId = crumbWorkflow.kind === "saved" ? crumbWorkflow.workflowId : undefined;
  useEffect(() => {
    const leavePage = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (isTextField(event.target)) return;
      if (document.querySelector('dialog[open], [popover="auto"]:popover-open') !== null) return;
      void (escapeWorkflowId === undefined
        ? navigate({ to: "/workflows" })
        : navigate({ to: "/workflows/$workflowId", params: { workflowId: escapeWorkflowId } }));
    };
    window.addEventListener("keydown", leavePage);
    return () => window.removeEventListener("keydown", leavePage);
  }, [escapeWorkflowId, navigate]);

  const timezone = resolveDisplayTimezone(settings.user.timezone);
  const isLive = isRunLive(run.status);
  const lead = buildRunLead(run, sessions);
  const { startedAt, finishedAt } = readTimestamps(run);
  const workspace = workspaces.find((each) => each.id === run.workspaceId);
  const openSession = (sessionId: string): void => {
    void navigate({ to: "/threads/$sessionId", params: { sessionId } });
  };
  const runActions: ReadonlyArray<RunAction> = isLive
    ? [{ label: "Cancel run…", onPress: () => setDialog("cancel") }]
    : [{ label: "Re-run…", onPress: () => setDialog("rerun") }];
  const closeDialog = (): void => setDialog(undefined);

  return (
    <div className="workflows-page">
      <RunTop
        workflow={crumbWorkflow}
        mark={lead.mark}
        startedAt={startedAt ?? run.createdAt}
        timezone={timezone}
        actions={runActions}
      />
      <section className="open-pane run-page" aria-labelledby={headingId}>
        <div className="pill-room" />
        <RunPageLead
          headingId={headingId}
          lead={lead}
          startedAt={startedAt}
          finishedAt={finishedAt}
          isLive={isLive}
          onOpenSession={openSession}
        />
        <RunFactsSection client={client} run={run} timezone={timezone} />
        {run.triggerEvent === undefined ? null : (
          <TriggeringEvent event={run.triggerEvent} timezone={timezone} />
        )}
        {workflow !== undefined && ranOnEarlierVersion(run, workflow) ? (
          <p className="run-note">
            This run followed an earlier version of {run.plan.name}. Its steps are shown as they
            were then.
          </p>
        ) : null}
        <StepsBand
          count={steps?.timeline.rows.length ?? countStepTimelineRows(run)}
          view={view}
          onPickView={(picked) =>
            void navigate({
              to: "/runs/$runId",
              params: { runId },
              search: { view: picked === "timeline" ? "timeline" : undefined },
              replace: true,
            })
          }
        >
          {steps === undefined ? null : <StepTimelineHead steps={steps} />}
        </StepsBand>
        {steps !== undefined ? (
          <StepTimelineRows steps={steps} onOpenSession={openSession} />
        ) : (
          <RunGraph
            client={client}
            run={run}
            sessions={sessions}
            workflow={workflow}
            timezone={timezone}
            onOpenSession={openSession}
          />
        )}
      </section>
      {dialog === "cancel" ? (
        <CancelRunDialog
          client={client}
          runId={runId}
          asksOnCancel={describeRunWorkspace(run, workspace, timezone).asksOnCancel}
          onClose={closeDialog}
        />
      ) : null}
      {dialog === "rerun" ? (
        <RerunDialog
          client={client}
          runId={runId}
          choices={listRerunChoices(run, isWorkflowDeleted)}
          onClose={closeDialog}
        />
      ) : null}
    </div>
  );
}
