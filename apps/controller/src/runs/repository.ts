/**
 * Reads and writes the `runs` and `run_steps` tables. This module has no
 * policy: which status a run or a step record moves to, and when, is decided
 * by the run engine in the controller daemon.
 *
 * Every write announces the run's id on the `run` live topic once it commits,
 * so a screen that shows the run reads it again. The repository announces,
 * rather than the run engine, on purpose: every write to a run goes through
 * here, so no write can forget its announcement.
 *
 * Each status change is guarded in its `WHERE` clause by the statuses it may
 * move from. So a run or a step record can only move forward, even if two
 * writers race, and a finished run is never changed again.
 */
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type {
  FailureReason,
  Run,
  RunOrigin,
  RunFilter,
  RunStatus,
  RunSummary,
  StepError,
  StepRecord,
  StepStatus,
  WorkflowDefinition,
} from "@hercule/contract";
import {
  announce,
  buildKeyset,
  buildPage,
  decodeCursor,
  encodeCursor,
  mintUuid,
  uuidFromString,
  uuidToString,
  type CursorError,
  type CursorScope,
  type Page,
  type PageRequest,
  withTransaction,
} from "../db";

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
export type StepOutcome =
  | { readonly status: "completed"; readonly output: unknown }
  | { readonly status: "failed"; readonly error: StepError };

/** How a run ends. */
export type RunOutcome =
  | { readonly status: "completed" }
  | { readonly status: "cancelled" }
  | {
      readonly status: "failed";
      readonly failureReason: Exclude<FailureReason, "controller-error">;
      readonly failedStepId: string;
    }
  | {
      readonly status: "failed";
      readonly failureReason: "controller-error";
      /** Absent when the run failed outside any step. */
      readonly failedStepId?: string;
    };

/**
 * A step record was asked to start or to end, but it had already ended, for
 * example because its run was cancelled. A caller that ends a step together
 * with the action's effect fails its transaction with this, so the effect
 * rolls back too.
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

/** One page of the run list: how many, where to start, and the filters. */
export interface RunPageRequest extends PageRequest, RunFilter {}

interface SummaryRow {
  readonly id: Uint8Array;
  readonly workflow_id: Uint8Array | null;
  readonly workflow_name: string;
  readonly origin: string;
  readonly status: RunStatus;
  readonly failure_reason: FailureReason | null;
  readonly failed_step_id: string | null;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly finished_at: string | null;
}

/**
 * The actor that started a run, as SQL over the `origin` column: the origin's
 * actor, or `run:<id>` for a run that a step of another run started.
 */
const STARTING_ACTOR = `CASE json_extract(origin, '$.kind')
  WHEN 'action' THEN 'run:' || json_extract(origin, '$.parentRunId')
  ELSE json_extract(origin, '$.actor') END`;

interface StepRow {
  readonly step_id: string;
  readonly iteration: number;
  readonly status: StepStatus;
  readonly output: string | null;
  readonly error: string | null;
  readonly started_at: string | null;
  readonly finished_at: string | null;
}

interface ParentRow {
  readonly parent: string | null;
}

interface ChildRow {
  readonly id: Uint8Array;
  readonly status: RunStatus;
}

/**
 * Returns a column's value, or dies if it is NULL. The engine always writes
 * the column for the status the row has, so a NULL here is a bug, not a state
 * to handle.
 */
const requireColumn = <A extends string>(value: A | null, table: string, column: string): A => {
  if (value === null) throw new Error(`${table}.${column} is NULL for a row whose status needs it`);
  return value;
};

