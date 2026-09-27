import type { JSX } from "react";
import { Link, createFileRoute, notFound } from "@tanstack/react-router";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import {
  describeRunnerWait,
  describeRunWorkspace,
  formatWorkspaceLabel,
  isNotFound,
  resolveDisplayTimezone,
} from "@hercule/client-core";
import { EmptyState } from "@hercule/ui";
import { useLiveInvalidation } from "../../../app/live-invalidation";
import {
  resourcesQuery,
  runQuery,
  runnerQuery,
  settingsQuery,
  workflowActionsQuery,
  workspaceQuery,
} from "../../../app/queries";
import { RunPage, type StepsView } from "./-page";

export const Route = createFileRoute("/_shell/runs/$runId")({
  // The page draws its own header with the workflow's name, so the shell
  // hides its top bar.
  staticData: { title: "Run", ownsTopBar: true },
  // The steps view is in the address, so a reload or a shared link keeps it.
  // The list is the default and leaves the address without it.
  validateSearch: (search: Record<string, unknown>): { readonly steps?: StepsView } =>
    search["steps"] === "timeline" ? { steps: "timeline" } : {},
  // Loads the run, the runner and workspace it is pinned to, and the action
  // catalog before the page renders, so the page never waits on them. The
  // catalog tells which steps run in the workspace, and so which ones wait
  // for a runner.
  loader: async ({ context: { client, queryClient }, params }) => {
    const [run] = await Promise.all([
      queryClient.ensureQueryData(runQuery(client, params.runId)).catch((error: unknown) => {
        // A link to a run the controller does not have shows that, instead of
        // a load error.
        throw isNotFound(error) ? notFound() : error;
      }),
      queryClient.ensureQueryData(workflowActionsQuery(client)),
    ]);
    const { runnerId, workspaceId } = run;
    await Promise.all([
      runnerId === undefined ? null : queryClient.ensureQueryData(runnerQuery(client, runnerId)),
      workspaceId === undefined
        ? null
        : queryClient.ensureQueryData(workspaceQuery(client, workspaceId)),
      // A main workspace is named after its repo.
      workspaceId === undefined ? null : queryClient.ensureQueryData(resourcesQuery(client)),
    ]);
  },
  component: RunScreen,
  notFoundComponent: MissingRun,
});

/**
 * Renders a run's page, kept current by two topics:
 *
 * - `run`: the run engine publishes the run's id on it after every change to
 *   the run or to one of its step records;
 * - `runner`: the run's runner going offline or coming back changes what a
 *   running step shows.
 *
 * The runner and the workspace are read only once the run is pinned to
 * them. The loader has read them for a run that already was; a run pinned
 * while the page is open reads them then, and shows them when they arrive.
 */
function RunScreen(): JSX.Element {
  const { client, queryClient, live } = Route.useRouteContext();
  const { runId } = Route.useParams();
  const { steps = "list" } = Route.useSearch();
  const navigate = Route.useNavigate();

  useLiveInvalidation(live, queryClient, "run");
  useLiveInvalidation(live, queryClient, "runner");

  const run = useSuspenseQuery(runQuery(client, runId)).data;
  const timezone = resolveDisplayTimezone(
    useSuspenseQuery(settingsQuery(client)).data.user.timezone,
  );
  const runner = useQuery({
    ...runnerQuery(client, run.runnerId ?? ""),
    enabled: run.runnerId !== undefined,
  }).data;
  const workspace = useQuery({
    ...workspaceQuery(client, run.workspaceId ?? ""),
    enabled: run.workspaceId !== undefined,
  }).data;
  const resources = useQuery({ ...resourcesQuery(client), enabled: workspace !== undefined }).data;
  const actions = useSuspenseQuery(workflowActionsQuery(client)).data;

  return (
    <RunPage
      // Keyed by id, so moving to another run mounts a fresh page, without the
      // previous run's open rows or its question.
      key={runId}
      client={client}
      run={run}
      runner={runner}
      workspaceLabel={
        workspace === undefined || resources === undefined
          ? undefined
          : formatWorkspaceLabel(workspace, resources.items, runner === undefined ? [] : [runner])
      }
      workspaceReading={describeRunWorkspace(run, workspace, timezone)}
      runnerWait={describeRunnerWait(run, runner, actions, timezone)}
      timezone={timezone}
      stepsView={steps}
      onStepsViewChange={(next) =>
        void navigate({ search: next === "list" ? {} : { steps: next }, replace: true })
      }
    />
  );
}

/** Renders the page for a run id that the controller does not have. */
function MissingRun(): JSX.Element {
  return (
    <EmptyState headline="There is no run with this id.">
      <Link
        to="/runs"
        className="self-start text-row text-muted underline underline-offset-2 hover:text-ink"
      >
        Go to Runs
      </Link>
    </EmptyState>
  );
}
