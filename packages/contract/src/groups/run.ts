/**
 * Runs: a workflow's steps carried out once, following the edges between
 * them.
 *
 * A run freezes the workflow definition it started from into `plan`, so what
 * a run did can still be read, and drawn, after its workflow is edited or
 * deleted. A step record is one attempt at one step of the plan. Both a run
 * and its step records only move forward through their statuses:
 *
 * - a run is `pending` until the controller starts it, `running` while it has
 *   steps to execute, and then `completed`, `failed` or `cancelled`;
 * - a step record is `pending` until its action is called, `running` while
 *   its action is being called, and then `completed`, `failed` or
 *   `cancelled`. A step record whose step's condition is false when it would
 *   start moves from `pending` straight to `skipped`, and its action is never
 *   called.
 *
 * `run.start` starts a run, either of a stored workflow or of a workflow sent
 * with the request and never stored. It returns the run's id at once and never
 * waits for a step, so a caller reads the run with `run.read` to see how far
 * it got.
 */
import { Schema } from "effect";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import { closedStruct } from "../closed";
import {
  CapExceeded,
  Forbidden,
  Internal,
  InvalidState,
  NotFound,
  Unauthenticated,
  Validation,
} from "../errors";
import { Actor, Id, Timestamp } from "../ids";
import { page, pageParams } from "../pagination";
import { Authenticated } from "../security";
import { WORKFLOW_CONTENT_FIELDS } from "./workflow";
import { WorkflowDefinition } from "./workflow-definition";

/** The statuses of a run, in the order a run moves through them. */
export const RUN_STATUSES = ["pending", "running", "completed", "failed", "cancelled"] as const;

export const RunStatus = Schema.Literals(RUN_STATUSES);

export type RunStatus = Schema.Schema.Type<typeof RunStatus>;

/** The statuses of a step record, in the order a step record moves through them. */
const STEP_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
  "skipped",
] as const;

export const StepStatus = Schema.Literals(STEP_STATUSES);

export type StepStatus = Schema.Schema.Type<typeof StepStatus>;

/**
 * Why a run failed:
 *
 * - `expression-error`: a template in a step's params, or a condition, could
 *   not be evaluated, or a condition gave something other than true or false.
 *   `failedStepId` names the step. For an edge's condition it names the
 *   edge's source step, and `failedEdgeIndex` names the edge.
 * - `step-failed`: a step's action failed. `failedStepId` names the step, and
 *   its step record holds the error.
 * - `iteration-limit`: an edge's condition was true, but the edge had already
 *   been followed as often as its `maxTraversals` allows. `failedStepId`
 *   names the edge's source step, and `failedEdgeIndex` the edge.
 * - `controller-error`: the controller could not carry out the run for a
 *   reason of its own, such as a bug. `failedStepId` names the step the run
 *   was at, if it was at one. The controller's log has the details.
 *
 * The list grows as runs learn to do more; a client shows a reason it does not
 * know as the word itself.
 */
const FAILURE_REASONS = [
  "expression-error",
  "step-failed",
  "iteration-limit",
  "controller-error",
] as const;

export const FailureReason = Schema.Literals(FAILURE_REASONS);

export type FailureReason = Schema.Schema.Type<typeof FailureReason>;

/**
 * How a run was started:
 *
 * - `manual`: the user started it, from the web app or the CLI.
 * - `api`: an agent started it through the API. `actor` is its session.
 * - `action`: a `run.start` step of another run started it. `parentRunId` is
 *   that other run, and `stepId` the step.
 */
export const RunOrigin = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("manual"), actor: Actor }),
  Schema.Struct({ kind: Schema.Literal("api"), actor: Actor }),
  Schema.Struct({ kind: Schema.Literal("action"), parentRunId: Id, stepId: Schema.String }),
]);

export type RunOrigin = Schema.Schema.Type<typeof RunOrigin>;

/**
 * Why a step failed. `code` is a short word a program can act on, such as
 * `not_found`, `validation` or `unexpected`, and `message` is a sentence for
 * a person.
 */
export const StepError = Schema.Struct({ code: Schema.String, message: Schema.String });

export type StepError = Schema.Schema.Type<typeof StepError>;

/** The fields every step record has, whatever its status. */
const STEP_RECORD_FIELDS = {
  /** The step's id in the plan. */
  stepId: Schema.String,
  /** Counts the records of this step in the run, from 1. */
  iteration: Schema.Int,
};

