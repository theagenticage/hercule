/**
 * Reads and writes the `runs`, `run_steps` and `run_edge_traversals` tables.
 * This module has no policy: which status a run or a step record moves to,
 * and when, is decided by the run engine (`engine.ts`).
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
  FailedEdge,
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
  WorkspacePolicy,
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
  | {
      readonly status: "completed";
      /** The output of the terminal step that ended the run, when one did. */
      readonly output?: Schema.Json | undefined;
    }
  | {
      readonly status: "cancelled";
      /** Keeps the run's ephemeral workspace for inspection instead of deleting it. */
      readonly keepWorkspace: boolean;
    }
  | {
      readonly status: "failed";
      readonly failureReason: Exclude<FailureReason, "controller-error" | "workspace-failed">;
      readonly failedStepId: string;
      /** The edge the run failed at, when it failed at one. */
      readonly failedEdge?: FailedEdge;
    }
  | {
      readonly status: "failed";
      readonly failureReason: "controller-error" | "workspace-failed";
      /** Absent when the run failed outside any step. */
      readonly failedStepId?: string;
    };

/** One step record of a run: its step and its iteration. */
export interface StepRecordId {
  readonly stepId: string;
  readonly iteration: number;
}

/**
 * A step record that is running in a run pinned to a runner, with what a
 * runner needs to run it again.
 */
export interface PinnedRunningStep {
  readonly runId: string;
  readonly stepId: string;
  readonly iteration: number;
  /** The run's workspace. */
  readonly workspaceId: string;
  /** The id of the step's action in the run's plan. */
  readonly action: string;
  /** The step's input as stored when the record started; absent for a record started before inputs were stored. */
  readonly input?: Schema.Json;
  /** The run's workspace policy, from its plan. */
  readonly workspacePolicy: WorkspacePolicy;
}

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
  readonly runner_id: Uint8Array | null;
  readonly workspace_id: Uint8Array | null;
  readonly status: RunStatus;
  readonly failure_reason: FailureReason | null;
  readonly failed_step_id: string | null;
  readonly failed_edge_index: number | null;
  readonly failure_message: string | null;
  readonly output: string | null;
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
  readonly input: string | null;
  readonly output: string | null;
  readonly error: string | null;
  readonly started_at: string | null;
  readonly finished_at: string | null;
}

interface TraversalRow {
  readonly edge_index: number;
  readonly count: number;
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
  const identity = {
    stepId: row.step_id,
    iteration: row.iteration,
    ...(row.input === null ? {} : { input: JSON.parse(row.input) as Schema.Json }),
  };
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
    case "skipped":
      return { ...identity, status: "skipped", finishedAt: finishedAt() };
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
      const failedStepIdIfSet =
        row.failed_step_id === null ? {} : { failedStepId: row.failed_step_id };
      switch (failureReason) {
        case "controller-error":
          return {
            status: "failed",
            failureReason,
            ...failedStepIdIfSet,
            ...startedAtIfSet,
            finishedAt: finishedAt(),
          } as const;
        case "workspace-failed":
          return {
            status: "failed",
            failureReason,
            ...failedStepIdIfSet,
            startedAt: startedAt(),
            finishedAt: finishedAt(),
          } as const;
        default:
          return {
            status: "failed",
            failureReason,
            failedStepId: requireColumn(row.failed_step_id, "runs", "failed_step_id"),
            startedAt: startedAt(),
            finishedAt: finishedAt(),
          } as const;
      }
    }
    case "cancelled":
      return { status: "cancelled", ...startedAtIfSet, finishedAt: finishedAt() } as const;
  }
};

/**
 * Parses the status columns of a run row as `parseStatusColumns` does, and
 * adds the fields that follow from the status in a run but not in a run
 * summary:
 *
 * - a completed run has an `output` only when its `output` column is set; a
 *   JSON `null` output is a set column;
 * - a run failed at a step has a `failedEdge` only when its
 *   `failed_edge_index` column is set. The engine writes that column and
 *   `failure_message` together.
 */
