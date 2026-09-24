/**
 * Reads and writes the `runs` and `run_steps` tables. This module has no
 * policy: which status a run or a step record moves to, and when, is decided
 * by the run engine in the controller daemon.
 *
 * Every write announces the run's id on the `run` live topic once it commits,
 * so a screen that shows the run reads it again.
 *
 * Each status change is guarded in its `WHERE` clause by the statuses it may
 * move from. So a run or a step record can only move forward, even if two
 * writers race, and a finished run is never changed again.
 */
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type {
  FailureReason,
  Run,
  RunOrigin,
  RunStatus,
  StepError,
  StepRecord,
  StepStatus,
  WorkflowDefinition,
} from "@hercule/contract";
import { announce, mintUuid, uuidFromString, uuidToString } from "../db";

/** A run to insert, before it has an id. */
export interface NewRun {
  readonly workflowId: string | null;
  readonly plan: WorkflowDefinition;
  readonly inputs: Record<string, unknown>;
  readonly origin: RunOrigin;
  /** The steps the run starts at. Each gets a pending step record. */
  readonly entryStepIds: ReadonlyArray<string>;
}

/** How a step record ends. */
export type StepEnding =
  | { readonly status: "completed"; readonly output: unknown }
  | { readonly status: "failed"; readonly error: StepError };

/** How a run ends. */
export type RunEnding =
  | { readonly status: "completed" }
  | {
      readonly status: "failed";
      readonly failureReason: FailureReason;
      /** Absent when the run failed outside any step. */
      readonly failedStepId?: string;
    };

/**
 * A step record was asked to end, but it had already ended, for example
 * because its run was cancelled while its action ran. A caller that ends a
 * step together with the action's effect fails its transaction with this, so
 * the effect rolls back too.
 */
export class StepRecordEnded extends Data.TaggedError("StepRecordEnded")<{
  readonly runId: string;
  readonly stepId: string;
}> {}

interface RunRow {
  readonly id: Uint8Array;
  readonly workflow_id: Uint8Array | null;
  readonly plan: string;
  readonly inputs: string;
  readonly origin: string;
  readonly status: RunStatus;
  readonly failure_reason: FailureReason | null;
  readonly failed_step_id: string | null;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly finished_at: string | null;
}

interface StepRow {
  readonly step_id: string;
  readonly iteration: number;
  readonly status: StepStatus;
  readonly output: string | null;
  readonly error: string | null;
  readonly started_at: string | null;
  readonly finished_at: string | null;
}

/** Maps a step row to a `StepRecord`. A NULL column becomes an absent field, not `null`. */
const toStepRecord = (row: StepRow): StepRecord => ({
  stepId: row.step_id,
  iteration: row.iteration,
  status: row.status,
  ...(row.started_at === null ? {} : { startedAt: row.started_at }),
  ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
  ...(row.output === null
    ? {}
    : { output: JSON.parse(row.output) as NonNullable<StepRecord["output"]> }),
  ...(row.error === null ? {} : { error: JSON.parse(row.error) as StepError }),
});

/**
 * Maps a run row and its step rows to a `Run`. The JSON columns are parsed
 * without being decoded again: the run engine wrote them from values that
 * were already validated.
 */
