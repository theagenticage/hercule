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
import type * as Statement from "effect/unstable/sql/Statement";
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
  /** The Task the run works on, when a handoff started it. */
  readonly taskId?: string;
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

/**
 * The newest completed step record of a run, with what the run's plan says of
 * its step. `name` and `action` are absent when the step does not set them
 * (`action` is only an action step's).
 */
export interface LastCompletedStep {
  readonly kind: "action" | "agent" | "text-generation";
  readonly name: string | undefined;
  readonly action: string | undefined;
}

/**
 * The newest completed record of an agent step of a run, with its output and
 * the `outputSchema` its step declares in the run's plan.
 */
export interface LastCompletedAgentStep {
  readonly stepId: string;
  readonly name: string | undefined;
  /** The session that ran the step, or undefined when the record has none. */
  readonly sessionId: string | undefined;
  readonly output: Schema.Json;
  readonly outputSchema: { readonly [name: string]: Schema.Json } | undefined;
}

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
 *   branch it switches the checkout to;
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
      /**
       * The step's input as stored when the record started, or undefined when
       * it stored none. Every action step's record stores one.
       */
      readonly input: Schema.Json | undefined;
      /** The branch stored when the record started (see `startStep`), or undefined when it stored none. */
      readonly checkoutBranch: string | undefined;
    }
  | {
      readonly kind: "agent";
      /** The session the step's turn runs in. */
      readonly sessionId: string;
      /**
       * Whether the step's prompt for this iteration is still `queued`: waiting
       * to be sent, or on its way to the runner with a send waiting for the
       * answer.
       */
      readonly promptQueued: boolean;
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
  readonly task_id: Uint8Array | null;
  readonly trigger_event: string | null;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly finished_at: string | null;
}

/**
 * The leg that starts at one run: the run and every run that re-runs it,
 * however many re-runs deep, on the same Task.
 */
export interface RunLeg {
  readonly rootId: string;
  /** The root run's workflow id. */
  readonly workflowId: string | null;
  /** The name of the root run's workflow, as it was when the root started. */
  readonly workflowName: string;
  /** The runs of the leg other than the root. */
  readonly rerunCount: number;
  /** The newest run of the leg, root included: its id and status, which is all a leg reports of it. */
  readonly latest: { readonly id: string; readonly status: RunStatus };
  /** The leg's pending and running runs, newest first, capped. */
  readonly liveRunIds: ReadonlyArray<string>;
}

/** One page of the run list: how many, where to start, and the filters. */
export interface RunPageRequest extends PageRequest, RunFilter {}

interface SummaryRow {
  readonly id: Uint8Array;
  readonly workflow_id: Uint8Array | null;
  readonly workflow_name: string;
  readonly origin: string;
  readonly task_id: Uint8Array | null;
  readonly status: RunStatus;
  readonly failure_reason: FailureReason | null;
  readonly failed_step_id: string | null;
  readonly failure_message: string | null;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly finished_at: string | null;
  /** The plan's triggers as JSON for a running run, and NULL for any other run or a plan without triggers. */
  readonly triggers: string | null;
}

/** The columns of a `SummaryRow`, read from `runs`. */
const SUMMARY_COLUMNS = `id, workflow_id, json_extract(plan, '$.name') AS workflow_name, origin, task_id,
  status, failure_reason, failed_step_id, failure_message, created_at, started_at, finished_at,
  CASE WHEN status = 'running' THEN json_extract(plan, '$.triggers') END AS triggers`;

/** A step record that is running or pending, as the run list reads it for its running runs. */
interface ActiveStepRow {
  readonly run_id: Uint8Array;
  readonly step_id: string;
  readonly status: "running" | "pending";
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
    ...(row.task_id === null ? {} : { taskId: uuidToString(row.task_id) }),
    ...(row.trigger_event === null
      ? {}
      : { triggerEvent: JSON.parse(row.trigger_event) as TriggerEvent }),
    createdAt: row.created_at,
    ...parseRunStatusColumns(row),
  };
};

/**
 * Returns where a running run is, from its running and pending step records
 * in the order they were created and its plan's triggers:
 *
 * - `activeStepIds`: the steps of its running records; when none is running,
 *   the steps of its pending records. Each step is listed once, though it
 *   may have several records.
 * - `awaitedSignalIds`: when it has no running or pending record, the ids of
 *   its plan's signal triggers, in the plan's order; otherwise empty.
 *
 * The rule for `awaitedSignalIds` mirrors `listAwaitedSignals` in
 * `@hercule/client-core`, which reads it from a whole `Run`; the controller
 * cannot import the client library.
 */
