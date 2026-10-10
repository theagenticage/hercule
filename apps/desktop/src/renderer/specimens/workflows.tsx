/**
 * PROTOTYPE. The Workflows specimen: the app's real shell with Workflows
 * open, drawn from the records in workflows-fixture.ts.
 *
 * The page takes its theme from `?theme=`, and the list's width from
 * `?view=`:
 * - `table`, the default: no workflow is open, and the list fills the pane;
 * - `split`: Ship release is open beside the list, as a column;
 * - `full`: Ship release fills the pane, and the list is hidden.
 *
 * The page removes every animation, so the sheet is held still, unless the
 * URL has `?motion=1` or `?play=`.
 *
 * `?play=completed` or `?play=failed` plays Ship release's newest run from
 * before it starts to that ending, a moment every 1.6 seconds, so the list,
 * the graph and the Runs tab change as they would while the run runs.
 */
import "./fixed-clock";
import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import type { HerculeClient } from "@hercule/client-core";
import type { RunSummary, Session } from "@hercule/contract";
import { computeTimelineDay, computeTimelineReadRange } from "../screens/workflows/run-timeline";
import { RECENT_RUN_LIMIT, type WorkflowListEntry } from "../screens/workflows/proposed-contract";
import {
  runQuery,
  runSessionsQuery,
  waitingRunSessionsQuery,
  workflowListQuery,
  workflowRunningRunsQuery,
  workflowRunsBetweenQuery,
  workflowRunsQuery,
} from "../screens/workflows/workflow-queries";
import { mountWorkflowsSpecimen } from "./shell-page";
import { markSheetReady } from "./sheet-page";
import { SPECIMEN_RECORDS } from "./sidebar-fixture";
import {
  buildShipReleaseFrames,
  SHIP_RELEASE_ID,
  summarizeRun,
  WORKFLOWS_RECORDS,
  type RunFrame,
  type WorkflowsRecords,
} from "./workflows-fixture";

const params = new URLSearchParams(location.search);

/** Returns the address the page opens at for `view`. Fails for a view the page does not draw. */
function chooseAddress(view: string | null): string {
  switch (view) {
    case null:
    case "table":
      return "/workflows";
    case "split":
      return `/workflows/${SHIP_RELEASE_ID}`;
    case "full":
      return `/workflows/${SHIP_RELEASE_ID}?full=true`;
    default:
      throw new Error(`The Workflows specimen draws no view "${view}".`);
  }
}

/** Returns `records` without the run `runId` and its sessions, as before the run started. */
const removeRun = (records: WorkflowsRecords, runId: string): WorkflowsRecords => ({
  ...records,
  workflows: records.workflows.map((entry) => ({
    ...entry,
    recentRuns: entry.recentRuns.filter((run) => run.id !== runId),
  })),
  runs: records.runs.filter((run) => run.id !== runId),
  runSummaries: new Map(
    [...records.runSummaries].map(([workflowId, summaries]) => [
      workflowId,
      summaries.filter((run) => run.id !== runId),
    ]),
  ),
  runSessions: records.runSessions.filter((session) => session.runId !== runId),
});

/** Returns `items` with `item` first in place of the item with its id. */
const putFirst = <T extends { readonly id: string }>(
  items: ReadonlyArray<T>,
  item: T,
): ReadonlyArray<T> => [item, ...items.filter((other) => other.id !== item.id)];

/**
 * Writes one moment of Ship release's run into every record the page reads
 * it from: the run, its sessions, the sessions that wait on the user, the
 * list's recent runs, the Runs tab's list, and today's timeline.
 */
const applyRunFrame = (queryClient: QueryClient, client: HerculeClient, frame: RunFrame): void => {
  const { run } = frame;
  const summary = summarizeRun(run, "Ship release");
  queryClient.setQueryData(runQuery(client, run.id).queryKey, run);
  queryClient.setQueryData(runSessionsQuery(client, run.id).queryKey, frame.sessions);
  queryClient.setQueryData(
    waitingRunSessionsQuery().queryKey,
    (sessions: ReadonlyArray<Session> | undefined) => [
      ...(sessions ?? []).filter((session) => session.runId !== run.id),
      ...frame.sessions.filter((session) => session.openRequests.length > 0),
    ],
  );
  queryClient.setQueryData(
    workflowListQuery().queryKey,
    (entries: ReadonlyArray<WorkflowListEntry> | undefined) =>
      (entries ?? []).map((entry) =>
        entry.id === SHIP_RELEASE_ID
          ? {
              ...entry,
              recentRuns: putFirst(entry.recentRuns, frame.recentRun).slice(0, RECENT_RUN_LIMIT),
            }
          : entry,
      ),
  );
  queryClient.setQueryData(
    workflowRunsQuery(client, SHIP_RELEASE_ID).queryKey,
    (data: InfiniteData<{ readonly items: ReadonlyArray<RunSummary> }> | undefined) =>
      data === undefined
        ? data
        : {
            ...data,
            pages: data.pages.map((page, index) =>
              index === 0 ? { ...page, items: putFirst(page.items, summary) } : page,
            ),
          },
  );
  const { since, until } = computeTimelineReadRange(
    computeTimelineDay(new Date(), 0, "UTC"),
    "UTC",
  );
  queryClient.setQueryData(
    workflowRunsBetweenQuery(client, SHIP_RELEASE_ID, since, until).queryKey,
    (runs: ReadonlyArray<RunSummary> | undefined) => putFirst(runs ?? [], summary),
  );
  queryClient.setQueryData(
    workflowRunningRunsQuery(client, SHIP_RELEASE_ID).queryKey,
    (runs: ReadonlyArray<RunSummary> | undefined) => [
      ...(runs ?? []).filter((other) => other.id !== run.id),
      ...(run.status === "running" ? [summary] : []),
    ],
  );
};

const play = params.get("play");
if (play !== null && play !== "completed" && play !== "failed") {
  throw new Error(`The Workflows specimen plays no ending "${play}".`);
}
const frames = play === null ? [] : buildShipReleaseFrames(play);
const { client, queryClient } = await mountWorkflowsSpecimen(
  SPECIMEN_RECORDS,
  chooseAddress(params.get("view")),
  frames.length === 0 ? WORKFLOWS_RECORDS : removeRun(WORKFLOWS_RECORDS, frames[0]!.run.id),
);
frames.forEach((frame, index) => {
  setTimeout(
    () => {
      applyRunFrame(queryClient, client, frame);
    },
    (index + 1) * 1600,
  );
});
if (!params.has("motion") && play === null) {
  const style = document.createElement("style");
  style.textContent = "* { animation: none !important; }";
  document.head.append(style);
}
await markSheetReady();
