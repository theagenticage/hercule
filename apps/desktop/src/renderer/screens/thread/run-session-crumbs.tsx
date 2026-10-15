/**
 * The crumbs of a step session's header. Only the thread's header imports
 * this module, and it does so lazily, for a session that a run's agent step
 * started, so the run's code stays out of the chunk of a thread that has no
 * run (spec 17 §Performance).
 */
import type { JSX } from "react";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Link, useRouteContext } from "@tanstack/react-router";
import { readTimestamps, resolveDisplayTimezone } from "@hercule/client-core";
import { hasRunMark } from "@hercule/client-core/run-marks";
import {
  decideRunMark,
  describeRunState,
  describeRunWorkflow,
} from "@hercule/client-core/run-page-rows";
import type { Run } from "@hercule/contract";
import { useWorkflowsLive } from "../../app/live";
import { liveAgentSessionsQuery, runQuery, settingsQuery } from "../../app/queries";
import { Mark } from "../../marks";
import { useStartTime } from "../workflows/list-time";
import { WorkflowCrumb, WorkflowsCrumb } from "../workflows/run-crumbs";
import { useRunWorkflow } from "../workflows/use-run-workflow";

/**
 * Renders the place of the step session of the run `runId`, as the crumbs of
 * a header's first pill: Workflows, the run's workflow and the run. Each is a
 * link, except a workflow that is gone, which shows why.
 *
 * A run that cannot be read, such as one that was deleted, leaves only the
 * Workflows crumb, so there is still a way back to the workflows. The run's
 * loader has read the run and its workflow before this renders, so nothing
 * here waits in practice. The component holds the `run` and `workflow`
 * topics while it is mounted, as the run's page does: the run's mark follows
 * the first, and a workflow deleted while the header is open shows as
 * deleted through the second.
 */
export function RunSessionCrumbs({ runId }: { readonly runId: string }): JSX.Element {
  const { controller, queryClient } = useRouteContext({ from: "/_connected" });
  const { client } = controller;
  useWorkflowsLive(controller.live, queryClient);
  // A run that failed as not found is not read again when the header mounts.
  const run = useQuery({ ...runQuery(client, runId), retryOnMount: false }).data;
  const { isDeleted } = useRunWorkflow(client, run?.workflowId ?? null);
  if (run === undefined) return <WorkflowsCrumb />;
  return (
    <>
      <WorkflowsCrumb />
      <WorkflowCrumb workflow={describeRunWorkflow(run, isDeleted)} />
      <RunCrumb run={run} />
    </>
  );
}

/**
 * Renders the crumb of `run`: a link to its page with its mark, "Run", and
 * when it started, as a run's own page shows it. The mark is waiting while
 * a live session of the run asks the user. The mark is a picture, so the
 * link is named with the run's state too: "Run Today 09:30, Running".
 */
function RunCrumb({ run }: { readonly run: Run }): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const sessions = useSuspenseQuery(liveAgentSessionsQuery(client)).data;
  const settings = useQuery(settingsQuery(client)).data;
  const timezone = resolveDisplayTimezone(settings?.user.timezone);
  const mark = decideRunMark(run, sessions);
  const startedText = useStartTime(readTimestamps(run).startedAt ?? run.createdAt, timezone);
  return (
    <span className="pill-crumb run-crumb">
      <Link
        to="/runs/$runId"
        params={{ runId: run.id }}
        aria-label={`Run ${startedText}, ${describeRunState(mark)}`}
      >
        {hasRunMark(mark) ? <Mark state={mark} /> : null}
        Run <small>{startedText}</small>
      </Link>
    </span>
  );
}