/**
 * One attempt at one step of a run's plan. Which timestamps and results a
 * step record has follows from its status:
 *
 * - `pending`: none yet.
 * - `running`: `startedAt`.
 * - `completed`: `startedAt`, `finishedAt`, and `output`, what the step's
 *   action returned (`null` for an action that returns nothing).
 * - `failed`: `startedAt`, `finishedAt`, and `error`.
 * - `cancelled`: `finishedAt`, and `startedAt` if the step had started.
 * - `skipped`: `finishedAt` only. The step's condition was false, so its
 *   action was never called.
 */
export const StepRecord = Schema.Union([
  Schema.Struct({ ...STEP_RECORD_FIELDS, status: Schema.Literal("pending") }),
  Schema.Struct({ ...STEP_RECORD_FIELDS, status: Schema.Literal("running"), startedAt: Timestamp }),
  Schema.Struct({
    ...STEP_RECORD_FIELDS,
    status: Schema.Literal("completed"),
    startedAt: Timestamp,
    finishedAt: Timestamp,
    output: Schema.Json,
  }),
  Schema.Struct({
    ...STEP_RECORD_FIELDS,
    status: Schema.Literal("failed"),
    startedAt: Timestamp,
    finishedAt: Timestamp,
    error: StepError,
  }),
  Schema.Struct({
    ...STEP_RECORD_FIELDS,
    status: Schema.Literal("cancelled"),
    startedAt: Schema.optionalKey(Timestamp),
    finishedAt: Timestamp,
  }),
  Schema.Struct({
    ...STEP_RECORD_FIELDS,
    status: Schema.Literal("skipped"),
    finishedAt: Timestamp,
  }),
]);

export type StepRecord = Schema.Schema.Type<typeof StepRecord>;

/**
 * Returns one struct per way a run can stand, each with `fields` and the
 * fields that follow from the run's status:
 *
 * - `pending`: no timestamp but `createdAt`.
 * - `running`: `startedAt`.
 * - `completed`: `startedAt` and `finishedAt`.
 * - `failed` at a step (`expression-error`, `step-failed` or
 *   `iteration-limit`): `failedStepId`, `startedAt` and `finishedAt`, and
 *   `failedEdgeIndex` and `failureMessage` when the run failed at an edge.
 * - `failed` with `controller-error`: `finishedAt`, and `failedStepId` and
 *   `startedAt` when the run had got that far.
 * - `cancelled`: `finishedAt`, and `startedAt` if the run had started.
 *
 * A run and a run summary share these rules, so both are built from here.
 */
const buildRunStatusVariants = <const Fields extends Schema.Struct.Fields>(fields: Fields) =>
  [
    Schema.Struct({ ...fields, status: Schema.Literal("pending") }),
    Schema.Struct({ ...fields, status: Schema.Literal("running"), startedAt: Timestamp }),
    Schema.Struct({
      ...fields,
      status: Schema.Literal("completed"),
      startedAt: Timestamp,
      finishedAt: Timestamp,
    }),
    Schema.Struct({
      ...fields,
      status: Schema.Literal("failed"),
      failureReason: Schema.Literals(["expression-error", "step-failed", "iteration-limit"]),
      failedStepId: Schema.String,
      /** The index in `plan.edges` of the edge the run failed at, when it failed at one. */
      failedEdgeIndex: Schema.optionalKey(Schema.Int),
      /**
       * What went wrong at the edge the run failed at, when it failed at one:
       * the condition's evaluation error, or the `maxTraversals` it reached.
       * A failure at a step keeps its message on the step record instead.
       */
      failureMessage: Schema.optionalKey(Schema.String),
      startedAt: Timestamp,
      finishedAt: Timestamp,
    }),
    Schema.Struct({
      ...fields,
      status: Schema.Literal("failed"),
      failureReason: Schema.Literal("controller-error"),
      failedStepId: Schema.optionalKey(Schema.String),
      startedAt: Schema.optionalKey(Timestamp),
      finishedAt: Timestamp,
    }),
    Schema.Struct({
      ...fields,
      status: Schema.Literal("cancelled"),
      startedAt: Schema.optionalKey(Timestamp),
      finishedAt: Timestamp,
    }),
  ] as const;

