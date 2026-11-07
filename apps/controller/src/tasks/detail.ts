/**
 * The details pane's read: `task.readDetail` returns everything the pane of
 * one Task draws, in one reply (spec 09, spec 11).
 *
 * The Task row and its summary are this domain's. The Task's sessions and
 * runs belong to domains that depend on this one, so this domain reaches them
 * through ports the controller daemon implements (ADR 0033): `TaskBoardFacts`
 * for the card's facts and `TaskTrackingRuns` for the runs and their output.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Context from "effect/Context";
import type { SqlError } from "effect/sql/SqlError";
import type { Forbidden, Id, NotFound, TaskDetail, Unauthenticated } from "@hercule/contract";

const make = Effect.sync(() => ({
  /**
   * Returns the details of one Task: the Task in full, the card the board
   * shows for it, its summary when one exists, up to `MAX_DETAIL_SESSIONS` of
   * its sessions (the unfinished first, then newest) with how many it has, up
   * to `MAX_TRACKING_DETAIL_RUNS` of its runs with how many it has, and what
   * the newest run produced.
   *
   * The caller needs `task.read`, `session.query` and `run.query`, because the
   * reply shows a session's open Requests and a run's output. A caller without
   * all three gets `Forbidden`, not a thinner reply. Each is checked before
   * anything is read. A merged Task's id returns the survivor's details.
   *
   * Fails with `NotFound` when the Task does not exist or is deleted. It opens
   * no transaction, so every statement runs on the read-only connection.
   */
  read: (id: Id): Effect.Effect<TaskDetail, Unauthenticated | Forbidden | NotFound | SqlError> =>
    Effect.die(new Error(`not built yet: #1031 (task.readDetail ${id})`)),
}));

/** The details pane's read. */
export class TaskDetails extends Context.Service<TaskDetails, Effect.Success<typeof make>>()(
  "hercule/controller/tasks/TaskDetails",
) {}

export const TaskDetailsLayer: Layer.Layer<TaskDetails> = Layer.effect(TaskDetails)(make);
