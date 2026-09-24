/**
 * Runs: a workflow's steps carried out once, one after another.
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
 *   `cancelled`.
 *
 * `workflow.run` starts a run of a stored workflow, and `workflow.submit` a
 * run of a workflow sent with the request and never stored. Both return the
 * run's id at once. They never wait for a step, so a caller reads the run with
 * `run.read` to see how far it got.
 */
import { Schema } from "effect";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import { closedStruct } from "../closed";
import {
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
import { WorkflowDefinition } from "./workflow-definition";

/** The statuses of a run, in the order a run moves through them. */
const RUN_STATUSES = ["pending", "running", "completed", "failed", "cancelled"] as const;

export const RunStatus = Schema.Literals(RUN_STATUSES);

export type RunStatus = Schema.Schema.Type<typeof RunStatus>;

/** The statuses of a step record, in the order a step record moves through them. */
const STEP_STATUSES = ["pending", "running", "completed", "failed", "cancelled"] as const;

export const StepStatus = Schema.Literals(STEP_STATUSES);

export type StepStatus = Schema.Schema.Type<typeof StepStatus>;

/**
 * Why a run failed:
 *
 * - `expression-error`: a template in a step's params could not be evaluated.
 *   `failedStepId` names the step.
 * - `step-failed`: a step's action failed. `failedStepId` names the step, and
 *   its step record holds the error.
 *
 * The list grows as runs learn to do more; a client shows a reason it does not
 * know as the word itself.
 */
const FAILURE_REASONS = ["expression-error", "step-failed"] as const;

export const FailureReason = Schema.Literals(FAILURE_REASONS);

export type FailureReason = Schema.Schema.Type<typeof FailureReason>;

/**
 * How a run was started:
 *
 * - `manual`: the user started it, from the web app or the CLI.
 * - `api`: an agent started it through the API. `actor` is its session.
 * - `action`: a `workflow.run` step of another run started it.
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

/** One attempt at one step of a run's plan. */
export const StepRecord = Schema.Struct({
  /** The step's id in the plan. */
  stepId: Schema.String,
  /** Counts the attempts at this step in the run, from 1. */
  iteration: Schema.Int,
  status: StepStatus,
  startedAt: Schema.optionalKey(Timestamp),
  finishedAt: Schema.optionalKey(Timestamp),
  /** What the step's action returned. Set once the step has completed. */
  output: Schema.optionalKey(Schema.Json),
  /** Set once the step has failed. */
  error: Schema.optionalKey(StepError),
});

export type StepRecord = Schema.Schema.Type<typeof StepRecord>;

/** A run, with its frozen plan and every step record in the order they were created. */
export const Run = Schema.Struct({
  id: Id,
  /** The workflow the run was started from. It stays set after that workflow is deleted. */
  workflowId: Schema.NullOr(Id),
  /** The workflow definition as it was when the run started. */
  plan: WorkflowDefinition,
  /** The inputs the run started with, with defaults applied. An optional input with no value is absent. */
  inputs: Schema.Record(Schema.String, Schema.Json),
  origin: RunOrigin,
  status: RunStatus,
  /** Set when the run has failed. */
  failureReason: Schema.optionalKey(FailureReason),
  /** The step the run failed at. */
  failedStepId: Schema.optionalKey(Schema.String),
  steps: Schema.Array(StepRecord),
  createdAt: Timestamp,
  startedAt: Schema.optionalKey(Timestamp),
  /** Set when the run has completed, failed or been cancelled. */
  finishedAt: Schema.optionalKey(Timestamp),
});

export type Run = Schema.Schema.Type<typeof Run>;

/**
 * One run in the run list: the run without its plan and step records, which
 * are long. `run.read` returns them.
 */
export const RunSummary = Schema.Struct({
  id: Id,
  /** The workflow the run was started from, or null for a submitted workflow. */
  workflowId: Schema.NullOr(Id),
  /** The workflow's name as it was when the run started, from the run's plan. */
  workflowName: Schema.String,
  origin: RunOrigin,
  status: RunStatus,
  failureReason: Schema.optionalKey(FailureReason),
  failedStepId: Schema.optionalKey(Schema.String),
  createdAt: Timestamp,
  startedAt: Schema.optionalKey(Timestamp),
  finishedAt: Schema.optionalKey(Timestamp),
});

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
   * for the runs a run's `workflow.run` steps started.
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

/** The input of `workflow.run`, besides the workflow id in the path. */
const WorkflowRunInput = closedStruct({
  inputs: Schema.optionalKey(RunInputs),
});

/** The response to starting a run: the id to read it by. */
export const RunStarted = Schema.Struct({ runId: Id });

export type RunStarted = Schema.Schema.Type<typeof RunStarted>;

/**
 * The `workflow.run` endpoint. It belongs to the `workflow` group, because
 * the group and the endpoint name make up the operation id.
 */
export const workflowRunEndpoint = HttpApiEndpoint.post("run", "/workflows/:id/run", {
  params: { id: Id },
  payload: WorkflowRunInput,
  success: RunStarted,
  error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
});

export const run = HttpApiGroup.make("run")
  .add(
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
