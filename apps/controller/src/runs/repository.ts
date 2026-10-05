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
  TriggerEvent,
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
  /** The run this one re-runs, when `run.rerun` starts it. */
  readonly originalRunId?: string;
  /** The event that started the run, when a start trigger started it. */
  readonly triggerEvent?: TriggerEvent;
}

/** How a step record ends. */
export type StepOutcome =
  | { readonly status: "completed"; readonly output: unknown }
  | { readonly status: "failed"; readonly error: StepError };

/**
 * Why a run that passed its start checks can fail: every reason but
 * `validation-error`, which only a run that failed those checks has.
 */
export type ExecutionFailureReason = Exclude<FailureReason, "validation-error">;

/** How a run ends. */
export type RunOutcome =
  | {
      readonly status: "completed";
      /** The output of the terminal step that ended the run, when one did. */
      readonly output?: Schema.Json | undefined;
    }
  | {
      readonly status: "cancelled";
      /** Releases the run's workspace lease as `inspection`, so an ephemeral workspace is kept for a look, rather than as `none`. */
      readonly keepWorkspace: boolean;
    }
  | {
      readonly status: "failed";
      readonly failureReason: "validation-error";
      /** What did not validate, a sentence for a person. */
      readonly failureMessage: string;
    }
  | {
      readonly status: "failed";
      readonly failureReason: Exclude<
        ExecutionFailureReason,
        "controller-error" | "workspace-failed"
      >;
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
 * A step record that is running in a run pinned to a runner, with what the
 * runner needs to run it again, or to report how it ended:
 *
 * - `action`: an action step, with its action, its stored input and the
 *   run's workspace policy;
 * - `agent`: an agent step, with whether its prompt is still waiting in
 *   its session, not sent to the runner yet.
 */
export type PinnedRunningStep = {
  readonly runId: string;
  readonly stepId: string;
  readonly iteration: number;
  /** The run's workspace, or null for a run that has none. */
  readonly workspaceId: string | null;
} & (
  | {
      readonly kind: "action";
      /** The id of the step's action in the run's plan. */
      readonly action: string;
      /** The step's input as stored when the record started. Every action step's record stores one. */
      readonly input?: Schema.Json;
      /** The run's workspace policy, from its plan, or undefined for a run with no workspace. */
      readonly workspacePolicy: WorkspacePolicy | undefined;
    }
  | {
      readonly kind: "agent";
      /** Whether the step's prompt for this iteration is a queued input not yet sent to the runner. */
      readonly promptWaiting: boolean;
    }
);

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
  readonly original_run_id: Uint8Array | null;
  readonly trigger_event: string | null;
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
  readonly failure_message: string | null;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly finished_at: string | null;
}

/**
 * The actor that started a run, as SQL over the `origin` column:
 *
 * - `run:<id>` for a run that a step of another run started;
 * - `system` for a run that a start trigger started, because the controller
 *   started it on nobody's behalf;
 * - the origin's actor for any other run.
 */
const STARTING_ACTOR = `CASE json_extract(origin, '$.kind')
  WHEN 'action' THEN 'run:' || json_extract(origin, '$.parentRunId')
  WHEN 'trigger' THEN 'system'
  ELSE json_extract(origin, '$.actor') END`;

