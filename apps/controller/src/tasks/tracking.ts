/**
 * Tracking's reads: `task.queryTracking` returns every in-progress Task that
 * has a handoff entry, with the facts a client works the Task's state out
 * from, `task.readTracking` returns what the pane of one Task draws, and
 * `task.queryLegs` returns where the work of given handoffs stands
 * (spec 11, `task`; ADR 0046).
 *
 * The Task rows are this domain's. The newest run of each Task and its live
 * runs belong to the runs domain, which depends on this one, so this
 * domain declares what it needs as the `TaskTrackingRuns` port and the
 * controller daemon implements it from the runs repository (ADR 0033).
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import {
  createNotFoundError,
  type Forbidden,
  MAX_TRACKING_STEP_NAME,
  type HandoffLegs,
  type NotFound,
  type RunStatus,
  type TaskTracking as TaskTrackingReading,
  type TrackingDetail,
  type TrackingDetailRun,
  type TrackingRun,
  type Unauthenticated,
} from "@hercule/contract";
import { requireGrant } from "../actor";
import { taskRepository } from "./repository";
import { cutText, shapeTrackingOutput, type CompletedAgentStep } from "./tracking-output";

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

/**
 * The runs the Tracking pane of a Task draws, and the facts of the newest
 * run's ending that its `TrackingOutput` is shaped from.
 */
export interface TrackedRunHistory {
  /** The Task's newest runs, at most `MAX_TRACKING_DETAIL_RUNS`, oldest first. */
  readonly runs: ReadonlyArray<TrackingDetailRun>;
  /** The newest run's last completed agent step, when it completed one. */
  readonly agentStep: CompletedAgentStep | undefined;
  /**
   * The name of the action step the newest run ended on: its `name`, else its
   * action's id. Set only when the newest run completed and its last
   * completed step is an action step. A live run has not ended, and a failed
   * run is explained by its failure, so neither has one.
   */
  readonly endingActionStepName: string | undefined;
}

/** A handoff's run, to read the leg of, with the Task the handoff belongs to. */
export interface HandoffRun {
  readonly runId: string;
  readonly taskId: string;
}

/** The leg that starts at a handoff's run, as the runs describe it. */
export interface LegRuns {
  /** The handoff's run. */
  readonly runId: string;
  /** The workflow of the handoff's run. */
  readonly workflowId: string | null;
  readonly workflowName: string;
  /** The runs of the leg other than the handoff's run. */
  readonly rerunCount: number;
  /** The newest run of the leg, the handoff's run included. */
  readonly latestRun: { readonly id: string; readonly status: RunStatus };
  /** The ids of the leg's pending and running runs, newest first, at most `MAX_LEG_LIVE_RUNS`. */
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

    /**
     * Returns the newest `MAX_TRACKING_DETAIL_RUNS` runs of the Task, oldest
     * first, each with the session of its last agent step, and the facts the
     * newest run's `TrackingOutput` is shaped from. A Task with no run has no runs
     * and no facts. The read is one lookup of the Task's newest runs, never
     * the Task's whole history, and it reads no transcript: only the output
     * of the one agent step the `TrackingOutput` comes from.
     */
    readonly readRunHistory: (taskId: string) => Effect.Effect<TrackedRunHistory, SqlError>;

    /**
     * Returns the name of the workflow of the run `runId`, as it was when the
     * run started, or none when there is no such run. One lookup of the run
     * by its id, whatever the run's age.
     */
    readonly readWorkflowName: (runId: string) => Effect.Effect<Option.Option<string>, SqlError>;