const buildRunningFields = (
  records: ReadonlyArray<ActiveStepRow>,
  triggers: WorkflowDefinition["triggers"],
): {
  readonly activeStepIds: ReadonlyArray<string>;
  readonly awaitedSignalIds: ReadonlyArray<string>;
} => {
  const running = records.filter((record) => record.status === "running");
  const active = running.length > 0 ? running : records;
  return {
    activeStepIds: [...new Set(active.map((record) => record.step_id))],
    awaitedSignalIds:
      records.length > 0
        ? []
        : (triggers ?? [])
            .filter((trigger) => trigger.kind === "signal")
            .map((trigger) => trigger.id),
  };
};

/**
 * Parses a summary row into a `RunSummary`. A running run's summary also
 * says where the run is (see `buildRunningFields`), from `activeRecords`: its
 * running and pending step records, in the order they were created.
 */
const parseSummaryRow = (
  row: SummaryRow,
  activeRecords: ReadonlyArray<ActiveStepRow>,
): RunSummary => {
  const fields = {
    id: uuidToString(row.id),
    workflowId: row.workflow_id === null ? null : uuidToString(row.workflow_id),
    workflowName: row.workflow_name,
    origin: JSON.parse(row.origin) as RunOrigin,
    ...(row.task_id === null ? {} : { taskId: uuidToString(row.task_id) }),
    createdAt: row.created_at,
  };
  const status = parseStatusColumns(row);
  if (status.status !== "running") return { ...fields, ...status };
  const triggers =
    row.triggers === null
      ? undefined
      : (JSON.parse(row.triggers) as WorkflowDefinition["triggers"]);
  return { ...fields, ...status, ...buildRunningFields(activeRecords, triggers) };
};

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

  /**
   * Returns the running and pending step records of the runs `runIds`
   * names, by run id, each run's in the order they were created. Reads them
   * in one query, and reads nothing when `runIds` is empty, so a page of
   * ended runs costs no more than before.
   */
  const listActiveStepRecords = (
    runIds: ReadonlyArray<Uint8Array>,
  ): Effect.Effect<ReadonlyMap<string, ReadonlyArray<ActiveStepRow>>, SqlError> => {
    if (runIds.length === 0) return Effect.succeed(new Map());
    return Effect.map(
      sql<ActiveStepRow>`
        SELECT run_id, step_id, status FROM run_steps
        WHERE run_id IN ${sql.in(runIds)} AND status IN ('running', 'pending')
        ORDER BY rowid
      `,
      (records) => {
        const byRun = new Map<string, Array<ActiveStepRow>>();
        for (const record of records) {
          const runId = uuidToString(record.run_id);
          const list = byRun.get(runId);
          if (list === undefined) byRun.set(runId, [record]);
          else list.push(record);
        }
        return byRun;
      },
    );
  };

  /**
   * Returns the run list's source for the `activeSince` filter: the runs
   * whose `finished_at` is NULL or at or after `activeSince`, of the workflow
   * `workflowClauses` names or of every workflow.
   *
   * Written as that `OR` in the WHERE clause, SQLite walks `runs_workflow`
   * over every run of the workflow instead, because that index also serves
   * the sort. So the runs come from the two lookups the filter names, each on
   * `runs_workflow_finished`, or on `runs_finished` for runs of any workflow,
   * and `CROSS JOIN` makes SQLite read those first: it never reorders a
   * `CROSS JOIN`.
   */
  const buildActiveRunsSource = (
    workflowClauses: ReadonlyArray<Statement.Fragment>,
    activeSince: string,
  ): Statement.Fragment =>
    sql`(SELECT id AS active_id FROM runs
         WHERE ${sql.and([...workflowClauses, sql`finished_at IS NULL`])}
         UNION ALL
         SELECT id FROM runs
         WHERE ${sql.and([...workflowClauses, sql`finished_at >= ${activeSince}`])})
        CROSS JOIN runs ON id = active_id`;

  /** Returns the WHERE clause that keeps only `workflowId` of the `workflows` table, or nothing. */
  const buildStoredWorkflowCondition = (workflowId: string | undefined): Statement.Fragment =>
    workflowId === undefined ? sql`` : sql`WHERE id = ${uuidFromString(workflowId)}`;

  /**
   * Returns the run list's source for the `newestPerWorkflow` filter when no
   * filter narrows the runs through an index of its own: for each stored
   * workflow, or only for `workflowId` when it is given, its newest
   * `perWorkflow` runs among those `filters` keep. Newest is the latest
   * `created_at`, then the greatest id.
   *
   * The source loops over the `workflows` table and makes one lookup per
   * workflow:
   *
   * - `CROSS JOIN` makes SQLite loop over the workflows first, because it
   *   never reorders a `CROSS JOIN`;
   * - for each workflow, the subquery walks `runs_workflow` from the newest
   *   run backwards and stops after `perWorkflow` runs the filters keep.
   *
   * With no filters, or with `since` and `until`, which `runs_workflow` reads
   * as a range, each lookup reads `perWorkflow` runs. Any other filter is
   * checked run by run, so a workflow with many runs the filter refuses is
   * read further back, as far as the run list without this filter would read.
   *
   * Ranking with a window function over `runs` instead would read every run
   * the controller ever had. Starting from `workflows` also leaves out the
   * runs of a deleted workflow, which keep its id in `workflow_id`, and the
   * runs of a sent workflow, whose `workflow_id` is NULL.
   */
  const buildNewestRunsPerWorkflowSource = (
    perWorkflow: number,
    workflowId: string | undefined,
    filters: ReadonlyArray<Statement.Fragment>,
  ): Statement.Fragment =>
    // The workflow id is renamed to `workflow` because `workflows` also has
    // an `id` and a `created_at`, which the list reads from `runs` by name.
    sql`(SELECT runs.* FROM (SELECT id AS workflow FROM workflows
                             ${buildStoredWorkflowCondition(workflowId)})
         CROSS JOIN runs ON runs.id IN (
           SELECT id FROM runs WHERE ${sql.and([sql`workflow_id = workflow`, ...filters])}
           ORDER BY created_at DESC, id DESC LIMIT ${perWorkflow}))`;

  /**
   * Returns the run list's source for the `newestPerWorkflow` filter when a
   * filter narrows the runs through an index of its own: the same runs as
   * `buildNewestRunsPerWorkflowSource` returns, read the other way round.
   *
   * `candidates` is the source the run list reads without this filter, so
   * the runs `filters` keep are found through the same index: pending and
   * running runs through `runs_unfinished`, the runs live since an instant
   * through the `finished_at` indexes, a run's re-runs through
   * `runs_original_run_id`, the runs of some Tasks through `runs_task_id`.
   * Only those runs are ranked, by a window function per workflow. A lookup
   * per workflow on `runs_workflow` would instead read every run of a
   * workflow whose history holds many runs the filters refuse.
   * Without a narrowing filter, ranking this way would rank every run the
   * controller ever had, which is why that case has a source of its own.
   *
   * `filters` leaves out the filter on `workflowId`, which the check against
   * the `workflows` table applies instead. Given the workflow in the WHERE
   * clause, SQLite walks that workflow's runs on `runs_workflow`, which also
   * serves the ranking's sort, and never reaches the narrowing index. A
   * workflow's ranks do not depend on the other workflows' runs, so ranking
   * them all and keeping one workflow's returns the same runs.
   */
  const buildNewestNarrowedRunsPerWorkflowSource = (
    perWorkflow: number,
    workflowId: string | undefined,
    candidates: Statement.Fragment,
    filters: ReadonlyArray<Statement.Fragment>,
  ): Statement.Fragment =>
    sql`(SELECT runs.* FROM (
           SELECT id AS ranked_id, workflow_id AS ranked_workflow,
                  ROW_NUMBER() OVER (PARTITION BY workflow_id
                                     ORDER BY created_at DESC, id DESC) AS newness
           FROM ${candidates} WHERE ${sql.and(filters)})
         CROSS JOIN runs ON runs.id = ranked_id
         WHERE newness <= ${perWorkflow}
           AND ranked_workflow IN (SELECT id FROM workflows ${buildStoredWorkflowCondition(workflowId)}))`;

  return {
    /** Inserts a pending run and a pending step record for each entry step. Returns the run's id. */
    insert: (run: NewRun, at: string): Effect.Effect<string, SqlError> =>
      Effect.gen(function* () {
        const id = mintUuid();
        yield* sql`
          INSERT INTO runs
            (id, workflow_id, plan, inputs, origin, original_run_id, task_id, trigger_event, status,
             created_at)
          VALUES (${id},
                  ${run.workflowId === null ? null : uuidFromString(run.workflowId)},
                  ${JSON.stringify(run.plan)}, ${JSON.stringify(run.inputs)},
                  ${JSON.stringify(run.origin)},
                  ${run.originalRunId === undefined ? null : uuidFromString(run.originalRunId)},
                  ${run.taskId === undefined ? null : uuidFromString(run.taskId)},
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
     * by when they were created. Every filter given must hold; `since`,
     * `until` and `activeSince` are inclusive. With `newestPerWorkflow`,
     * only each stored workflow's newest runs among those the other filters
     * keep are listed; `buildNewestRunsPerWorkflowSource` says which. A running
     * run's summary says which steps are active and which signals it waits
     * on. The runs and
     * their step records are read in one transaction, so both are from the
     * same moment: a run that ends between the two reads would otherwise
     * read as running with no active step, which looks like waiting.
     */
    list: (request: RunPageRequest): Effect.Effect<Page<RunSummary>, CursorError | SqlError> =>
      withTransaction(
        sql,
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
          const workflowClauses =
            request.workflowId === undefined
              ? []
              : [sql`workflow_id = ${uuidFromString(request.workflowId)}`];
          // Every filter but the workflow's. The narrowed source leaves the
          // workflow's filter out: see `buildNewestNarrowedRunsPerWorkflowSource`.
          const otherFilters: Array<Statement.Fragment> = [];
          if (request.status !== undefined) {
            otherFilters.push(sql`status = ${request.status}`);
            // SQLite reads the partial index `runs_unfinished` only when the
            // query itself shows that the status is pending or running, and a
            // bound value shows nothing. Without this clause, listing the
            // running runs scans every run the controller ever had.
            if (request.status === "pending" || request.status === "running") {
              otherFilters.push(sql`status IN ('pending', 'running')`);
            }
          }
          if (request.originalRunId !== undefined) {
            otherFilters.push(sql`original_run_id = ${uuidFromString(request.originalRunId)}`);
          }
          if (request.since !== undefined) otherFilters.push(sql`created_at >= ${request.since}`);
          if (request.until !== undefined) otherFilters.push(sql`created_at <= ${request.until}`);
          if (request.actor !== undefined) {
            otherFilters.push(sql`${sql.literal(STARTING_ACTOR)} = ${request.actor}`);
          }
          const filters = [...workflowClauses, ...otherFilters];
          const unranked =
            request.activeSince === undefined
              ? sql`runs`
              : buildActiveRunsSource(workflowClauses, request.activeSince);
          // A filter that SQLite answers from an index of its own narrows the
          // runs before they are ranked; see the two sources for why.
          const narrows =
            request.status === "pending" ||
            request.status === "running" ||
            request.activeSince !== undefined ||
            request.originalRunId !== undefined;
          // With `newestPerWorkflow`, the filters pick each workflow's newest
          // runs inside the source, and the keyset pages through what the
          // source returns, so a cursor never changes which runs are newest.
          const { source, clauses } =
            request.newestPerWorkflow === undefined
              ? { source: unranked, clauses: [keyset, ...filters] }
              : {
                  source: narrows
                    ? buildNewestNarrowedRunsPerWorkflowSource(
                        request.newestPerWorkflow,
                        request.workflowId,
                        unranked,
                        otherFilters,
                      )
                    : buildNewestRunsPerWorkflowSource(
                        request.newestPerWorkflow,
                        request.workflowId,
                        filters,
                      ),
                  clauses: [keyset],
                };
          const rows = yield* sql<SummaryRow>`
          SELECT ${sql.literal(SUMMARY_COLUMNS)}
          FROM ${source} WHERE ${sql.and(clauses)} ${order}
          LIMIT ${request.limit + 1}
        `;
          return yield* buildPage(
            rows,
            request.limit,
            (page) =>
              Effect.map(
                listActiveStepRecords(
                  page.filter((row) => row.status === "running").map((row) => row.id),
                ),
                (records) =>
                  page.map((row) => parseSummaryRow(row, records.get(uuidToString(row.id)) ?? [])),
              ),
            (last) => encodeCursor(scope, [last.createdAt], last.id),
          );
        }),
      ),

    /**
     * Returns, for the Tasks `taskIds`, each Task's newest run and the newest
     * pending or running run of each Task that has one, as summaries. Newest
     * is the latest `created_at`, then the greatest id. A Task with no run
     * has neither.
     *
     * Two statements, whatever the number of Tasks and runs:
     *
     * - the newest run: one lookup per Task on `runs_task_id`, which holds the
     *   runs of a Task newest first, so a Task's history is never read;
     * - the live runs: the pending and running runs on `runs_unfinished`,
     *   which are few, kept to these Tasks.
     *
     * The ids reach SQLite as one JSON text, so the statement does not grow
     * with the number of Tasks.
     */
    listLatestOfTasks: (
      taskIds: ReadonlyArray<string>,
    ): Effect.Effect<
      { readonly latest: ReadonlyArray<RunSummary>; readonly live: ReadonlyArray<RunSummary> },
      SqlError
    > =>
      Effect.gen(function* () {
        if (taskIds.length === 0) return { latest: [], live: [] };
        const hexIds = JSON.stringify(taskIds.map((id) => id.replaceAll("-", "")));
        const latestRows = yield* sql<SummaryRow>`
          SELECT ${sql.literal(SUMMARY_COLUMNS)}
          FROM (SELECT (SELECT id FROM runs WHERE task_id = unhex(value)
                        ORDER BY created_at DESC, id DESC LIMIT 1) AS latest_id
                FROM json_each(${hexIds}))
          CROSS JOIN runs ON runs.id = latest_id`;
        const liveRows = yield* sql<SummaryRow>`
          SELECT ${sql.literal(SUMMARY_COLUMNS)} FROM runs
          WHERE status IN ('pending', 'running')
            AND task_id IN (SELECT unhex(value) FROM json_each(${hexIds}))
          ORDER BY created_at DESC, id DESC`;
        const records = yield* listActiveStepRecords(
          [...latestRows, ...liveRows]
            .filter((row) => row.status === "running")
            .map((row) => row.id),
        );
        const parse = (row: SummaryRow): RunSummary =>
          parseSummaryRow(row, records.get(uuidToString(row.id)) ?? []);
        return { latest: latestRows.map(parse), live: liveRows.map(parse) };
      }),

    /**
     * Returns what went wrong in each failed run of `runIds` that says so, by
     * run id: the run's failure message (its `failureMessage`, or the message
     * of the edge it failed at), else the error message of the latest failed
     * record of the step it failed at. A run that records neither is left out.
     * One statement, whatever the number of runs.
     */
    listFailureMessages: (
      runIds: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyMap<string, string>, SqlError> =>
      runIds.length === 0
        ? Effect.succeed(new Map())
        : Effect.map(
            sql<{ readonly id: Uint8Array; readonly message: string | null }>`
              SELECT id, COALESCE(failure_message,
                (SELECT json_extract(s.error, '$.message') FROM run_steps s
                 WHERE s.run_id = runs.id AND s.step_id = runs.failed_step_id
                   AND s.status = 'failed'
                 ORDER BY s.iteration DESC LIMIT 1)) AS message
              FROM runs WHERE id IN ${sql.in(runIds.map((id) => uuidFromString(id)))}`,
            (rows) =>
              new Map(
                rows.flatMap((row) =>
                  row.message === null ? [] : [[uuidToString(row.id), row.message] as const],
                ),
              ),
          ),

    /**
     * Returns the newest `limit` runs of the Task as summaries, newest first
     * (latest `created_at`, then greatest id). A Task with no run has none.
     * One lookup on `runs_task_id`, which holds a Task's runs newest first,
     * so it reads `limit` runs and never the Task's whole history.
     */
    listNewestOfTask: (
      taskId: string,
      limit: number,
    ): Effect.Effect<ReadonlyArray<RunSummary>, SqlError> =>
      Effect.gen(function* () {
        const rows = yield* sql<SummaryRow>`
          SELECT ${sql.literal(SUMMARY_COLUMNS)} FROM runs
          WHERE task_id = ${uuidFromString(taskId)}
          ORDER BY created_at DESC, id DESC LIMIT ${limit}`;
        const records = yield* listActiveStepRecords(
          rows.filter((row) => row.status === "running").map((row) => row.id),
        );
        return rows.map((row) => parseSummaryRow(row, records.get(uuidToString(row.id)) ?? []));
      }),

    /**
     * Returns the name of the workflow of a run, as it was when the run
     * started, or none when no run has the id. One lookup of the run by its
     * id.
     */
    readWorkflowName: (runId: string): Effect.Effect<Option.Option<string>, SqlError> =>
      Effect.map(
        sql<{ readonly workflow_name: string }>`
          SELECT json_extract(plan, '$.name') AS workflow_name
          FROM runs WHERE id = ${uuidFromString(runId)}`,
        (rows) => Option.fromNullishOr(rows[0]?.workflow_name),
      ),

    /**
     * Returns the Task each run of `runIds` works on, by run id. A run that
     * works on no Task, or does not exist, is left out. One lookup of each run
     * by its id.
     */
    listTaskIds: (
      runIds: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyMap<string, string>, SqlError> =>
      runIds.length === 0
        ? Effect.succeed(new Map())
        : Effect.map(
            sql<{ readonly id: Uint8Array; readonly task_id: Uint8Array }>`
              SELECT id, task_id FROM runs
              WHERE id IN ${sql.in(runIds.map((id) => uuidFromString(id)))}
                AND task_id IS NOT NULL`,
            (rows) =>
              new Map(
                rows.map((row) => [uuidToString(row.id), uuidToString(row.task_id)] as const),
              ),
          ),

    /**
     * Returns the name of the workflow of each run of `runIds`, as it was when
     * the run started, by run id. A run that does not exist is left out. One
     * lookup of each run by its id.
     */
    listWorkflowNames: (
      runIds: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyMap<string, string>, SqlError> =>
      runIds.length === 0
        ? Effect.succeed(new Map())
        : Effect.map(
            sql<{ readonly id: Uint8Array; readonly workflow_name: string }>`
              SELECT id, json_extract(plan, '$.name') AS workflow_name FROM runs
              WHERE id IN ${sql.in(runIds.map((id) => uuidFromString(id)))}`,
            (rows) =>
              new Map(rows.map((row) => [uuidToString(row.id), row.workflow_name] as const)),
          ),

    /**
     * Returns, for each root `{ runId, taskId }`, the leg that starts at the
     * root run: the root and every run reachable from it through
     * `original_run_id` (a re-run, a re-run of a re-run, and so on) that works
     * on the same Task. A root that does not exist, or works on another Task, is
     * left out. For each leg it returns:
     *
     * - the root's workflow id and name;
     * - the number of runs that re-run the root (the leg without the root);
     * - the newest run of the leg, root included (latest `created_at`, then
     *   greatest id);
     * - the ids of the leg's pending or running runs, newest first, at most
     *   `maxLiveRunIds`.
     *
     * One recursive statement for all the roots. The statement walks the
     * roots on the primary key and each run's re-runs on `runs_original_run_id`,
     * so its work follows the runs of the legs, never the Task's other runs. The
     * unary `+` on the Task check keeps SQLite from walking `runs_task_id`, the
     * Task's whole history, once for every run of a leg. It
     * ranks the runs of each leg in memory (SQLite window functions) and reads
     * the summary columns of only the root, the newest run and the capped live
     * runs of each leg. The roots reach SQLite as one JSON text, so the
     * statement does not grow with the number of roots.
     */
    listLegs: (
      roots: ReadonlyArray<{ readonly runId: string; readonly taskId: string }>,
      maxLiveRunIds: number,
    ): Effect.Effect<ReadonlyArray<RunLeg>, SqlError> =>
      Effect.gen(function* () {
        if (roots.length === 0) return [];
        const hexRoots = JSON.stringify(
          roots.map((root) => [root.runId.replaceAll("-", ""), root.taskId.replaceAll("-", "")]),
        );
        const rows = yield* sql<
          SummaryRow & {
            readonly root_id: Uint8Array;
            readonly size: number;
            readonly newest_rank: number;
            readonly live_rank: number | null;
            readonly is_root: number;
          }
        >`
          WITH RECURSIVE
            roots(root_id, task_id) AS (
              SELECT unhex(json_extract(value, '$[0]')), unhex(json_extract(value, '$[1]'))
              FROM json_each(${hexRoots})),
            members(root_id, member_id, task_id, created_at, is_live) AS (
              SELECT roots.root_id, runs.id, roots.task_id, runs.created_at,
                     runs.status IN ('pending', 'running')
              FROM roots CROSS JOIN runs ON runs.id = roots.root_id AND runs.task_id = roots.task_id
              UNION ALL
              SELECT members.root_id, runs.id, members.task_id, runs.created_at,
                     runs.status IN ('pending', 'running')
              FROM members CROSS JOIN runs ON runs.original_run_id = members.member_id
                                          AND +runs.task_id = members.task_id),
            ranked AS (
              SELECT root_id, member_id, is_live,
                     count(*) OVER (PARTITION BY root_id) AS size,
                     row_number() OVER (PARTITION BY root_id
                                        ORDER BY created_at DESC, member_id DESC) AS newest_rank,
                     CASE WHEN is_live THEN
                       row_number() OVER (PARTITION BY root_id, is_live
                                          ORDER BY created_at DESC, member_id DESC) END AS live_rank
              FROM members)
          SELECT root_id, size, newest_rank, live_rank, member_id = root_id AS is_root,
                 ${sql.literal(SUMMARY_COLUMNS)}
          FROM ranked CROSS JOIN runs ON runs.id = member_id
          WHERE newest_rank = 1 OR member_id = root_id OR live_rank <= ${maxLiveRunIds}`;
        const byRoot = new Map<string, Array<(typeof rows)[number]>>();
        for (const row of rows) {
          const rootId = uuidToString(row.root_id);
          const ofRoot = byRoot.get(rootId);
          if (ofRoot === undefined) byRoot.set(rootId, [row]);
          else ofRoot.push(row);
        }
        return [...byRoot].map(([rootId, ofRoot]): RunLeg => {
          const root = ofRoot.find((row) => row.is_root === 1)!;
          const newest = ofRoot.find((row) => row.newest_rank === 1)!;
          return {
            rootId,
            workflowId: root.workflow_id === null ? null : uuidToString(root.workflow_id),
            workflowName: root.workflow_name,
            rerunCount: root.size - 1,
            latest: { id: uuidToString(newest.id), status: newest.status },
            liveRunIds: ofRoot
              .filter((row) => row.live_rank !== null && row.live_rank <= maxLiveRunIds)
              .toSorted((a, b) => a.live_rank! - b.live_rank!)
              .map((row) => uuidToString(row.id)),
          };
        });
      }),

    /**
     * Returns the session of each run's step record that started last and has
     * a session, by run id. Only agent steps have sessions, so it is the
     * session of the run's last agent step to start. A run with none is left
     * out. One statement, whatever the number of runs, and one probe of
     * `run_steps_session` for each run, which holds the session itself, so no
     * step record is opened and no output is read.
     */
    listLastSessions: (
      runIds: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyMap<string, string>, SqlError> =>
      runIds.length === 0
        ? Effect.succeed(new Map())
        : Effect.map(
            sql<{ readonly run_id: Uint8Array; readonly session_id: Uint8Array | null }>`
              SELECT runs.id AS run_id,
                     (SELECT s.session_id FROM run_steps s
                      WHERE s.run_id = runs.id AND s.session_id IS NOT NULL
                      ORDER BY s.started_at DESC LIMIT 1) AS session_id
              FROM runs WHERE runs.id IN ${sql.in(runIds.map((id) => uuidFromString(id)))}`,
            (rows) =>
              new Map(
                rows.flatMap((row) =>
                  row.session_id === null
                    ? []
                    : [[uuidToString(row.run_id), uuidToString(row.session_id)] as const],
                ),
              ),
          ),

    /**
     * Returns what a run's step records say about how it ended: its newest
     * completed step record of any kind, and its newest completed record of
     * an agent step with that record's output. "Newest" is the latest
     * `finished_at`, then the latest record. Either is absent when the run
     * has no such record.
     *
     * Two statements that each return one record. They walk the steps of the
     * run's plan and look up each step's records on the primary key of
     * `run_steps`, so the plan is read once whatever the number of records,
     * and no output is read but the one.
     */
    readLastCompletedSteps: (
      runId: string,
    ): Effect.Effect<
      {
        readonly last: LastCompletedStep | undefined;
        readonly agent: LastCompletedAgentStep | undefined;
      },
      SqlError
    > =>
      Effect.gen(function* () {
        const id = uuidFromString(runId);
        // `CROSS JOIN` keeps SQLite on the run, then its plan's steps, then each step's records,
        // so the plan is read once, however many records the run has.
        const lastRows = yield* sql<{
          readonly kind: LastCompletedStep["kind"];
          readonly name: string | null;
          readonly action: string | null;
        }>`
          SELECT json_extract(step.value, '$.kind') AS kind,
                 json_extract(step.value, '$.name') AS name,
                 json_extract(step.value, '$.action') AS action
          FROM runs
          CROSS JOIN json_each(runs.plan, '$.steps') AS step
          CROSS JOIN run_steps s
            ON s.run_id = runs.id AND s.step_id = json_extract(step.value, '$.id')
          WHERE runs.id = ${id} AND s.status = 'completed'
          ORDER BY s.finished_at DESC, s.rowid DESC LIMIT 1`;
        const agentRows = yield* sql<{
          readonly step_id: string;
          readonly name: string | null;
          readonly session_id: Uint8Array | null;
          readonly output: string | null;
          readonly output_schema: string | null;
        }>`
          SELECT s.step_id, json_extract(step.value, '$.name') AS name, s.session_id, s.output,
                 json_extract(step.value, '$.outputSchema') AS output_schema
          FROM runs
          CROSS JOIN json_each(runs.plan, '$.steps') AS step
          CROSS JOIN run_steps s
            ON s.run_id = runs.id AND s.step_id = json_extract(step.value, '$.id')
          WHERE runs.id = ${id} AND s.status = 'completed'
            AND json_extract(step.value, '$.kind') = 'agent'
          ORDER BY s.finished_at DESC, s.rowid DESC LIMIT 1`;
        const last = lastRows[0];
        const agent = agentRows[0];
        return {
          last:
            last === undefined
              ? undefined
              : {
                  kind: last.kind,
                  name: last.name ?? undefined,
                  action: last.action ?? undefined,
                },
          agent:
            agent === undefined
              ? undefined
              : {
                  stepId: agent.step_id,
                  name: agent.name ?? undefined,
                  sessionId: agent.session_id === null ? undefined : uuidToString(agent.session_id),
                  output: agent.output === null ? null : (JSON.parse(agent.output) as Schema.Json),
                  outputSchema:
                    agent.output_schema === null
                      ? undefined
                      : (JSON.parse(agent.output_schema) as { [name: string]: Schema.Json }),
                },
        };
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
     *   against the action's input schema. A workspace action's step that
     *   switches the run's checkout to a branch stores that branch too, so
     *   the step sent again after a reconnect switches it the same way;
     * - for an agent step, the session that runs it;
     * - for a text generation step, nothing: `started` is `undefined`. The
     *   step renders its input again each time it calls the model, so there
     *   is nothing to keep.
     *
     * Fails with `StepRecordEnded` if the record is not pending any more, so
     * the caller does not start the step for a run that has been cancelled.
     */
    startStep: (
      runId: string,
      step: StepRecordId,
      started:
        | { readonly input: Schema.Json; readonly checkoutBranch: string | undefined }
        | { readonly sessionId: string }
        | undefined,
      at: string,
    ): Effect.Effect<void, SqlError | StepRecordEnded> =>
      Effect.gen(function* () {
        const action = started !== undefined && "input" in started ? started : undefined;
        const input = action === undefined ? null : JSON.stringify(action.input);
        const branch = action?.checkoutBranch ?? null;
        const session =
          started !== undefined && "sessionId" in started
            ? uuidFromString(started.sessionId)
            : null;
        const updated = yield* sql`
          UPDATE run_steps SET status = 'running', started_at = ${at},
                               input = ${input}, checkout_branch = ${branch},
                               session_id = ${session}
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
          readonly prompt_queued: number;
          readonly checkout_branch: string | null;
        }>`
          SELECT s.run_id, r.workspace_id, s.step_id, s.iteration, s.input, s.session_id,
                 s.checkout_branch,
                 json_extract(step.value, '$.kind') AS kind,
                 json_extract(step.value, '$.action') AS action,
                 EXISTS (SELECT 1 FROM session_inputs AS prompt
                         WHERE prompt.session_id = s.session_id
                           AND prompt.step_iteration = s.iteration
                           AND prompt.status = 'queued')
                   AS prompt_queued
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
                  sessionId: uuidToString(row.session_id),
                  promptQueued: row.prompt_queued === 1,
                },
              ];
            }
            if (row.kind !== "action" || row.action === null) return [];
            return [
              {
                ...record,
                kind: "action",
                action: row.action,
                input: row.input === null ? undefined : (JSON.parse(row.input) as Schema.Json),
                checkoutBranch: row.checkout_branch ?? undefined,
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

    /**
     * Checks whether a running workflow's signal trigger received the event
     * `eventId` as a step, whatever became of the step since.
     */
    hasStepForEvent: (eventId: number): Effect.Effect<boolean, SqlError> =>
      Effect.map(
        sql`SELECT 1 FROM run_steps WHERE event_id = ${eventId} LIMIT 1`,
        (rows) => rows.length > 0,
      ),
  };
});

export const runRepository = make;
