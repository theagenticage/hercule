/**
 * Task Tracking Runs: answers, for `task.queryTracking`, the newest run and
 * the newest live run of each tracked Task.
 *
 * It lives in the controller daemon because the port belongs to the tasks
 * domain and is answered from the runs repository, and the runs domain
 * depends on the tasks domain. Only the layer above both can join them.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { describeFailureCause, type RunSummary, type TrackingRun } from "@hercule/contract";
import { runRepository } from "../../runs";
import { TaskTrackingRuns, type TrackedRuns } from "../../tasks";

/** Converts a run summary into the run facts Tracking reads, with `failureMessage` for a failed run. */
const buildTrackingRun = (run: RunSummary, failureMessage: string | undefined): TrackingRun => ({
  id: run.id,
  workflowId: run.workflowId,
  workflowName: run.workflowName,
  status: run.status,
  createdAt: run.createdAt,
  ...("startedAt" in run && run.startedAt !== undefined ? { startedAt: run.startedAt } : {}),
  ...("finishedAt" in run ? { finishedAt: run.finishedAt } : {}),
  awaitedSignalIds: "awaitedSignalIds" in run ? run.awaitedSignalIds : [],
  ...(run.status === "failed"
    ? { failureCause: describeFailureCause({ reason: run.failureReason, message: failureMessage }) }
    : {}),
});

/**
 * Answers the tasks domain's `TaskTrackingRuns` port from the runs
 * repository. The tasks domain cannot import the runs domain, which depends
 * on it, so the controller daemon connects the two. A failed run's cause is
 * worked out from its own failure message or its failed step's error, in one
 * statement for all the failed runs, so no run is read whole.
 */
export const TaskTrackingRunsLayer: Layer.Layer<TaskTrackingRuns, never, SqlClient.SqlClient> =
  Layer.effect(TaskTrackingRuns)(
    Effect.map(runRepository, (runs) => ({
      readLatestRuns: (taskIds: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          const { latest, live } = yield* runs.listLatestOfTasks(taskIds);
          const messages = yield* runs.listFailureMessages(
            [...latest, ...live].filter((run) => run.status === "failed").map((run) => run.id),
          );
          const build = (run: RunSummary): TrackingRun =>
            buildTrackingRun(run, messages.get(run.id));
          // The live runs come newest first, so the first of a Task is its newest.
          const newestLiveByTask = new Map<string, RunSummary>();
          for (const run of live) {
            if (run.taskId !== undefined && !newestLiveByTask.has(run.taskId)) {
              newestLiveByTask.set(run.taskId, run);
            }
          }
          return latest.flatMap((run): ReadonlyArray<TrackedRuns> => {
            if (run.taskId === undefined) return [];
            const liveRun = newestLiveByTask.get(run.taskId);
            return [
              {
                taskId: run.taskId,
                latestRun: build(run),
                ...(liveRun === undefined ? {} : { latestLiveRun: build(liveRun) }),
              },
            ];
          });
        }),
    })),
  );