/** Maps a step row to a `StepRecord`. A NULL column becomes an absent field, not `null`. */
const toStepRecord = (row: StepRow): StepRecord => {
  const identity = { stepId: row.step_id, iteration: row.iteration };
  const startedAt = () => requireColumn(row.started_at, "run_steps", "started_at");
  const finishedAt = () => requireColumn(row.finished_at, "run_steps", "finished_at");
  switch (row.status) {
    case "pending":
      return { ...identity, status: "pending" };
    case "running":
      return { ...identity, status: "running", startedAt: startedAt() };
    case "completed":
      return {
        ...identity,
        status: "completed",
        startedAt: startedAt(),
        finishedAt: finishedAt(),
        output: row.output === null ? null : (JSON.parse(row.output) as Schema.Json),
      };
    case "failed":
      return {
        ...identity,
        status: "failed",
        startedAt: startedAt(),
        finishedAt: finishedAt(),
        error: JSON.parse(requireColumn(row.error, "run_steps", "error")) as StepError,
      };
    case "cancelled":
      return {
        ...identity,
        status: "cancelled",
        ...(row.started_at === null ? {} : { startedAt: row.started_at }),
        finishedAt: finishedAt(),
      };
  }
};

/** The columns of a run row that depend on its status. */
interface StatusColumns {
  readonly status: RunStatus;
  readonly failure_reason: FailureReason | null;
  readonly failed_step_id: string | null;
  readonly started_at: string | null;
  readonly finished_at: string | null;
}

/**
 * Parses the status columns of a run row into the fields a run with that
 * status has. A run and a run summary share them.
 */
const parseStatusColumns = (row: StatusColumns) => {
  const startedAt = () => requireColumn(row.started_at, "runs", "started_at");
  const finishedAt = () => requireColumn(row.finished_at, "runs", "finished_at");
  const startedAtIfSet = row.started_at === null ? {} : { startedAt: row.started_at };
  switch (row.status) {
    case "pending":
      return { status: "pending" } as const;
    case "running":
      return { status: "running", startedAt: startedAt() } as const;
    case "completed":
      return { status: "completed", startedAt: startedAt(), finishedAt: finishedAt() } as const;
    case "failed": {
      const failureReason = requireColumn(row.failure_reason, "runs", "failure_reason");
      return failureReason === "controller-error"
        ? ({
            status: "failed",
            failureReason: "controller-error",
            ...(row.failed_step_id === null ? {} : { failedStepId: row.failed_step_id }),
            ...startedAtIfSet,
            finishedAt: finishedAt(),
          } as const)
        : ({
            status: "failed",
            failureReason,
            failedStepId: requireColumn(row.failed_step_id, "runs", "failed_step_id"),
            startedAt: startedAt(),
            finishedAt: finishedAt(),
          } as const);
    }
    case "cancelled":
      return { status: "cancelled", ...startedAtIfSet, finishedAt: finishedAt() } as const;
  }
};

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
  steps: steps.map(toStepRecord),
  createdAt: row.created_at,
  ...parseStatusColumns(row),
});

