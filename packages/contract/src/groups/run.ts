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
 * it got. `run.rerun` starts a new run with the inputs of one that has ended.
 *
 * A start trigger starts a run when an event matches it. That run records the
 * trigger and the event in its `origin`, and keeps a copy of the event in
 * `triggerEvent`, so the run can still show what started it after the event
 * log is pruned.
 *
 * When a run ends, the controller emits `run.completed`, `run.failed` or
 * `run.cancelled` into the event pipeline, with one of the payloads below.
 */
import { Schema, Struct } from "effect";
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
import { Event, EventId } from "./event";
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
 * - `validation-error`: a start trigger matched an event, but its workflow no
 *   longer passes the checks a run must pass to start: the definition, or the
 *   inputs the trigger mapped from the event, did not validate. The run never
 *   started, and `failureMessage` says what did not validate. A run started
 *   by request never fails this way: the request is refused instead.
 * - `expression-error`: a template in a step's params, or a condition, could
 *   not be evaluated, or a condition gave something other than true or false.
 *   `failedStepId` names the step. For an edge's condition it names the
 *   edge's source step, and `failedEdge` names the edge.
 * - `step-failed`: a step's action failed. `failedStepId` names the step, and
 *   its step record holds the error.
 * - `iteration-limit`: an edge's condition was true, but the edge had already
 *   been followed as often as its `maxTraversals` allows. `failedStepId`
 *   names the edge's source step, and `failedEdge` the edge.
 * - `controller-error`: the controller could not carry out the run for a
 *   reason of its own, such as a bug. `failedStepId` names the step the run
 *   was at, if it was at one. The controller's log has the details.
 * - `workspace-failed`: the run's workspace could not be set up, for example
 *   because a setup command failed, or the runner that holds it was retired.
 *   `failedStepId` names the workspace step that was running, if one was.
 *
 * The list grows as runs learn to do more; a client shows a reason it does not
 * know as the word itself.
 */
const FAILURE_REASONS = [
  "validation-error",
  "expression-error",
  "step-failed",
  "iteration-limit",
  "controller-error",
  "workspace-failed",
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
 * - `trigger`: a start trigger of the run's workflow matched an event.
 *   `triggerId` is the trigger's id in the workflow's source, and `eventId`
 *   the event's position in the log.
 */
export const RunOrigin = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("manual"), actor: Actor }),
  Schema.Struct({ kind: Schema.Literal("api"), actor: Actor }),
  Schema.Struct({ kind: Schema.Literal("action"), parentRunId: Id, stepId: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("trigger"), triggerId: Schema.String, eventId: EventId }),
]);

export type RunOrigin = Schema.Schema.Type<typeof RunOrigin>;

/**
 * The copy of the event that started a run, taken when the run was written.
 * It is the event as the log held it then, without `raw`: the vendor payload
 * is kept in the log for debugging only, and no filter or mapping reads it.
 */
export const TriggerEvent = Event.mapFields(Struct.omit(["raw"]));

export type TriggerEvent = Schema.Schema.Type<typeof TriggerEvent>;

/**
 * Why a step failed. `code` is a short word a program can act on, such as
 * `not_found`, `validation` or `unexpected`, and `message` is a sentence for
 * a person.
 */
export const StepError = Schema.Struct({ code: Schema.String, message: Schema.String });

export type StepError = Schema.Schema.Type<typeof StepError>;

/**
 * The edge a run failed at, for a run that failed with `expression-error` in
 * an edge's condition or with `iteration-limit`:
 *
 * - `index`: the edge's index in `plan.edges`;
 * - `message`: what went wrong at the edge, a sentence for a person: the
 *   condition's evaluation error, or the `maxTraversals` the run reached.
 *
 * A run that failed at a step has no failed edge; its step record holds the
 * error.
 */
export const FailedEdge = Schema.Struct({ index: Schema.Int, message: Schema.String });

export type FailedEdge = Schema.Schema.Type<typeof FailedEdge>;