const parseRunStatusColumns = (row: RunRow) => {
  const status = parseStatusColumns(row);
  if (status.status === "completed" && row.output !== null) {
    return { ...status, output: JSON.parse(row.output) as Schema.Json };
  }
  if (
    status.status === "failed" &&
    status.failureReason !== "controller-error" &&
    status.failureReason !== "workspace-failed" &&
    row.failed_edge_index !== null
  ) {
    const message = requireColumn(row.failure_message, "runs", "failure_message");
    return { ...status, failedEdge: { index: row.failed_edge_index, message } };
  }
  return status;
};

/**
 * Maps a run row, its step rows and its traversal rows to a `Run`. The JSON
 * columns are parsed without being decoded again: the run engine wrote them
 * from values that were already validated. An edge with no traversal row
 * has been followed 0 times.
 */
const toRun = (
  row: RunRow,
  steps: ReadonlyArray<StepRow>,
  traversals: ReadonlyArray<TraversalRow>,
): Run => {
  const plan = JSON.parse(row.plan) as WorkflowDefinition;
  const edgeTraversals = (plan.edges ?? []).map(() => 0);
  for (const traversal of traversals) edgeTraversals[traversal.edge_index] = traversal.count;
  return {
    id: uuidToString(row.id),
    workflowId: row.workflow_id === null ? null : uuidToString(row.workflow_id),
    plan,
    inputs: JSON.parse(row.inputs) as Run["inputs"],
    origin: JSON.parse(row.origin) as RunOrigin,
    ...(row.runner_id === null ? {} : { runnerId: uuidToString(row.runner_id) }),
    ...(row.workspace_id === null ? {} : { workspaceId: uuidToString(row.workspace_id) }),
    steps: steps.map(toStepRecord),
    edgeTraversals,
    createdAt: row.created_at,
    ...parseRunStatusColumns(row),
  };
};

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
        SELECT ${uuidFromString(runId)}, ${stepId}, COALESCE(MAX(iteration), 0) + 1, 'pending', ${at}
        FROM run_steps WHERE run_id = ${uuidFromString(runId)} AND step_id = ${stepId}
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
     * Returns a run with its step records in the order they were created and
     * its edge traversal counts, or `None` if no run has the id. The reads are
     * one transaction, so they are all from the same moment.
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
            SELECT step_id, iteration, status, input, output, error, started_at, finished_at
            FROM run_steps WHERE run_id = ${bytes} ORDER BY rowid
          `;
          const traversals = yield* sql<TraversalRow>`
            SELECT edge_index, count FROM run_edge_traversals WHERE run_id = ${bytes}
          `;
          return Option.some(toRun(row, steps, traversals));
        }),
      ),

    /**
     * Returns whether the user who cancelled a run chose to keep its
     * workspace. It is `false` for a run that was not cancelled, and for an
     * unknown id.
     */
    keepsWorkspace: (id: string): Effect.Effect<boolean, SqlError> =>
      Effect.map(
        sql<{ readonly keep_workspace: number }>`
          SELECT keep_workspace FROM runs WHERE id = ${uuidFromString(id)}
        `,
        (rows) => rows[0]?.keep_workspace === 1,
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

    /**
     * Adds a pending step record for each step id, in the order given. Each
     * record's iteration is one more than the step's latest record in the run,
     * or 1 for the step's first record.
     */
    insertSteps: (
      runId: string,
      stepIds: ReadonlyArray<string>,
      at: string,
    ): Effect.Effect<void, SqlError> =>
      stepIds.length === 0
        ? Effect.void
        : Effect.andThen(insertSteps(runId, stepIds, at), announceChange(runId, "updated")),

    /**
     * Moves a pending step record to running, and stores the step's input:
     * its params rendered and checked against the action's input schema.
     * Fails with `StepRecordEnded` if the record is not pending any more, so
     * the caller does not call the step's action for a run that has been
     * cancelled.
     */
    startStep: (
      runId: string,
      step: StepRecordId,
      input: Schema.Json,
      at: string,
    ): Effect.Effect<void, SqlError | StepRecordEnded> =>
      Effect.gen(function* () {
        const started = yield* sql`
          UPDATE run_steps SET status = 'running', started_at = ${at},
                               input = ${JSON.stringify(input)}
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

    /**
     * Moves a pending step record to skipped. Fails with `StepRecordEnded` if
     * the record is not pending any more.
     */
    skipStep: (
      runId: string,
      step: { readonly stepId: string; readonly iteration: number },
      at: string,
    ): Effect.Effect<void, SqlError | StepRecordEnded> =>
      Effect.gen(function* () {
        const skipped = yield* sql`
          UPDATE run_steps SET status = 'skipped', finished_at = ${at}
          WHERE run_id = ${uuidFromString(runId)} AND step_id = ${step.stepId}
            AND iteration = ${step.iteration} AND status = 'pending'
          RETURNING step_id
        `;
        if (skipped.length === 0) {
          return yield* Effect.fail(new StepRecordEnded({ runId, stepId: step.stepId }));
        }
        yield* announceChange(runId, "updated");
      }),

    /**
     * Adds 1 to the number of times a run has followed each edge, by the
     * edge's index in the plan's edges. Each index appears at most once.
     */
    recordTraversals: (
      runId: string,
      edgeIndexes: ReadonlyArray<number>,
    ): Effect.Effect<void, SqlError> =>
      edgeIndexes.length === 0
        ? Effect.void
        : Effect.andThen(
            // SQLite needs the `WHERE true` to parse an upsert whose rows
            // come from a SELECT.
            sql`
              INSERT INTO run_edge_traversals (run_id, edge_index, count)
              SELECT ${uuidFromString(runId)}, value, 1 FROM json_each(${JSON.stringify(edgeIndexes)})
              WHERE true
              ON CONFLICT (run_id, edge_index) DO UPDATE SET count = count + 1
            `,
            announceChange(runId, "updated"),
          ),

    /**
     * Cancels every step record of a run that is still pending or running.
     * Returns the records that were running, because whatever runs them may
     * have to be told to stop.
     */
    cancelUnfinishedSteps: (
      runId: string,
      at: string,
    ): Effect.Effect<ReadonlyArray<StepRecordId>, SqlError> =>
      Effect.gen(function* () {
        const cancelled = yield* sql<{
          readonly step_id: string;
          readonly iteration: number;
          readonly started_at: string | null;
        }>`
          UPDATE run_steps SET status = 'cancelled', finished_at = ${at}
          WHERE run_id = ${uuidFromString(runId)} AND status IN ('pending', 'running')
          RETURNING step_id, iteration, started_at
        `;
        yield* announceChange(runId, "updated");
        // Only a running record has started, so the start time tells the
        // two apart after the update.
        return cancelled
          .filter((row) => row.started_at !== null)
          .map((row) => ({ stepId: row.step_id, iteration: row.iteration }));
      }),

    /**
     * Pins a running run to a runner and to its workspace there. Every later
     * step of the run that works in a workspace runs in this one. Does nothing
     * to a run that is not running or is already pinned.
     */
    pin: (
      runId: string,
      pinned: { readonly runnerId: string; readonly workspaceId: string },
    ): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        yield* sql`
          UPDATE runs SET runner_id = ${uuidFromString(pinned.runnerId)},
                          workspace_id = ${uuidFromString(pinned.workspaceId)}
          WHERE id = ${uuidFromString(runId)} AND status = 'running' AND runner_id IS NULL
        `;
        yield* announceChange(runId, "updated");
      }),

    /**
     * Returns the ids of the running runs pinned to a runner. The query names
     * `runs.status = 'running'` so SQLite reads the `runs_pinned_running`
     * index.
     */
    listPinnedTo: (runnerId: string): Effect.Effect<ReadonlyArray<string>, SqlError> =>
      Effect.map(
        sql<{ readonly id: Uint8Array }>`
          SELECT id FROM runs
          WHERE runner_id = ${uuidFromString(runnerId)} AND runs.status = 'running'
          ORDER BY created_at, id
        `,
        (rows) => rows.map((row) => uuidToString(row.id)),
      ),

    /**
     * Returns the ids of the running runs that work in a workspace. A run is
     * found through its runner first, so SQLite reads the
     * `runs_pinned_running` index rather than every run.
     */
    listWorkingIn: (workspaceId: string): Effect.Effect<ReadonlyArray<string>, SqlError> =>
      Effect.map(
        sql<{ readonly id: Uint8Array }>`
          SELECT id FROM runs
          WHERE runner_id = (SELECT runner_id FROM workspaces
                             WHERE id = ${uuidFromString(workspaceId)})
            AND runs.status = 'running' AND workspace_id = ${uuidFromString(workspaceId)}
        `,
        (rows) => rows.map((row) => uuidToString(row.id)),
      ),

    /**
     * Returns the ids of the running runs that have a workspace in their plan
     * but no runner pinned yet. Their next workspace step may be waiting for a
     * runner to place it on.
     */
    listUnpinnedWithWorkspace: (): Effect.Effect<ReadonlyArray<string>, SqlError> =>
      Effect.map(
        sql<{ readonly id: Uint8Array }>`
          SELECT id FROM runs
          WHERE runner_id IS NULL AND runs.status = 'running'
            AND json_extract(plan, '$.workspace') IS NOT NULL
          ORDER BY created_at, id
        `,
        (rows) => rows.map((row) => uuidToString(row.id)),
      ),

    /**
     * Returns every running step record in the running runs pinned to a
     * runner, with the action its step calls and its stored input. The caller
     * picks out the records of workspace steps.
     */
    listRunningStepsPinnedTo: (
      runnerId: string,
    ): Effect.Effect<ReadonlyArray<PinnedRunningStep>, SqlError> =>
      Effect.map(
        sql<{
          readonly run_id: Uint8Array;
          readonly workspace_id: Uint8Array;
          readonly step_id: string;
          readonly iteration: number;
          readonly action: string | null;
          readonly input: string | null;
          readonly workspace_policy: string;
        }>`
          SELECT s.run_id, r.workspace_id, s.step_id, s.iteration, s.input,
                 json_extract(r.plan, '$.workspace') AS workspace_policy,
                 (SELECT json_extract(step.value, '$.action')
                  FROM json_each(r.plan, '$.steps') AS step
                  WHERE json_extract(step.value, '$.id') = s.step_id) AS action
          FROM runs r JOIN run_steps s ON s.run_id = r.id
          WHERE r.runner_id = ${uuidFromString(runnerId)} AND r.status = 'running'
            AND r.workspace_id IS NOT NULL AND s.status = 'running'
          ORDER BY r.created_at, s.rowid
        `,
        (rows) =>
          rows.flatMap((row) =>
            row.action === null
              ? []
              : [
                  {
                    runId: uuidToString(row.run_id),
                    stepId: row.step_id,
                    iteration: row.iteration,
                    workspaceId: uuidToString(row.workspace_id),
                    action: row.action,
                    ...(row.input === null ? {} : { input: JSON.parse(row.input) as Schema.Json }),
                    workspacePolicy: JSON.parse(row.workspace_policy) as WorkspacePolicy,
                  },
                ],
          ),
      ),

    /** Ends a pending or running run. Does nothing to a run that has already ended. */
    finish: (id: string, ending: RunOutcome, at: string): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        const failedEdge =
          ending.status === "failed" && "failedEdge" in ending ? ending.failedEdge : undefined;
        yield* sql`
          UPDATE runs SET
            status = ${ending.status},
            failure_reason = ${ending.status === "failed" ? ending.failureReason : null},
            failed_step_id = ${ending.status === "failed" ? (ending.failedStepId ?? null) : null},
            failed_edge_index = ${failedEdge?.index ?? null},
            failure_message = ${failedEdge?.message ?? null},
            output = ${ending.status === "completed" && ending.output !== undefined ? JSON.stringify(ending.output) : null},
            keep_workspace = ${ending.status === "cancelled" && ending.keepWorkspace ? 1 : 0},
            finished_at = ${at}
          WHERE id = ${uuidFromString(id)} AND status IN ('pending', 'running')
        `;
        yield* announceChange(id, "updated");
      }),
  };
});

export const runRepository = make;
