/**
 * The runs of a Task, as the details pane and the Task's summary read them.
 *
 * The runs belong to the runs domain, which depends on this one, so this
 * domain declares what it needs as the `TaskRuns` port and the controller
 * daemon implements it from the runs repository (ADR 0033).
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { SqlError } from "effect/sql/SqlError";
import type { TaskDetailRun } from "@hercule/contract";

export class TaskRuns extends Context.Service<
  TaskRuns,
  {
    /**
     * Returns the newest `MAX_DETAIL_RUNS` runs of the Task, oldest first,
     * each with why it failed when it failed and the session of its last
     * agent step. A Task with no run returns an empty list. The read is one
     * lookup of the Task's newest runs, never the Task's whole history, and
     * it reads no transcript.
     */
    readonly readRunHistory: (
      taskId: string,
    ) => Effect.Effect<ReadonlyArray<TaskDetailRun>, SqlError>;
  }
>()("hercule/controller/tasks/TaskRuns") {}
