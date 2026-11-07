/**
 * Marking a Task's summary out of date. `TaskService.markSummaryDirty` and the
 * External Entities repository share it: a poll that changes a thing a Task
 * links must mark the Task in the poll's own transaction, and that domain
 * cannot call the task service.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { afterCommit, announceTaskCardChange, nowIso, withTransaction } from "../db";
import { taskRepository } from "./repository";
import { TaskSummaryWake } from "./summary-wake";

/**
 * Builds the function that marks the summary of a Task dirty in the caller's
 * transaction, and wakes the summary writer once that transaction commits.
 *
 * The first mark of a dirty cycle on a Task that has a written summary also
 * announces the Task as a derived change, so its card shows the summary as
 * stale. Later marks of the same cycle announce nothing. A Task that is
 * deleted, merged or finished is left alone. The function writes one row and
 * waits for nothing, so any change a summary reads can call it.
 */
export const makeSummaryDirtyMarker = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tasks = yield* taskRepository;

  return (taskId: string): Effect.Effect<void, SqlError> =>
    withTransaction(
      sql,
      Effect.gen(function* () {
        const wake = yield* TaskSummaryWake;
        const { marked, becameStale } = yield* tasks.markSummaryDirty(taskId, yield* nowIso);
        if (marked) yield* afterCommit(wake.wake);
        // The card shows a written summary as current until told otherwise.
        // Only the first mark of a dirty cycle says so; the rest change nothing
        // a client draws.
        if (becameStale) yield* announceTaskCardChange(taskId);
      }),
    );
});