const toRun = (row: RunRow, steps: ReadonlyArray<StepRow>): Run => ({
  id: uuidToString(row.id),
  workflowId: row.workflow_id === null ? null : uuidToString(row.workflow_id),
  plan: JSON.parse(row.plan) as WorkflowDefinition,
  inputs: JSON.parse(row.inputs) as Run["inputs"],
  origin: JSON.parse(row.origin) as RunOrigin,
  status: row.status,
  ...(row.failure_reason === null ? {} : { failureReason: row.failure_reason }),
  ...(row.failed_step_id === null ? {} : { failedStepId: row.failed_step_id }),
  steps: steps.map(toStepRecord),
  createdAt: row.created_at,
  ...(row.started_at === null ? {} : { startedAt: row.started_at }),
  ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const announceChange = (id: string, kind: "created" | "updated"): Effect.Effect<void> =>
    announce({ _tag: "record", topic: "run", id, kind });

  const insertSteps = (
    runId: string,
    stepIds: ReadonlyArray<string>,
    at: string,
  ): Effect.Effect<void, SqlError> =>
    Effect.forEach(
      stepIds,
      (stepId) => sql`
        INSERT INTO run_steps (run_id, step_id, iteration, status, created_at)
        VALUES (${uuidFromString(runId)}, ${stepId}, 1, 'pending', ${at})
      `,
      { discard: true },
    );

  return {
    /** Inserts a pending run and a pending step record for each entry step. Returns the run's id. */
    insert: (run: NewRun, at: string): Effect.Effect<string, SqlError> =>
      Effect.gen(function* () {
        const id = mintUuid();
        yield* sql`
          INSERT INTO runs (id, workflow_id, plan, inputs, origin, status, created_at)
          VALUES (${id},
                  ${run.workflowId === null ? null : uuidFromString(run.workflowId)},
                  ${JSON.stringify(run.plan)}, ${JSON.stringify(run.inputs)},
                  ${JSON.stringify(run.origin)}, 'pending', ${at})
        `;
        const runId = uuidToString(id);
        yield* insertSteps(runId, run.entryStepIds, at);
        yield* announceChange(runId, "created");
        return runId;
      }),

    /**
     * Returns a run with its step records in the order they were created, or
     * `None` if no run has the id. Both reads are one transaction, so the run
     * and its step records are from the same moment.
     */
    read: (id: string): Effect.Effect<Option.Option<Run>, SqlError> =>
      sql.withTransaction(
        Effect.gen(function* () {
          const bytes = uuidFromString(id);
          const rows = yield* sql<RunRow>`SELECT * FROM runs WHERE id = ${bytes}`;
          const row = rows[0];
          if (row === undefined) return Option.none();
          const steps = yield* sql<StepRow>`
          SELECT step_id, iteration, status, output, error, started_at, finished_at
          FROM run_steps WHERE run_id = ${bytes} ORDER BY rowid
        `;
          return Option.some(toRun(row, steps));
        }),
      ),

    /** Returns the ids of every run that is pending or running, the oldest first. */
    listUnfinished: (): Effect.Effect<ReadonlyArray<string>, SqlError> =>
      Effect.map(
        sql<{ readonly id: Uint8Array }>`
          SELECT id FROM runs WHERE status IN ('pending', 'running') ORDER BY created_at, id
        `,
        (rows) => rows.map((row) => uuidToString(row.id)),
      ),

    /** Moves a pending run to running. Does nothing to a run that is not pending. */
    start: (id: string, at: string): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        yield* sql`
          UPDATE runs SET status = 'running', started_at = ${at}
          WHERE id = ${uuidFromString(id)} AND status = 'pending'
        `;
        yield* announceChange(id, "updated");
      }),

    /** Adds a pending step record, at iteration 1, for each step id. */
    insertSteps: (
      runId: string,
      stepIds: ReadonlyArray<string>,
      at: string,
    ): Effect.Effect<void, SqlError> =>
      stepIds.length === 0
        ? Effect.void
        : Effect.andThen(insertSteps(runId, stepIds, at), announceChange(runId, "updated")),

    /** Moves a pending step record to running. Does nothing to a record that is not pending. */
    startStep: (
      runId: string,
      step: { readonly stepId: string; readonly iteration: number },
      at: string,
    ): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        yield* sql`
          UPDATE run_steps SET status = 'running', started_at = ${at}
          WHERE run_id = ${uuidFromString(runId)} AND step_id = ${step.stepId}
            AND iteration = ${step.iteration} AND status = 'pending'
        `;
        yield* announceChange(runId, "updated");
      }),

    /**
     * Ends a pending or running step record. `startedAt` is written only if
     * the record has none yet. Fails with `StepRecordEnded` if the record has
     * already ended.
     */
    finishStep: (
      runId: string,
      step: { readonly stepId: string; readonly iteration: number },
      ending: StepEnding,
      times: { readonly startedAt: string; readonly finishedAt: string },
    ): Effect.Effect<void, SqlError | StepRecordEnded> =>
      Effect.gen(function* () {
        const ended = yield* sql`
          UPDATE run_steps SET
            status = ${ending.status},
            output = ${ending.status === "completed" ? JSON.stringify(ending.output) : null},
            error = ${ending.status === "failed" ? JSON.stringify(ending.error) : null},
            started_at = COALESCE(started_at, ${times.startedAt}),
            finished_at = ${times.finishedAt}
          WHERE run_id = ${uuidFromString(runId)} AND step_id = ${step.stepId}
            AND iteration = ${step.iteration} AND status IN ('pending', 'running')
          RETURNING step_id
        `;
        if (ended.length === 0) {
          return yield* Effect.fail(new StepRecordEnded({ runId, stepId: step.stepId }));
        }
        yield* announceChange(runId, "updated");
      }),

    /** Cancels every step record of a run that is still pending or running. */
    cancelUnfinishedSteps: (runId: string, at: string): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        yield* sql`
          UPDATE run_steps SET status = 'cancelled', finished_at = ${at}
          WHERE run_id = ${uuidFromString(runId)} AND status IN ('pending', 'running')
        `;
        yield* announceChange(runId, "updated");
      }),

    /** Ends a pending or running run. Does nothing to a run that has already ended. */
    finish: (id: string, ending: RunEnding, at: string): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        yield* sql`
          UPDATE runs SET
            status = ${ending.status},
            failure_reason = ${ending.status === "failed" ? ending.failureReason : null},
            failed_step_id = ${ending.status === "failed" ? (ending.failedStepId ?? null) : null},
            finished_at = ${at}
          WHERE id = ${uuidFromString(id)} AND status IN ('pending', 'running')
        `;
        yield* announceChange(id, "updated");
      }),
  };
});

export const runRepository = make;
