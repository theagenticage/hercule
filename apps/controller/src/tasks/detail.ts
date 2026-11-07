/**
 * The details pane's read: `task.readDetail` returns everything the pane of
 * one Task draws, in one reply (spec 09, spec 11).
 *
 * The Task row is this domain's. The Task's sessions and runs belong to
 * domains that depend on this one, so this domain reaches them through ports
 * the controller daemon implements (ADR 0033):
 *
 * - `TaskBoardFacts` for the facts of the card, the same port the board uses;
 * - `TaskTrackingRuns` for the runs and what the newest one produced, the
 *   same port Tracking uses;
 * - `TaskDetailFacts` for the sessions and the number of runs.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import {
  createInvalidStateError,
  createNotFoundError,
  type InvalidState,
  isFinishedStage,
  type Forbidden,
  type Id,
  MAX_DETAIL_SESSIONS,
  type NotFound,
  type Task,
  type TaskDetail,
  type TaskDetailSession,
  type Unauthenticated,
} from "@hercule/contract";
import { requireGrant } from "../actor";
import { buildWorkCard, TaskBoardFacts } from "./board";
import { taskRepository, type BoardTask } from "./repository";
import { TaskTrackingRuns } from "./tracking";
import { shapeTrackingOutput } from "./tracking-output";

export class TaskDetailFacts extends Context.Service<
  TaskDetailFacts,
  {
    /**
     * Returns up to `limit` sessions of the Task, with the number of sessions
     * the Task has. The unfinished sessions come first, then the finished
     * ones, each group newest first. `pinnedSessionId`, when it names a
     * session of the Task, is always among them, in its place in that order.
     * A session's open Requests are the ones the `Session` record shows. It
     * reads no transcript, and the number of statements is fixed, whatever
     * the number of sessions.
     */
    readonly readSessions: (
      taskId: string,
      limit: number,
      pinnedSessionId: string | undefined,
    ) => Effect.Effect<
      { readonly sessions: ReadonlyArray<TaskDetailSession>; readonly total: number },
      SqlError
    >;

    /** Returns how many runs the Task has. */
    readonly countRuns: (taskId: string) => Effect.Effect<number, SqlError>;
  }
>()("hercule/controller/tasks/TaskDetailFacts") {}

const NO_BOARD_CARD =
  "this task is finished (done or dropped), so it has no details to show. Move it back to a board stage first";

const make = Effect.gen(function* () {
  const tasks = yield* taskRepository;
  const cardFacts = yield* TaskBoardFacts;
  const runs = yield* TaskTrackingRuns;
  const detailFacts = yield* TaskDetailFacts;

  /**
   * Reads the live Task `requestedId` stands for, and its card on the board
   * (none when the Task is at `done` or `dropped`). Fails with `NotFound`
   * when there is no such live Task.
   *
   * The two reads are separate statements on a connection that holds no
   * snapshot, so a merge, a stage change or a delete can land between them.
   * Each statement follows a merged id to its survivor by itself, and this
   * reads again when the two answers do not describe one Task at one stage,
   * until they agree. Each retry needs another change to have landed, so the
   * loop ends.
   */
  const readTaskAndCard = (
    requestedId: string,
  ): Effect.Effect<
    { readonly task: Task; readonly boardTask: BoardTask | undefined },
    NotFound | SqlError
  > =>
    Effect.gen(function* () {
      const task = Option.getOrUndefined(yield* tasks.liveOrSurvivor(requestedId));
      if (task === undefined) return yield* Effect.fail(createNotFoundError("no such task"));
      const boardTask = Option.getOrUndefined(yield* tasks.readBoardTask(requestedId));
      const agrees =
        boardTask === undefined
          ? isFinishedStage(task.stage)
          : boardTask.id === task.id && boardTask.stage === task.stage;
      return agrees ? { task, boardTask } : yield* readTaskAndCard(requestedId);
    });

  return {
    /**
     * Returns the details of one Task: the Task in full, the card the board
     * shows for it, up to `MAX_DETAIL_SESSIONS` of its sessions (the
     * unfinished first, then newest, and always the Thread that asks the
     * card's open question) with how many it has, up to
     * `MAX_TRACKING_DETAIL_RUNS` of its runs (oldest first, as Tracking lists
     * them) with how many it has, and what the newest run produced.
     *
     * The caller needs `task.read`, `session.query` and `run.query`, because
     * the reply shows a session's open Requests and a run's output. A caller
     * without all three gets `Forbidden`, not a thinner reply. Each is
     * checked before anything is read.
     *
     * An id of a Task that was merged into another returns the survivor's
     * details, whose `task.id` differs: the pane replaces the id it holds.
     *
     * Fails with `NotFound` when the Task does not exist or is deleted, and
     * with `InvalidState` when it is at `done` or `dropped`: the card has a
     * board stage, and the pane opens from a card. The message of the second
     * case says so.
     *
     * It opens no transaction, so every statement runs on the read-only
     * connection. The number of statements is fixed, whatever the number of
     * sessions and runs, except that the Task and its card are read again when
     * a change lands between them (`readTaskAndCard`). Later statements can
     * still see a newer state than the Task, and the push that change makes
     * brings the next read.
     */
    read: (
      requestedId: Id,
    ): Effect.Effect<
      TaskDetail,
      Unauthenticated | Forbidden | NotFound | InvalidState | SqlError
    > =>
      Effect.gen(function* () {
        yield* requireGrant("task.readDetail");
        yield* requireGrant("session.query");
        yield* requireGrant("run.query");
        const { task, boardTask } = yield* readTaskAndCard(requestedId);
        if (boardTask === undefined) {
          return yield* Effect.fail(createInvalidStateError(NO_BOARD_CARD));
        }
        const id = task.id;
        const [facts] = yield* cardFacts.readFacts([boardTask]);
        const card = buildWorkCard(boardTask, facts!);
        // The card's open question is asked by one Thread, and the pane answers it from that
        // Thread's Requests, so that Thread is listed even when newer sessions would crowd it out.
        const { sessions, total: sessionCount } = yield* detailFacts.readSessions(
          id,
          MAX_DETAIL_SESSIONS,
          card.openQuestion?.sessionId,
        );
        const history = yield* runs.readRunHistory(id);
        const runCount = yield* detailFacts.countRuns(id);
        const output =
          history.agentStep === undefined ? undefined : shapeTrackingOutput(history.agentStep);
        return {
          task,
          card,
          sessions,
          sessionCount,
          runs: history.runs,
          runCount,
          ...(output === undefined ? {} : { output }),
        };
      }),
  };
});

/** The details pane's read. */
export class TaskDetails extends Context.Service<TaskDetails, Effect.Success<typeof make>>()(
  "hercule/controller/tasks/TaskDetails",
) {}

export const TaskDetailsLayer: Layer.Layer<
  TaskDetails,
  never,
  SqlClient.SqlClient | TaskBoardFacts | TaskTrackingRuns | TaskDetailFacts
> = Layer.effect(TaskDetails)(make);