interface StepRow {
  readonly step_id: string;
  readonly iteration: number;
  readonly status: StepStatus;
  readonly input: string | null;
  readonly session_id: Uint8Array | null;
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

/** Parses a step row into a `StepRecord`. A NULL column becomes an absent field, not `null`. */
const parseStepRow = (row: StepRow): StepRecord => {
  const identity = {
    stepId: row.step_id,
    iteration: row.iteration,
    ...(row.input === null ? {} : { input: JSON.parse(row.input) as Schema.Json }),
    ...(row.session_id === null ? {} : { sessionId: uuidToString(row.session_id) }),
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
  readonly failure_message: string | null;
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
        case "validation-error":
          return {
            status: "failed",
            failureReason,
            failureMessage: requireColumn(row.failure_message, "runs", "failure_message"),
            finishedAt: finishedAt(),
          } as const;
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
    status.failureReason !== "validation-error" &&
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
 * A run as the runs tables store it: a `Run` without its live
 * subscriptions, which the subscriptions domain stores. `RunService.read`
 * adds them, for the API; the run engine never reads them.
 */
export type StoredRun = Run extends infer Variant
  ? Variant extends unknown
    ? Omit<Variant, "subscriptions">
    : never
  : never;

/**
 * Parses a run row, its step rows and its traversal rows into a
 * `StoredRun`. The JSON columns are parsed without being decoded again: the
 * run engine wrote them from values that were already validated. An edge
 * with no traversal row has been followed 0 times.
 */
const parseRunRow = (
  row: RunRow,
  steps: ReadonlyArray<StepRow>,
  traversals: ReadonlyArray<TraversalRow>,
): StoredRun => {
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
    steps: steps.map(parseStepRow),
    edgeTraversals,
    ...(row.original_run_id === null ? {} : { originalRunId: uuidToString(row.original_run_id) }),
    ...(row.trigger_event === null
      ? {}
      : { triggerEvent: JSON.parse(row.trigger_event) as TriggerEvent }),
    createdAt: row.created_at,
    ...parseRunStatusColumns(row),
  };
};

/** Parses a summary row into a `RunSummary`. */
const parseSummaryRow = (row: SummaryRow): RunSummary => ({
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
          INSERT INTO runs
            (id, workflow_id, plan, inputs, origin, original_run_id, trigger_event, status, created_at)
          VALUES (${id},
                  ${run.workflowId === null ? null : uuidFromString(run.workflowId)},
                  ${JSON.stringify(run.plan)}, ${JSON.stringify(run.inputs)},
                  ${JSON.stringify(run.origin)},
                  ${run.originalRunId === undefined ? null : uuidFromString(run.originalRunId)},
                  ${run.triggerEvent === undefined ? null : JSON.stringify(run.triggerEvent)},
                  'pending', ${at})
        `;
        const runId = uuidToString(id);
        yield* insertSteps(runId, run.entryStepIds, at);
        yield* announceChange(runId, "created");
        return runId;
      }),

    /**
     * Returns a run with its step records in the order they were created and
     * its edge traversal counts, or `None` if no run has the id. The reads are one transaction, so they are all from the
     * same moment.
     */
    read: (id: string): Effect.Effect<Option.Option<StoredRun>, SqlError> =>
      withTransaction(
        sql,
        Effect.gen(function* () {
          const bytes = uuidFromString(id);
          const rows = yield* sql<RunRow>`SELECT * FROM runs WHERE id = ${bytes}`;
          const row = rows[0];
          if (row === undefined) return Option.none();
          const steps = yield* sql<StepRow>`
            SELECT step_id, iteration, status, input, session_id, output, error, started_at,
                   finished_at
            FROM run_steps WHERE run_id = ${bytes} ORDER BY rowid
          `;
          const traversals = yield* sql<TraversalRow>`
            SELECT edge_index, count FROM run_edge_traversals WHERE run_id = ${bytes}
          `;
          return Option.some(parseRunRow(row, steps, traversals));
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
          sort: [{ field: "createdAt", direction: request.direction }],
        };
        const after =
          request.cursor === undefined
            ? undefined
            : yield* decodeCursor(request.cursor, scope, ["string"]);
        const { keyset, order } = buildKeyset(
          sql,
          [{ column: "created_at", direction: request.direction }],
          ["id"],
          after === undefined ? undefined : [...after.values, uuidFromString(after.id)],
        );
        const clauses = [keyset];
        if (request.workflowId !== undefined) {
          clauses.push(sql`workflow_id = ${uuidFromString(request.workflowId)}`);
        }
        if (request.status !== undefined) clauses.push(sql`status = ${request.status}`);
        if (request.originalRunId !== undefined) {
          clauses.push(sql`original_run_id = ${uuidFromString(request.originalRunId)}`);
        }
        if (request.since !== undefined) clauses.push(sql`created_at >= ${request.since}`);
        if (request.until !== undefined) clauses.push(sql`created_at <= ${request.until}`);
        if (request.actor !== undefined) {
          clauses.push(sql`${sql.literal(STARTING_ACTOR)} = ${request.actor}`);
        }
        const rows = yield* sql<SummaryRow>`
          SELECT id, workflow_id, json_extract(plan, '$.name') AS workflow_name, origin, status,
                 failure_reason, failed_step_id, failure_message, created_at, started_at,
                 finished_at
          FROM runs WHERE ${sql.and(clauses)} ${order}
          LIMIT ${request.limit + 1}
        `;
        return yield* buildPage(
          rows,
          request.limit,
          (page) => Effect.succeed(page.map(parseSummaryRow)),
          (last) => encodeCursor(scope, [last.createdAt], last.id),
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
     * Adds a pending step record for a signal trigger that an event fired,
     * holding the signal's output and the event's id. Its iteration is one
     * more than the trigger's latest record in the run. Returns whether a
     * record was added: an event fires a signal trigger at most once per run,
     * so the same event routed again, after it was enriched, adds nothing.
     *
     * The record stays pending until the run's execution completes it (see
     * `completeSignalStep`), so the routing pass that matched the event never
     * routes the run itself.
     */
    insertSignalStep: (
      runId: string,
      signal: {
        readonly triggerId: string;
        readonly eventId: number;
        readonly output: Schema.Json;
      },
      at: string,
    ): Effect.Effect<boolean, SqlError> =>
      Effect.gen(function* () {
        const bytes = uuidFromString(runId);
        const inserted = yield* sql`
          INSERT INTO run_steps (run_id, step_id, iteration, status, output, event_id, created_at)
          SELECT ${bytes}, ${signal.triggerId}, COALESCE(MAX(iteration), 0) + 1, 'pending',
                 ${JSON.stringify(signal.output)}, ${signal.eventId}, ${at}
          FROM run_steps WHERE run_id = ${bytes} AND step_id = ${signal.triggerId}
          ON CONFLICT (run_id, step_id, event_id) WHERE event_id IS NOT NULL DO NOTHING
          RETURNING step_id
        `;
        if (inserted.length === 0) return false;
        yield* announceChange(runId, "updated");
        return true;
      }),

    /**
     * Moves a signal trigger's pending step record to completed, keeping the
     * output `insertSignalStep` stored on it. A signal does no work, so the
     * record starts and finishes at the same moment. Fails with
     * `StepRecordEnded` if the record is not pending any more, for example
     * because its run has ended.
     */
    completeSignalStep: (
      runId: string,
      step: StepRecordId,
      at: string,
    ): Effect.Effect<void, SqlError | StepRecordEnded> =>
      Effect.gen(function* () {
        const completed = yield* sql`
          UPDATE run_steps SET status = 'completed', started_at = ${at}, finished_at = ${at}
          WHERE run_id = ${uuidFromString(runId)} AND step_id = ${step.stepId}
            AND iteration = ${step.iteration} AND status = 'pending'
          RETURNING step_id
        `;
        if (completed.length === 0) {
          return yield* Effect.fail(new StepRecordEnded({ runId, stepId: step.stepId }));
        }
        yield* announceChange(runId, "updated");
      }),

    /**
     * Moves a pending step record to running, and stores what it started
     * with:
     *
     * - for an action step, its input: the params rendered and checked
     *   against the action's input schema;
     * - for an agent step, the session that runs it.
     *
     * Fails with `StepRecordEnded` if the record is not pending any more, so
     * the caller does not start the step for a run that has been cancelled.
     */
    startStep: (
      runId: string,
      step: StepRecordId,
      started: { readonly input: Schema.Json } | { readonly sessionId: string },
      at: string,
    ): Effect.Effect<void, SqlError | StepRecordEnded> =>
      Effect.gen(function* () {
        const input = "input" in started ? JSON.stringify(started.input) : null;
        const session = "sessionId" in started ? uuidFromString(started.sessionId) : null;
        const updated = yield* sql`
          UPDATE run_steps SET status = 'running', started_at = ${at},
                               input = ${input}, session_id = ${session}
          WHERE run_id = ${uuidFromString(runId)} AND step_id = ${step.stepId}
            AND iteration = ${step.iteration} AND status = 'pending'
          RETURNING step_id
        `;
        if (updated.length === 0) {
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
     * Pins a running run to a runner, and to its workspace there when it has
     * one. Every later step of the run that runs on a runner runs on this
     * one, in this workspace. Does nothing to a run that is not running or is
     * already pinned.
     */
    pin: (
      runId: string,
      pinned: { readonly runnerId: string; readonly workspaceId: string | null },
    ): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        const workspace = pinned.workspaceId === null ? null : uuidFromString(pinned.workspaceId);
        yield* sql`
          UPDATE runs SET runner_id = ${uuidFromString(pinned.runnerId)}, workspace_id = ${workspace}
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
     * Returns the ended runs that still have a session running on a runner,
     * oldest first. The query names the session statuses of the
     * `sessions_running` index, so SQLite reads that index rather than every
     * session.
     */
    listEndedWithSessionsRunningOn: (
      runnerId: string,
    ): Effect.Effect<ReadonlyArray<Pick<Run, "id" | "workflowId">>, SqlError> =>
      Effect.map(
        sql<{ readonly id: Uint8Array; readonly workflow_id: Uint8Array | null }>`
          SELECT runs.id, runs.workflow_id FROM runs
          WHERE runs.status NOT IN ('pending', 'running')
            AND runs.id IN (SELECT run_id FROM sessions
                            WHERE runner_id = ${uuidFromString(runnerId)}
                              AND status IN ('starting', 'idle', 'busy'))
          ORDER BY runs.created_at, runs.id
        `,
        (rows) =>
          rows.map((row) => ({
            id: uuidToString(row.id),
            workflowId: row.workflow_id === null ? null : uuidToString(row.workflow_id),
          })),
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
     * Returns the ids of the runs that may be waiting for a runner: running
     * runs that are not pinned to a runner yet, whose plan has a workspace or
     * an agent step. Their first step that runs on a runner either waits for
     * a runner to place it on, or has not been reached.
     */
    listRunsWaitingForRunner: (): Effect.Effect<ReadonlyArray<string>, SqlError> =>
      Effect.map(
        sql<{ readonly id: Uint8Array }>`
          SELECT id FROM runs
          WHERE runner_id IS NULL AND runs.status = 'running'
            AND (json_extract(plan, '$.workspace') IS NOT NULL
                 OR EXISTS (SELECT 1 FROM json_each(plan, '$.steps') AS step
                            WHERE json_extract(step.value, '$.kind') = 'agent'))
          ORDER BY created_at, id
        `,
        (rows) => rows.map((row) => uuidToString(row.id)),
      ),

    /**
     * Returns every running step record in the running runs pinned to a
     * runner, with what its step is (see `PinnedRunningStep`). A step that is
     * neither an action step nor an agent step is left out. The caller picks
     * out the records of the steps that run on a runner.
     */
    listRunningStepsPinnedTo: (
      runnerId: string,
    ): Effect.Effect<ReadonlyArray<PinnedRunningStep>, SqlError> =>
      Effect.map(
        sql<{
          readonly run_id: Uint8Array;
          readonly workspace_id: Uint8Array | null;
          readonly step_id: string;
          readonly iteration: number;
          readonly kind: string | null;
          readonly action: string | null;
          readonly input: string | null;
          readonly session_id: Uint8Array | null;
          readonly prompt_waiting: number;
          readonly workspace_policy: string | null;
        }>`
          SELECT s.run_id, r.workspace_id, s.step_id, s.iteration, s.input, s.session_id,
                 json_extract(r.plan, '$.workspace') AS workspace_policy,
                 json_extract(step.value, '$.kind') AS kind,
                 json_extract(step.value, '$.action') AS action,
                 EXISTS (SELECT 1 FROM session_inputs AS prompt
                         WHERE prompt.session_id = s.session_id
                           AND prompt.step_iteration = s.iteration
                           AND prompt.status = 'queued' AND prompt.sent_at IS NULL)
                   AS prompt_waiting
          FROM runs r
            JOIN run_steps s ON s.run_id = r.id
            JOIN json_each(r.plan, '$.steps') AS step
              ON json_extract(step.value, '$.id') = s.step_id
          WHERE r.runner_id = ${uuidFromString(runnerId)} AND r.status = 'running'
            AND s.status = 'running'
          ORDER BY r.created_at, s.rowid
        `,
        (rows) =>
          rows.flatMap((row): ReadonlyArray<PinnedRunningStep> => {
            const record = {
              runId: uuidToString(row.run_id),
              stepId: row.step_id,
              iteration: row.iteration,
              workspaceId: row.workspace_id === null ? null : uuidToString(row.workspace_id),
            };
            if (row.kind === "agent" && row.session_id !== null) {
              return [
                {
                  ...record,
                  kind: "agent",
                  promptWaiting: row.prompt_waiting === 1,
                },
              ];
            }
            if (row.kind !== "action" || row.action === null) return [];
            return [
              {
                ...record,
                kind: "action",
                action: row.action,
                ...(row.input === null ? {} : { input: JSON.parse(row.input) as Schema.Json }),
                workspacePolicy:
                  row.workspace_policy === null
                    ? undefined
                    : (JSON.parse(row.workspace_policy) as WorkspacePolicy),
              },
            ];
          }),
      ),

    /** Ends a pending or running run. Does nothing to a run that has already ended. */
    finish: (id: string, ending: RunOutcome, at: string): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        const failedEdge =
          ending.status === "failed" && "failedEdge" in ending ? ending.failedEdge : undefined;
        const failureMessage =
          ending.status === "failed" && ending.failureReason === "validation-error"
            ? ending.failureMessage
            : failedEdge?.message;
        const failedStepId =
          ending.status === "failed" && "failedStepId" in ending ? ending.failedStepId : undefined;
        yield* sql`
          UPDATE runs SET
            status = ${ending.status},
            failure_reason = ${ending.status === "failed" ? ending.failureReason : null},
            failed_step_id = ${failedStepId ?? null},
            failed_edge_index = ${failedEdge?.index ?? null},
            failure_message = ${failureMessage ?? null},
            output = ${ending.status === "completed" && ending.output !== undefined ? JSON.stringify(ending.output) : null},
            finished_at = ${at}
          WHERE id = ${uuidFromString(id)} AND status IN ('pending', 'running')
        `;
        yield* announceChange(id, "updated");
      }),
  };
});

export const runRepository = make;