    /**
     * Returns the name of the workflow of each run of `runIds`, as it was when
     * the run started, by run id. A run that does not exist is left out. One
     * lookup of each run by its id.
     */
    readonly readWorkflowNames: (
      runIds: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyMap<string, string>, SqlError>;

    /**
     * Returns the Task each run of `runIds` works on, by run id. A run that
     * works on no Task, or does not exist, is left out. One lookup of each run
     * by its id.
     */
    readonly readTaskIds: (
      runIds: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyMap<string, string>, SqlError>;

    /**
     * Returns the leg that starts at each handoff's run: the run and every run
     * that can be reached from it through the run it re-runs, however many
     * re-runs deep, and that works on the same Task. `taskId` must be the Task
     * the run works on, as `readTaskIds` returns it. A run that does not exist
     * is left out. One recursive statement walks the legs of all the runs, so
     * its work follows the size of the legs asked for, never the Tasks' other
     * runs.
     */
    readonly readLegRuns: (
      handoffRuns: ReadonlyArray<HandoffRun>,
    ) => Effect.Effect<ReadonlyArray<LegRuns>, SqlError>;
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

    /**
     * Returns what the Tracking pane of one Task draws: the Task's first
     * handoff with the name of its workflow, its newest runs, what the newest run's last agent step
     * produced (cut to fit a pane), and the action step that run ended on.
     * Fails with `NotFound` when the Task does not exist, is deleted, or was
     * never handed off, because the pane follows handed-off work only. The
     * handoff's run always exists, so a missing one is read as a Task that was
     * never handed off.
     *
     * The caller needs `task.read` and `run.read`, as for `query`. It opens
     * no transaction, so it reads on the read-only connection.
     *
     * Its size does not follow the Task's history or its output: it holds at
     * most `MAX_TRACKING_DETAIL_RUNS` runs, and the text and values of the
     * output, the step names and the failure causes are cut.
     */
    read: (
      taskId: string,
    ): Effect.Effect<TrackingDetail, Unauthenticated | Forbidden | NotFound | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("task.readTracking");
        yield* requireGrant("run.query");
        const handoff = Option.getOrUndefined(yield* tasks.readFirstHandoff(taskId));
        const workflowName =
          handoff === undefined
            ? undefined
            : Option.getOrUndefined(yield* runs.readWorkflowName(handoff.runId));
        if (handoff === undefined || workflowName === undefined) {
          return yield* Effect.fail(createNotFoundError("no such handed-off task"));
        }
        const history = yield* runs.readRunHistory(taskId);
        const output =
          history.agentStep === undefined ? undefined : shapeTrackingOutput(history.agentStep);
        return {
          firstHandoff: { ...handoff, workflowName },
          runs: history.runs,
          ...(output === undefined ? {} : { output }),
          ...(history.endingActionStepName === undefined
            ? {}
            : {
                endingActionStepName: cutText(history.endingActionStepName, MAX_TRACKING_STEP_NAME),
              }),
        };
      }),

    /**
     * Returns the leg of each run of `runIds` that is the run of a handoff of
     * a Task that is not deleted: the handoff, the runs that re-ran it (the
     * handoff's run plus every run reachable from it through the run it
     * re-runs, on the same Task), and the Task's next handoff, the one that
     * follows by time, then by the order it was appended. The legs come in
     * the order of `runIds`, and a repeated id gives one leg. An id that is not
     * the run of such a handoff is left out: an unknown run, a run of no Task,
     * a run of a deleted Task, and a run that only re-runs a handoff's run.
     *
     * The caller needs `task.queryLegs` and `run.query`, as for `query`. It
     * opens no transaction, so it reads on the read-only connection.
     *
     * Its size is a fixed amount for each leg, whatever the history: the ids
     * of the live runs are capped at `MAX_LEG_LIVE_RUNS`. Its cost follows the
     * runs of the legs asked for, never the Task's other runs or handoffs:
     * each handoff and its next one are found by index, see `listLegHandoffs`
     * and `readLegRuns`.
     */
    queryLegs: (
      runIds: ReadonlyArray<string>,
    ): Effect.Effect<HandoffLegs, Unauthenticated | Forbidden | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("task.queryLegs");
        yield* requireGrant("run.query");
        const asked = [...new Set(runIds)];
        const taskIds = yield* runs.readTaskIds(asked);
        const handoffs = yield* tasks.listLegHandoffs(
          asked.flatMap((runId) => {
            const taskId = taskIds.get(runId);
            return taskId === undefined ? [] : [{ runId, taskId }];
          }),
        );
        const legRuns = new Map(
          (yield* runs.readLegRuns(handoffs.map(({ runId, taskId }) => ({ runId, taskId })))).map(
            (leg) => [leg.runId, leg],
          ),
        );
        // A handoff's run always exists, because runs are never deleted.
        const nextWorkflowNames = yield* runs.readWorkflowNames(
          handoffs.flatMap((handoff) => (handoff.next === undefined ? [] : [handoff.next.runId])),
        );
        const handoffsByRun = new Map(handoffs.map((handoff) => [handoff.runId, handoff]));
        return {
          legs: asked.flatMap((runId) => {
            const handoff = handoffsByRun.get(runId);
            if (handoff === undefined) return [];
            const leg = legRuns.get(runId)!;
            return [
              {
                runId,
                signalId: handoff.signalId,
                taskId: handoff.taskId,
                taskStatus: handoff.taskStatus,
                workflowId: leg.workflowId,
                workflowName: leg.workflowName,
                rerunCount: leg.rerunCount,
                latestRun: leg.latestRun,
                liveRunIds: leg.liveRunIds,
                ...(handoff.next === undefined
                  ? {}
                  : {
                      next: {
                        ...handoff.next,
                        workflowName: nextWorkflowNames.get(handoff.next.runId)!,
                      },
                    }),
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