/** The fields every step record has, whatever its status. */
const STEP_RECORD_FIELDS = {
  /** The step's id in the plan. */
  stepId: Schema.String,
  /** Counts the records of this step in the run, from 1. */
  iteration: Schema.Int,
  /**
   * The params an action step's action was called with: rendered from their
   * templates and checked against the action's input schema. Absent until
   * the step starts, and for an agent step.
   */
  input: Schema.optionalKey(Schema.Json),
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
 * - `completed`: `startedAt` and `finishedAt`, and the fields only a
 *   completed run has (`output`), which `completedFields` holds.
 * - `failed` at a step (`expression-error`, `step-failed` or
 *   `iteration-limit`): `failedStepId`, `startedAt` and `finishedAt`, and
 *   the fields only a run failed at a step has (`failedEdge`), which
 *   `failedAtStepFields` holds.
 * - `failed` with `validation-error`: `finishedAt` and `failureMessage`. The
 *   run never started, so it has no `startedAt`.
 * - `failed` with `controller-error`: `finishedAt`, and `failedStepId` and
 *   `startedAt` when the run had got that far.
 * - `failed` with `workspace-failed`: `startedAt` and `finishedAt`, and
 *   `failedStepId` when a workspace step was running.
 * - `cancelled`: `finishedAt`, and `startedAt` if the run had started.
 *
 * A run and a run summary share these rules, so both are built from here.
 */
const buildRunStatusVariants = <
  const Fields extends Schema.Struct.Fields,
  const CompletedFields extends Schema.Struct.Fields,
  const FailedAtStepFields extends Schema.Struct.Fields,
>(
  fields: Fields,
  completedFields: CompletedFields,
  failedAtStepFields: FailedAtStepFields,
) =>
  [
    Schema.Struct({ ...fields, status: Schema.Literal("pending") }),
    Schema.Struct({ ...fields, status: Schema.Literal("running"), startedAt: Timestamp }),
    Schema.Struct({
      ...fields,
      ...completedFields,
      status: Schema.Literal("completed"),
      startedAt: Timestamp,
      finishedAt: Timestamp,
    }),
    Schema.Struct({
      ...fields,
      ...failedAtStepFields,
      status: Schema.Literal("failed"),
      failureReason: Schema.Literals(["expression-error", "step-failed", "iteration-limit"]),
      failedStepId: Schema.String,
      startedAt: Timestamp,
      finishedAt: Timestamp,
    }),
    Schema.Struct({
      ...fields,
      status: Schema.Literal("failed"),
      failureReason: Schema.Literal("validation-error"),
      /** What did not validate, a sentence for a person. */
      failureMessage: Schema.String,
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
      status: Schema.Literal("failed"),
      failureReason: Schema.Literal("workspace-failed"),
      failedStepId: Schema.optionalKey(Schema.String),
      startedAt: Timestamp,
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
  buildRunStatusVariants(
    {
      id: Id,
      /** The workflow the run was started from. It stays set after that workflow is deleted. */
      workflowId: Schema.NullOr(Id),
      /** The workflow definition as it was when the run started. */
      plan: WorkflowDefinition,
      /** The inputs the run started with, with defaults applied. An optional input with no value is absent. */
      inputs: Schema.Record(Schema.String, Schema.Json),
      origin: RunOrigin,
      /** The event that started the run, for a run a start trigger started. */
      triggerEvent: Schema.optionalKey(TriggerEvent),
      /**
       * The runner the run is pinned to. Set when the run's first workspace
       * step starts; every workspace step of the run runs there.
       */
      runnerId: Schema.optionalKey(Id),
      /** The run's workspace, set when its first workspace step starts. */
      workspaceId: Schema.optionalKey(Id),
      steps: Schema.Array(StepRecord),
      /**
       * How many times the run has followed each edge: one count per edge of
       * `plan.edges`, in the same order, zeros included.
       */
      edgeTraversals: Schema.Array(Schema.Int),
      /** The run this run re-runs, when `run.rerun` started it. */
      originalRunId: Schema.optionalKey(Id),
      createdAt: Timestamp,
    },
    {
      /**
       * The output of the terminal step that ended the run. Absent when the run
       * completed without a terminal step, because every branch had finished.
       */
      output: Schema.optionalKey(Schema.Json),
    },
    {
      /** The edge the run failed at, when it failed at one. */
      failedEdge: Schema.optionalKey(FailedEdge),
    },
  ),
);

export type Run = Schema.Schema.Type<typeof Run>;

/**
 * One run in the run list: the run without its plan, step records and
 * output, which are long. `run.read` returns them. A summary has no
 * `failedEdge` either: an edge's index means nothing without the plan it
 * indexes, so a failed summary carries only its reason and `failedStepId`.
 */
export const RunSummary = Schema.Union(
  buildRunStatusVariants(
    {
      id: Id,
      /** The workflow the run was started from, or null for a workflow sent with `run.start`. */
      workflowId: Schema.NullOr(Id),
      /** The workflow's name as it was when the run started, from the run's plan. */
      workflowName: Schema.String,
      origin: RunOrigin,
      createdAt: Timestamp,
    },
    {},
    {},
  ),
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
   * Only runs started by this actor: `user`, `session:<id>`, `run:<id>` for
   * the runs a run's `run.start` steps started, or `system` for the runs a
   * start trigger started.
   */
  actor: Schema.optionalKey(Actor),
  /** Only the re-runs of this run. */
  originalRunId: Schema.optionalKey(Id),
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

/**
 * The input of `run.cancel`. `keepWorkspace` keeps the ephemeral workspace
 * of the run, and of every run cancelled with it, for inspection; by default
 * it is deleted.
 */
export const RunCancelInput = closedStruct({
  keepWorkspace: Schema.optionalKey(Schema.Boolean),
});

export type RunCancelInput = Schema.Schema.Type<typeof RunCancelInput>;

/**
 * How `run.rerun` chooses the plan of the new run:
 *
 * - `re-stamp`: the workflow as it is stored now, for a run whose workflow
 *   was changed after it ran. A run of a workflow sent with `run.start`, or
 *   of a workflow that was deleted since, has no stored workflow to re-stamp
 *   from.
 * - `replay`: the plan the original run froze when it started, so the new
 *   run is meant to do what the original run was meant to do.
 *
 * Either way the new run starts with the inputs the original run started
 * with.
 */
export const RERUN_MODES = ["re-stamp", "replay"] as const;

export const RerunMode = Schema.Literals(RERUN_MODES);

export type RerunMode = Schema.Schema.Type<typeof RerunMode>;

/** The input of `run.rerun`. `mode` is `re-stamp` when it is left out. */
export const RunRerunInput = closedStruct({
  mode: Schema.optionalKey(RerunMode),
});

export type RunRerunInput = Schema.Schema.Type<typeof RunRerunInput>;

/**
 * The fields every run event's payload has. The payload never names who ended
 * the run: the event's `actor` holds the actor whose request ended it, and is
 * `system` when the run ended on its own.
 */
const RUN_EVENT_FIELDS = {
  runId: Id,
  /** The stored workflow the run was started from, or null for a workflow sent with `run.start`. */
  workflowId: Schema.NullOr(Id),
  origin: RunOrigin,
  /** The inputs the run started with, with defaults applied. */
  inputs: Schema.Record(Schema.String, Schema.Json),
  /** Absent for a run that ended before it started, such as one cancelled while pending. */
  startedAt: Schema.optionalKey(Timestamp),
  finishedAt: Timestamp,
};

/** The payload of `run.completed`, which the controller emits when a run completes. */
export const RunCompletedEventPayload = Schema.Struct({
  ...RUN_EVENT_FIELDS,
  /** The output of the terminal step that ended the run, as on the run record. */
  output: Schema.optionalKey(Schema.Json),
});

export type RunCompletedEventPayload = Schema.Schema.Type<typeof RunCompletedEventPayload>;

/**
 * The payload of `run.failed`, which the controller emits when a run fails.
 * `failureReason`, `failedStepId`, `failedEdge` and `failureMessage` are the
 * run record's.
 */
export const RunFailedEventPayload = Schema.Struct({
  ...RUN_EVENT_FIELDS,
  failureReason: FailureReason,
  failedStepId: Schema.optionalKey(Schema.String),
  failedEdge: Schema.optionalKey(FailedEdge),
  failureMessage: Schema.optionalKey(Schema.String),
});

export type RunFailedEventPayload = Schema.Schema.Type<typeof RunFailedEventPayload>;

/**
 * The payload of `run.cancelled`, which the controller emits when a run is
 * cancelled. A cancellation is not a failure, so it has a kind of its own.
 */
export const RunCancelledEventPayload = Schema.Struct(RUN_EVENT_FIELDS);

export type RunCancelledEventPayload = Schema.Schema.Type<typeof RunCancelledEventPayload>;

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
     * had not ended are cancelled, and no step starts after it. Its ephemeral
     * workspace is deleted unless `keepWorkspace` is set. Fails with
     * `invalid_state` for a run that has already ended.
     */
    HttpApiEndpoint.post("cancel", "/runs/:id/cancel", {
      params: { id: Id },
      payload: RunCancelInput,
      success: Run,
      error: [Unauthenticated, Forbidden, Validation, NotFound, InvalidState, Internal],
    }),
    /**
     * Starts a new run with the inputs of a run that has ended, and returns
     * its id at once. The new run records the original run in
     * `originalRunId`. Fails with `invalid_state` for a run that has not
     * ended, and for a `re-stamp` of a run with no stored workflow to
     * re-stamp from; with `validation` when the new run cannot start, as for
     * `run.start`; and with `cap_exceeded` when it would be nested too deep.
     */
    HttpApiEndpoint.post("rerun", "/runs/:id/rerun", {
      params: { id: Id },
      payload: RunRerunInput,
      success: RunStarted,
      error: [
        Unauthenticated,
        Forbidden,
        Validation,
        NotFound,
        InvalidState,
        CapExceeded,
        Internal,
      ],
    }),
  )
  .middleware(Authenticated);