/** A run, with its frozen plan and every step record in the order they were created. */
export const Run = Schema.Union(
  buildRunStatusVariants({
    id: Id,
    /** The workflow the run was started from. It stays set after that workflow is deleted. */
    workflowId: Schema.NullOr(Id),
    /** The workflow definition as it was when the run started. */
    plan: WorkflowDefinition,
    /** The inputs the run started with, with defaults applied. An optional input with no value is absent. */
    inputs: Schema.Record(Schema.String, Schema.Json),
    origin: RunOrigin,
    steps: Schema.Array(StepRecord),
    /**
     * How many times the run has followed each edge: one count per edge of
     * `plan.edges`, in the same order, zeros included.
     */
    edgeTraversals: Schema.Array(Schema.Int),
    createdAt: Timestamp,
  }),
);

export type Run = Schema.Schema.Type<typeof Run>;

/**
 * One run in the run list: the run without its plan and step records, which
 * are long. `run.read` returns them.
 */
export const RunSummary = Schema.Union(
  buildRunStatusVariants({
    id: Id,
    /** The workflow the run was started from, or null for a workflow sent with `run.start`. */
    workflowId: Schema.NullOr(Id),
    /** The workflow's name as it was when the run started, from the run's plan. */
    workflowName: Schema.String,
    origin: RunOrigin,
    createdAt: Timestamp,
  }),
);

export type RunSummary = Schema.Schema.Type<typeof RunSummary>;

/** Filters for the run list. Every filter given must hold. */
export const RunFilter = Schema.Struct({
  workflowId: Schema.optionalKey(Id),
  status: Schema.optionalKey(RunStatus),
  /** Only runs created at or after this instant. */
  since: Schema.optionalKey(Timestamp),
  /** Only runs created at or before this instant. */
  until: Schema.optionalKey(Timestamp),
  /**
   * Only runs started by this actor: `user`, `session:<id>`, or `run:<id>`
   * for the runs a run's `run.start` steps started.
   */
  actor: Schema.optionalKey(Actor),
});

export type RunFilter = Schema.Schema.Type<typeof RunFilter>;

/** The fields the run list can be sorted by. */
export const RUN_SORT_FIELDS = ["createdAt"] as const;

/**
 * The values a run starts with: one for each input the workflow declares, by
 * name. The controller checks them against the declarations.
 */
export const RunInputs = Schema.Record(Schema.String, Schema.Json);

export type RunInputs = Schema.Schema.Type<typeof RunInputs>;

/**
 * The input of `run.start`: the workflow to run, and the values its run starts
 * with. The workflow is exactly one of:
 *
 * - `workflowId`: a stored workflow;
 * - `source` or `definition`: a workflow sent with the request, as for
 *   `workflow.create`. It is validated like a save and never stored, so the
 *   run's `workflowId` is null.
 *
 * The controller checks that exactly one is given, and says which fields to
 * send when not.
 */
export const RunStartInput = closedStruct({
  workflowId: Schema.optionalKey(Id),
  ...WORKFLOW_CONTENT_FIELDS,
  inputs: Schema.optionalKey(RunInputs),
});

export type RunStartInput = Schema.Schema.Type<typeof RunStartInput>;

/** The response to starting a run: the id to read it by. */
export const RunStarted = Schema.Struct({ runId: Id });

export type RunStarted = Schema.Schema.Type<typeof RunStarted>;

export const run = HttpApiGroup.make("run")
  .add(
    /**
     * Starts a run and returns its id at once, without waiting for any step.
     * Fails with `validation`, starting no run, when the workflow does not
     * validate, has an element runs cannot execute yet, or the inputs do not
     * match its declarations; with `not_found` for an unknown `workflowId`;
     * and with `cap_exceeded` when the run would be nested deeper than the
     * controller's `run.nestingLimit`.
     */
    HttpApiEndpoint.post("start", "/runs/start", {
      payload: RunStartInput,
      success: RunStarted,
      error: [Unauthenticated, Forbidden, Validation, NotFound, CapExceeded, Internal],
    }),
    HttpApiEndpoint.get("query", "/runs", {
      query: Schema.Struct({
        ...RunFilter.fields,
        ...pageParams(RUN_SORT_FIELDS).fields,
      }),
      success: page(RunSummary),
      error: [Unauthenticated, Forbidden, Validation, Internal],
    }),
    HttpApiEndpoint.get("read", "/runs/:id", {
      params: { id: Id },
      success: Run,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    /**
     * Cancels a pending or running run and returns it. Its step records that
     * had not ended are cancelled, and no step starts after it. Fails with
     * `invalid_state` for a run that has already ended.
     */
    HttpApiEndpoint.post("cancel", "/runs/:id/cancel", {
      params: { id: Id },
      success: Run,
      error: [Unauthenticated, Forbidden, Validation, NotFound, InvalidState, Internal],
    }),
  )
  .middleware(Authenticated);