/** Maps a summary row to a `RunSummary`. */
const toSummary = (row: SummaryRow): RunSummary => ({
  id: uuidToString(row.id),
  workflowId: row.workflow_id === null ? null : uuidToString(row.workflow_id),
  workflowName: row.workflow_name,
  origin: JSON.parse(row.origin) as RunOrigin,
  createdAt: row.created_at,
  ...parseStatusColumns(row),
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
      withTransaction(
        sql,
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

    /**
     * Returns one page of runs, without their plans and step records, sorted
     * by when they were created. Every filter given must hold; `since` and
     * `until` are inclusive.
     */
    list: (request: RunPageRequest): Effect.Effect<Page<RunSummary>, CursorError | SqlError> =>
      Effect.gen(function* () {
        const scope: CursorScope = {
          op: "run.query",
          field: "createdAt",
          direction: request.direction,
        };
        const after =
          request.cursor === undefined
            ? undefined
            : yield* decodeCursor(request.cursor, scope, "string");
        const { keyset, order } = buildKeyset(
          sql,
          ["created_at", "id"],
          after === undefined ? undefined : [after[0], uuidFromString(after[1])],
          request.direction,
        );
        const clauses = [keyset];
        if (request.workflowId !== undefined) {
          clauses.push(sql`workflow_id = ${uuidFromString(request.workflowId)}`);
        }
        if (request.status !== undefined) clauses.push(sql`status = ${request.status}`);
        if (request.since !== undefined) clauses.push(sql`created_at >= ${request.since}`);
        if (request.until !== undefined) clauses.push(sql`created_at <= ${request.until}`);
        if (request.actor !== undefined) {
          clauses.push(sql`${sql.literal(STARTING_ACTOR)} = ${request.actor}`);
        }
        const rows = yield* sql<SummaryRow>`
          SELECT id, workflow_id, json_extract(plan, '$.name') AS workflow_name, origin, status,
                 failure_reason, failed_step_id, created_at, started_at, finished_at
          FROM runs WHERE ${sql.and(clauses)} ${order}
          LIMIT ${request.limit + 1}
        `;
        return yield* buildPage(
          rows,
          request.limit,
          (page) => Effect.succeed(page.map(toSummary)),
          (last) => encodeCursor(scope, last.createdAt, last.id),
        );
      }),

    /** Checks whether a run of the workflow is pending or running. */
    hasUnfinishedRun: (workflowId: string): Effect.Effect<boolean, SqlError> =>
      Effect.map(
        sql`
          SELECT 1 FROM runs
          WHERE workflow_id = ${uuidFromString(workflowId)} AND status IN ('pending', 'running')
          LIMIT 1
        `,
        (rows) => rows.length > 0,
      ),

    /**
     * Returns how deep a run is nested: 1 for a run that no other run started,
     * and one more for each run up the chain of runs whose steps started it.
     * Returns 0 if no run has the id.
     */
    measureNesting: (id: string): Effect.Effect<number, SqlError> =>
      Effect.gen(function* () {
        let depth = 0;
        let current: string | undefined = id;
        while (current !== undefined) {
          const rows: ReadonlyArray<ParentRow> = yield* sql<ParentRow>`
            SELECT json_extract(origin, '$.parentRunId') AS parent
            FROM runs WHERE id = ${uuidFromString(current)}
          `;
          const row = rows[0];
          if (row === undefined) return depth;
          depth += 1;
          current = row.parent ?? undefined;
        }
        return depth;
      }),

    /**
     * Returns the ids of the runs that a run started through its steps, the
     * runs those started, and so on, that are still pending or running. A
     * finished run's own children are included too: a child can outlive the
     * run that started it.
     */
    listUnfinishedDescendants: (id: string): Effect.Effect<ReadonlyArray<string>, SqlError> =>
      Effect.gen(function* () {
        const unfinished: Array<string> = [];
        let parents: ReadonlyArray<string> = [id];
        while (parents.length > 0) {
          // The expression is the one `runs_parent` indexes, so each level is
          // one index lookup per parent.
          const children: ReadonlyArray<ChildRow> = yield* sql<ChildRow>`
            SELECT id, status FROM runs
            WHERE json_extract(origin, '$.parentRunId') IN ${sql.in(parents)}
          `;
          parents = children.map((child) => uuidToString(child.id));
          for (const child of children) {
            if (child.status === "pending" || child.status === "running") {
              unfinished.push(uuidToString(child.id));
            }
          }
        }
        return unfinished;
      }),

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

    /**
     * Moves a pending step record to running. Fails with `StepRecordEnded` if
     * the record is not pending any more, so the caller does not call the
     * step's action for a run that has been cancelled.
     */
    startStep: (
      runId: string,
      step: { readonly stepId: string; readonly iteration: number },
      at: string,
    ): Effect.Effect<void, SqlError | StepRecordEnded> =>
      Effect.gen(function* () {
        const started = yield* sql`
          UPDATE run_steps SET status = 'running', started_at = ${at}
          WHERE run_id = ${uuidFromString(runId)} AND step_id = ${step.stepId}
            AND iteration = ${step.iteration} AND status = 'pending'
          RETURNING step_id
        `;
        if (started.length === 0) {
          return yield* Effect.fail(new StepRecordEnded({ runId, stepId: step.stepId }));
        }
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
      ending: StepOutcome,
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
    finish: (id: string, ending: RunOutcome, at: string): Effect.Effect<void, SqlError> =>
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
