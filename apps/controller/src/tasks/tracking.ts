/**
 * Tracking's read: `task.queryTracking` returns every in-progress Task that
 * has a handoff entry, with the facts a client works the Task's state out
 * from (spec 11, `task`; ADR 0046).
 *
 * The Task rows are this domain's. The newest run of each Task and its live
 * runs belong to the runs domain, which depends on this one, so this
 * domain declares what it needs as the `TaskTrackingRuns` port and the
 * controller daemon implements it from the runs repository (ADR 0033).
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type {
  Forbidden,
  TaskTracking as TaskTrackingReading,
  TrackingRun,
  Unauthenticated,
} from "@hercule/contract";
import { requireGrant } from "../actor";
import { taskRepository } from "./repository";

/**
 * The runs Tracking reads of a Task: its newest run, its newest live run when
 * it has one, and the ids of all its live runs, newest first.
 */
export interface TrackedRuns {
  readonly taskId: string;
  readonly latestRun: TrackingRun;
  readonly latestLiveRun?: TrackingRun;
  readonly liveRunIds: ReadonlyArray<string>;
}

export class TaskTrackingRuns extends Context.Service<
  TaskTrackingRuns,
  {
    /**
     * Returns, for each Task in `taskIds` that has a run, its newest run
     * (newest by creation time, then id), its newest run that is pending or
     * running, and the ids of all its pending or running runs, newest first.
     * A Task with no run is left out. The runs are the Task's runs by
     * `taskId`, and the read looks up the newest of each Task rather than
     * reading its history.
     */
    readonly readLatestRuns: (
      taskIds: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<TrackedRuns>, SqlError>;
  }
>()("hercule/controller/tasks/TaskTrackingRuns") {}

const make = Effect.gen(function* () {
  const tasks = yield* taskRepository;
  const runs = yield* TaskTrackingRuns;

  return {
    /**
     * Returns the Tasks Tracking follows: every in-progress Task with a handoff
     * entry. Each row holds the Task's title, its handoffs, its newest run,
     * its newest live run and the ids of all its live runs. A Task with no run is left out: a handoff starts its
     * run in the transaction that tracks the Task, so such a Task does not
     * occur, and it would have no state.
     *
     * The caller needs `task.read` and `run.read`: the rows hold both what
     * `task.query` and what `run.query` give. Any caller that holds both may
     * read it, a session included, because it can already read the same facts
     * from those two operations.
     *
     * It opens no transaction, so every statement runs on the read-only
     * connection and never waits for a writer. A Task may change between two
     * statements, and the push that change makes brings the next read.
     *
     * The reply is not paged: Tracking counts every row, and a row holds one
     * Task's newest handoffs (at most `MAX_TRACKING_HANDOFFS`) and two runs with the ids of the live ones, so
     * its size follows the Tasks in progress, not the work handed off before.
     */
    query: (): Effect.Effect<TaskTrackingReading, Unauthenticated | Forbidden | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("task.queryTracking");
        yield* requireGrant("run.query");
        const tracked = yield* tasks.listTracked();
        const latest = yield* runs.readLatestRuns(tracked.map((task) => task.id));
        const byTask = new Map(latest.map((found) => [found.taskId, found]));
        return {
          rows: tracked.flatMap((task) => {
            const found = byTask.get(task.id);
            return found === undefined
              ? []
              : [
                  {
                    taskId: task.id,
                    title: task.title,
                    handoffs: task.handoffs,
                    latestRun: found.latestRun,
                    ...(found.latestLiveRun === undefined
                      ? {}
                      : { latestLiveRun: found.latestLiveRun }),
                    liveRunIds: found.liveRunIds,
                  },
                ];
          }),
        };
      }),
  };
});

/** The Tracking read. */
export class TaskTracking extends Context.Service<TaskTracking, Effect.Success<typeof make>>()(
  "hercule/controller/tasks/TaskTracking",
) {}

export const TaskTrackingLayer: Layer.Layer<
  TaskTracking,
  never,
  SqlClient.SqlClient | TaskTrackingRuns
> = Layer.effect(TaskTracking)(make);
