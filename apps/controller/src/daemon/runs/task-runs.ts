/**
 * Task Runs: answers, for `task.readDetail` and a Task's summary, the newest
 * runs of one Task.
 *
 * It lives in the controller daemon because the port belongs to the tasks
 * domain and is answered from the runs repository, and the runs domain
 * depends on the tasks domain. Only the layer above both can join them.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import {
  describeFailureCause,
  MAX_DETAIL_RUNS,
  MAX_FAILURE_CAUSE,
  type TaskDetailRun,
} from "@hercule/contract";
import { runRepository } from "../../runs";
import { cutText } from "../../text";
import { TaskRuns } from "../../tasks";

/**
 * Answers the tasks domain's `TaskRuns` port from the runs repository. The
 * tasks domain cannot import the runs domain, which depends on it, so the
 * controller daemon connects the two. A failed run's cause is worked out from
 * its own failure message or its failed step's error, in one statement for
 * all the failed runs, so no run is read whole. The cause is cut to
 * `MAX_FAILURE_CAUSE` characters, because an error message has no length of
 * its own.
 */
export const TaskRunsLayer: Layer.Layer<TaskRuns, never, SqlClient.SqlClient> = Layer.effect(
  TaskRuns,
)(
  Effect.map(runRepository, (runs) => ({
    readRunHistory: (taskId: string): Effect.Effect<ReadonlyArray<TaskDetailRun>, SqlError> =>
      Effect.gen(function* () {
        const newestFirst = yield* runs.listNewestOfTask(taskId, MAX_DETAIL_RUNS);
        if (newestFirst.length === 0) return [];
        const messages = yield* runs.listFailureMessages(
          newestFirst.filter((run) => run.status === "failed").map((run) => run.id),
        );
        const sessions = yield* runs.listLastSessions(newestFirst.map((run) => run.id));
        return newestFirst.toReversed().map((run): TaskDetailRun => {
          const sessionId = sessions.get(run.id);
          return {
            id: run.id,
            workflowId: run.workflowId,
            workflowName: run.workflowName,
            status: run.status,
            createdAt: run.createdAt,
            ...("startedAt" in run && run.startedAt !== undefined
              ? { startedAt: run.startedAt }
              : {}),
            ...("finishedAt" in run ? { finishedAt: run.finishedAt } : {}),
            awaitedSignalIds: "awaitedSignalIds" in run ? run.awaitedSignalIds : [],
            ...(run.status === "failed"
              ? {
                  failureCause: cutText(
                    describeFailureCause({
                      reason: run.failureReason,
                      message: messages.get(run.id),
                    }),
                    MAX_FAILURE_CAUSE,
                  ),
                }
              : {}),
            ...(sessionId === undefined ? {} : { sessionId }),
          };
        });
      }),
  })),
);
