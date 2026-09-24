/**
 * The run engine: starts runs of workflows and executes their steps.
 *
 * A run is only rows (the runs domain). Starting a run writes the run and a
 * step record for each entry step, and returns. The engine then executes the
 * run on a fiber of its own:
 *
 * 1. It reads the run and takes its first step record that is pending, or
 *    running because a restart cut it off.
 * 2. It moves a pending record to `running`, in a transaction of its own.
 * 3. It renders the step's params from the run's inputs and the outputs of
 *    the steps that have completed, and decodes them with the action's input
 *    schema.
 * 4. It calls the action, and ends the step record and adds a pending record
 *    for each step an edge leads to. A built-in action is called as the run,
 *    in the same transaction that ends its record. A plugin's action is
 *    called outside any transaction, and its record ends afterwards.
 * 5. It repeats until no step record is pending or running, and then
 *    completes the run.
 *
 * A built-in action's effect and the end of its step record commit together,
 * so a crash never leaves the effect committed with the step still unfinished. A
 * failed step, or a template that cannot be rendered, fails the run and
 * cancels the step records that have not run.
 *
 * Nothing about a run is held only in memory. When the controller starts, it
 * resumes every run that is pending or running from its rows. A built-in
 * action's step record found `running` then is executed again: its action
 * calls the controller's own services, in the transaction that would have
 * ended the record, so a record still `running` means that transaction never
 * committed and the action took no effect. A plugin's action reaches outside
 * the controller, so its step record found `running` may or may not have
 * taken effect; runs never retry such an action, and the step fails with the
 * code `interrupted`.
 *
 * Cancelling a run ends it and its unfinished step records in one
 * transaction, then interrupts the fiber executing it. A plugin's action in
 * flight sees its signal abort. An action that returns after the cancel
 * cannot end its step record any more, so the run stays cancelled and no
 * later step starts.
 *
 * If executing a run fails for a reason that is not the step's own failure,
 * such as a bug, the run fails at its current step with the code `unexpected`
 * rather than staying `running` until the next restart.
 *
 * A run executes its ready steps one at a time, in the order their records
 * were created. The actions it can call all write to the one database, so
 * running them side by side would not finish any sooner.
 *
 * Starting a run crosses domains - workflows, runs, Connections, the action
 * catalog, and each built-in action's own domain - which is why it is a
 * controller daemon use case.
 */
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { findJsonSchemaViolation } from "@hercule/protocol/json-schema";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  createDecodeValidationError,
  createInvalidStateError,
  createNotFoundError,
  createValidationError,
  formatIssue,
  Id,
  isApiError,
  isId,
  listDecodeIssues,
  listEntrySteps,
  quoteAuthorText,
  RunInputs,
  WorkflowSubmitInput,
  type FailureReason,
  type Forbidden,
  type InvalidState,
  type Issue,
  type NotFound,
  type Run,
  type RunOrigin,
  type RunStarted,
  type RunStatus,
  type StepError,
  type StepRecord,
  type TaskCreateInput,
  type TaskFilter,
  type Unauthenticated,
  type Validation,
  type WorkflowDefinition,
} from "@hercule/contract";
import { ActionError, type WorkflowActionContribution } from "@hercule/plugin-host";
import { CurrentActor, currentStamp, requireGrant, type RunActor } from "../actor";
import { connectionRepository } from "../connections";
import { AfterCommit, afterCommit, nowIso, withTransaction } from "../db";
import { renderTemplates } from "../expressions";
import { PluginHost, type RegisteredWorkflowAction } from "../plugins";
import { Identified, runRepository, StepRecordEnded } from "../runs";
import { TaskService } from "../tasks";
import { WorkflowService } from "../workflows";
import { absorbFailures } from "./absorbing";

/**
 * The input of `workflow.run`: the workflow's id from the path, and the
 * request's fields. It is decoded again here because an in-process caller
 * does not pass through the transport.
 */
const StartInput = Schema.Struct({
  id: Id,
  inputs: Schema.optionalKey(RunInputs),
});

type StartInput = Schema.Schema.Type<typeof StartInput>;

const decodeStartInput = Schema.decodeUnknownEffect(StartInput);

const decodeSubmitInput = Schema.decodeUnknownEffect(WorkflowSubmitInput);

const decodeIdentified = Schema.decodeUnknownEffect(Identified);

type Step = WorkflowDefinition["steps"][number];

/** An action a step can call while it runs, given its params decoded with the action's input schema. */
type BuiltInAction = (input: unknown) => Effect.Effect<unknown, unknown>;

/**
 * Returns an issue for each element of a definition that runs cannot execute
 * yet, each at its path. Such a workflow can be saved, but starting a run of
 * it is refused: a run that ignored a condition or a join would do something
 * the author did not write.
 */
const listUnsupportedElements = (
  definition: WorkflowDefinition,
  actions: ReadonlyArray<RegisteredWorkflowAction>,
): ReadonlyArray<Issue> => {
  const edges = definition.edges ?? [];
  const countIncomingEdges = (stepId: string): number =>
    edges.filter((edge) => edge.to === stepId).length;
  const triggerIssues = (definition.triggers ?? []).flatMap((trigger, index) =>
    trigger.kind === "signal"
      ? [
          {
            path: ["triggers", String(index)],
            message:
              "Runs cannot wait for signal triggers yet. Remove the signal trigger to run this workflow.",
          },
        ]
      : [],
  );
  const stepIssues = definition.steps.flatMap((step: Step, index): ReadonlyArray<Issue> => {
    const path = ["steps", String(index)];
    const issues: Array<Issue> = [];
    if (step.kind === "agent") {
      issues.push({
        path: [...path, "kind"],
        message: "Runs cannot run agent steps yet. Only action steps can run.",
      });
    } else if (actions.find((action) => action.id === step.action)?.connection !== undefined) {
      // Which of a step's params names the Connection is not settled yet, and
      // an action called without its Connection would fail in ways its
      // author never planned for.
      issues.push({
        path: [...path, "action"],
        message:
          "Runs cannot call an action that acts through a Connection yet. Remove this step to run this workflow.",
      });
    }
    if (step.condition !== undefined) {
      issues.push({
        path: [...path, "condition"],
        message:
          "Runs cannot evaluate step conditions yet. Remove the condition to run this workflow.",
      });
    }
    if (step.join !== undefined) {
      issues.push({
        path: [...path, "join"],
        message: "Runs cannot join branches yet. Remove join to run this workflow.",
      });
    }
    if (step.terminal !== undefined) {
      issues.push({
        path: [...path, "terminal"],
        message: "Runs cannot end at a terminal step yet. Remove terminal to run this workflow.",
      });
    }
    const leadingEdges = countIncomingEdges(step.id);
    if (leadingEdges > 1) {
      issues.push({
        path,
        message:
          "Runs cannot run a step that more than one edge leads into yet. Let only one edge lead into this step.",
      });
    } else if (leadingEdges === 1 && step.entry === true) {
      // The step would run once as an entry step and again when the edge
      // fires, and a step that runs twice needs the rules for loops.
      issues.push({
        path: [...path, "entry"],
        message:
          "Runs cannot start at a step that an edge also leads into yet. Remove entry, or the edge that leads into this step.",
      });
    }
    return issues;
  });
  const edgeIssues = edges.flatMap((edge, index): ReadonlyArray<Issue> => {
    const path = ["edges", String(index)];
    return [
      ...(edge.condition === undefined
        ? []
        : [
            {
              path: [...path, "condition"],
              message:
                "Runs cannot evaluate edge conditions yet. Remove the condition to run this workflow.",
            },
          ]),
      ...(edge.maxTraversals === undefined
        ? []
        : [
            {
              path: [...path, "maxTraversals"],
              message:
                "Runs cannot follow an edge more than once yet. Remove maxTraversals to run this workflow.",
            },
          ]),
    ];
  });
  return [...triggerIssues, ...stepIssues, ...edgeIssues];
};

/**
 * Checks a value against an input's JSON Schema. Returns a message that says
 * what is wrong, or `undefined` when the value is valid. A schema the
 * validator cannot use is reported as the problem, because the author has to
 * fix the workflow, not the value.
 */
const checkAgainstSchema = (
  schema: Record<string, unknown>,
  value: unknown,
): string | undefined => {
  try {
    const violation = findJsonSchemaViolation(schema, value);
    return violation === undefined
      ? undefined
      : `This value does not match the input's schema: ${violation}.`;
  } catch {
    return "The input's schema is not a JSON Schema the controller can check values with. Correct the schema in the workflow.";
  }
};

/**
 * Returns the error a step record stores for a failed action: a plugin's
 * `ActionError` as it is, and one of the API's errors, the ones the built-in
 * actions' services fail with, as its code and message. Returns `undefined`
 * for anything else.
 */
const describeActionFailure = (failure: unknown): StepError | undefined => {
  if (failure instanceof ActionError) return { code: failure.code, message: failure.message };
  if (!isApiError(failure)) return undefined;
  const { code, message } = failure.error;
  const issues = failure.error.code === "validation" ? failure.error.details.issues : [];
  return {
    code,
    message: issues.length === 0 ? message : `${message}: ${issues.map(formatIssue).join("; ")}`,
  };
};

/**
 * The step error for a run that could not be carried out at this step for a
 * reason of the controller's own, such as a bug, whether or not the step's
 * action had started.
 */
const UNEXPECTED_RUN_FAILURE: StepError = {
  code: "unexpected",
  message:
    "The controller could not carry out the run at this step. The controller's log has the details.",
};

/** The step error for an action that failed with something other than one of the API's errors, such as a database error or a bug. */
const UNEXPECTED_FAILURE: StepError = {
  code: "unexpected",
  message: "The action failed unexpectedly. The controller's log has the details.",
};

/**
 * Calls a plugin's action with a signal that aborts when the run is
 * cancelled, and returns its result encoded with the action's output schema.
 * Fails with the action's `ActionError`, or with an `ActionError` of code
 * `unexpected` when the result does not match the output schema: later steps
 * read the output, so a result of the wrong shape must not be stored as if
 * the step had succeeded.
 *
 * Cancelling a run interrupts the fiber that executes it, and the signal
 * passes that on to whatever the action waits on outside the controller.
 */
const executePluginAction = (
  action: RegisteredWorkflowAction,
  execute: WorkflowActionContribution["execute"],
  input: unknown,
  run: { readonly runId: string; readonly stepId: string },
): Effect.Effect<unknown, ActionError> =>
  Effect.suspend(() => {
    const cancelled = new AbortController();
    return Effect.flatMap(
      Effect.onInterrupt(execute(input, { run, signal: cancelled.signal }), () =>
        Effect.sync(() => cancelled.abort()),
      ),
      (output) =>
        Effect.mapError(
          Schema.encodeUnknownEffect(action.output as Schema.Codec<unknown>)(output),
          (error) =>
            new ActionError({
              code: "unexpected",
              message: `The action returned a value that does not match its output schema: ${listDecodeIssues(error).map(formatIssue).join("; ")}`,
            }),
        ),
    );
  });

/** Describes how a run ended, for the refusal to cancel it. */
const describeEnding = (status: RunStatus): string =>
  status === "cancelled" ? "has already been cancelled" : `has already ${status}`;

/** The step error for a plugin action's step record that a restart cut off while the action ran. */
const INTERRUPTED: StepError = {
  code: "interrupted",
  message:
    "The controller stopped while this step's action was running, so it may or may not have taken effect. Runs never retry an action; start a new run if it is needed.",
};

/** Returns the ids of the steps an edge from `stepId` leads to, in definition order. */
const listNextStepIds = (plan: WorkflowDefinition, stepId: string): ReadonlyArray<string> =>
  (plan.edges ?? []).filter((edge) => edge.from === stepId).map((edge) => edge.to);

/**
 * Returns the context a template is rendered against: the run's inputs, and
 * the output of each step that has completed.
 */
const buildRenderContext = (run: Run): Record<string, unknown> => ({
  inputs: run.inputs,
  steps: Object.fromEntries(
    run.steps
      .filter((record) => record.status === "completed")
      .map((record) => [record.stepId, { output: record.output }]),
  ),
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const runs = yield* runRepository;
  const connections = yield* connectionRepository;
  const workflows = yield* WorkflowService;
  const tasks = yield* TaskService;
  const host = yield* PluginHost;
  // The listener that publishes a committed change on the live topics. A run
  // executes on a fiber of the engine's own, not of the request that started
  // it, so the listener is provided to that fiber here.
  const listener = yield* AfterCommit;
  /** The fiber executing each run, by run id. A run has at most one. */
  const executing = yield* FiberMap.make<string>();
  const fork = yield* FiberMap.runtime(executing)<never>();

  /**
   * Runs one of a run's write sets in a transaction that cannot be
   * interrupted. Cancelling a run interrupts the fiber executing it, and an
   * interrupt that landed after the commit and before the transaction's
   * after-commit work would lose that work: the live announcements, and the
   * start of a child run that a `workflow.run` step committed. The write set
   * only touches the local database, so the interrupt waits a moment at most.
   */
  const commitUninterruptibly = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.uninterruptible(withTransaction(sql, effect));

  /**
   * The built-in actions, by id. Each calls the same service method as the
   * operation of the same id, so a step can do nothing an API request cannot.
   *
   * They are here rather than on the action catalog's entries (plugins
   * domain) because an action's code must reach the domain it acts on, and
   * the catalog sits below those domains. The `workflow.run` action starts
   * a run, which only this engine can do, and no domain may import the
   * controller daemon.
   */
  const builtInActions: ReadonlyMap<string, BuiltInAction> = new Map<string, BuiltInAction>([
    ["task.create", (input) => tasks.create(input as TaskCreateInput)],
    [
      "task.update",
      (input) => {
        // A request sends the task id in the path; a step has no path, so it
        // sends the id as taskId.
        const { taskId, ...fields } = input as { readonly taskId: string };
        return tasks.update({ id: taskId, ...fields });
      },
    ],
    // The action returns the first page. A step reads it to decide what the
    // run does next, and the first page is enough for that.
    ["task.query", (input) => tasks.query(input as TaskFilter)],
    [
      "workflow.run",
      (input) => {
        // As for task.update, the id a request sends in the path is a param.
        const { workflowId, ...fields } = input as {
          readonly workflowId: string;
          readonly inputs?: Record<string, Schema.Json>;
        };
        return startWorkflowRun({ id: workflowId, ...fields });
      },
    ],
  ]);

  /**
   * Resolves the values a run starts with: the caller's value for each
   * declared input, or its default. Returns the resolved inputs, or an issue
   * at `inputs.<name>` for each unknown input, missing required input, value
   * that fails the input's schema, and Connection that is missing, of the
   * wrong type or disabled. An optional input with no value and no default is
   * left out.
   */
  const resolveInputs = (
    declarations: NonNullable<WorkflowDefinition["inputs"]>,
    given: Readonly<Record<string, unknown>>,
  ): Effect.Effect<Result.Result<Record<string, unknown>, ReadonlyArray<Issue>>, SqlError> =>
    Effect.gen(function* () {
      const issues: Array<Issue> = [];
      const declared = new Set(declarations.map((input) => input.name));
      for (const name of Object.keys(given)) {
        if (!declared.has(name)) {
          issues.push({
            path: ["inputs", name],
            message: `This workflow declares no input named ${quoteAuthorText(name)}. Remove it, or use one of the declared inputs.`,
          });
        }
      }
      const resolved: Record<string, unknown> = {};
      for (const input of declarations) {
        const path = ["inputs", input.name];
        const value = Object.hasOwn(given, input.name) ? given[input.name] : input.default;
        if (value === undefined) {
          if (input.required) {
            issues.push({
              path,
              message: `Add a value for ${input.name}. This input is required.`,
            });
          }
          continue;
        }
        if (input.schema !== undefined) {
          const problem = checkAgainstSchema(input.schema, value);
          if (problem !== undefined) issues.push({ path, message: problem });
        } else if (input.connection !== undefined) {
          const wanted = input.connection.type;
          const found =
            typeof value === "string" && isId(value)
              ? yield* connections.one(value)
              : Option.none();
          if (Option.isNone(found)) {
            issues.push({
              path,
              message: `No Connection has this id. Give the id of a Connection of type ${wanted}.`,
            });
          } else if (found.value.type !== wanted) {
            issues.push({
              path,
              message: `This Connection is of type ${found.value.type}, but the input needs a Connection of type ${wanted}.`,
            });
          } else if (found.value.status === "disabled") {
            issues.push({
              path,
              message:
                "This Connection is disabled. Enable it, or give another Connection of the same type.",
            });
          }
        }
        resolved[input.name] = value;
      }
      return issues.length === 0 ? Result.succeed(resolved) : Result.fail(issues);
    });

  /**
   * Fails a run at one of its step records: the record fails with `error`,
   * every other record that has not run is cancelled, and the run fails with
   * `failureReason`. One transaction, so a reader never sees a failed run with
   * a step still pending. A record that has already ended keeps its ending.
   */
  const failRun = (
    runId: string,
    record: StepRecord,
    error: StepError,
    failureReason: FailureReason,
  ): Effect.Effect<void, SqlError> =>
    commitUninterruptibly(
      Effect.gen(function* () {
        const at = yield* nowIso;
        yield* Effect.catchTag(
          runs.finishStep(
            runId,
            record,
            { status: "failed", error },
            { startedAt: record.startedAt ?? at, finishedAt: at },
          ),
          "StepRecordEnded",
          () => Effect.void,
        );
        yield* runs.cancelUnfinishedSteps(runId, at);
        yield* runs.finish(
          runId,
          { status: "failed", failureReason, failedStepId: record.stepId },
          at,
        );
      }),
    );

  /**
   * Executes one pending or running step record of a run, and records how it
   * ended. A failure of the step fails the run; this effect itself fails only
   * when the database does. Does nothing if the step record ended before its
   * action was called, because the run was cancelled.
   *
   * A built-in action's effect and the end of its step record commit in one
   * transaction. A plugin's action reaches outside the controller, so it is
   * called after its record's `running` commits and outside any transaction,
   * and its record ends in a transaction of its own.
   */
  const executeStep = (run: Run, pending: StepRecord): Effect.Effect<void, SqlError> =>
    Effect.catchTag(
      Effect.gen(function* () {
        // Starting the run checked that every step is an action step, and
        // the plan never changes.
        const step = run.plan.steps.find((candidate) => candidate.id === pending.stepId);
        if (step === undefined || step.kind !== "action") {
          return yield* Effect.die(
            `the plan of run ${run.id} has no action step ${pending.stepId}`,
          );
        }
        const startedAt = pending.startedAt ?? (yield* nowIso);
        const record: StepRecord = { ...pending, status: "running", startedAt };
        if (pending.status === "pending") {
          yield* commitUninterruptibly(runs.startStep(run.id, record, startedAt));
        }
        const rendered = yield* Effect.result(
          renderTemplates(step.params ?? {}, buildRenderContext(run)),
        );
        if (Result.isFailure(rendered)) {
          return yield* failRun(
            run.id,
            record,
            { code: "expression_error", message: rendered.failure.message },
            "expression-error",
          );
        }
        const catalogEntry = (yield* host.listActiveWorkflowActions()).find(
          (action) => action.id === step.action,
        );
        // A built-in action is called through the engine's own map, and a
        // plugin's action through the `execute` its plugin registered.
        const builtIn = builtInActions.get(step.action);
        const execute = catalogEntry?.execute;
        const call =
          builtIn !== undefined
            ? ({ kind: "built-in", builtIn } as const)
            : execute !== undefined
              ? ({ kind: "plugin", execute } as const)
              : undefined;
        if (catalogEntry === undefined || call === undefined) {
          return yield* failRun(
            run.id,
            record,
            { code: "not_found", message: `The action ${step.action} is not available.` },
            "step-failed",
          );
        }
        const decoded = Schema.decodeUnknownResult(catalogEntry.input as Schema.Codec<unknown>)(
          rendered.success,
          { errors: "all", onExcessProperty: "error" },
        );
        if (Result.isFailure(decoded)) {
          return yield* failRun(
            run.id,
            record,
            {
              code: "validation",
              message: `The rendered params do not match the action's input: ${listDecodeIssues(decoded.failure).map(formatIssue).join("; ")}`,
            },
            "step-failed",
          );
        }
        const actor: RunActor = { _tag: "run", runId: run.id, stepId: record.stepId };
        const completeStep = (output: unknown) =>
          Effect.gen(function* () {
            const finishedAt = yield* nowIso;
            yield* runs.finishStep(
              run.id,
              record,
              { status: "completed", output },
              { startedAt, finishedAt },
            );
            yield* runs.insertSteps(run.id, listNextStepIds(run.plan, record.stepId), finishedAt);
          });
        // Returns the error to fail the step with, or `undefined` when
        // something else ended the step while its action ran, such as a
        // cancel. That ending stands, and a built-in action's effect rolled
        // back with its transaction.
        const describeFailure = (
          cause: Cause.Cause<unknown>,
        ): Effect.Effect<StepError | undefined> => {
          if (Cause.hasInterrupts(cause)) return Effect.interrupt;
          const error = Option.getOrUndefined(Cause.findErrorOption(cause));
          if (error instanceof StepRecordEnded) return Effect.succeed(undefined);
          const described = describeActionFailure(error);
          return described === undefined
            ? Effect.as(
                Effect.logError(`Step ${record.stepId} of run ${run.id} failed`, cause),
                UNEXPECTED_FAILURE,
              )
            : Effect.succeed(described);
        };
        if (call.kind === "built-in") {
          const failure = yield* Effect.catchCause(
            Effect.as(
              commitUninterruptibly(
                Effect.flatMap(
                  Effect.provideService(call.builtIn(decoded.success), CurrentActor, actor),
                  completeStep,
                ),
              ),
              undefined,
            ),
            describeFailure,
          );
          if (failure !== undefined) yield* failRun(run.id, record, failure, "step-failed");
          return;
        }
        const executed = yield* Effect.catchCause(
          Effect.map(
            executePluginAction(catalogEntry, call.execute, decoded.success, {
              runId: run.id,
              stepId: record.stepId,
            }),
            (output) => Result.succeed(output),
          ),
          (cause) => Effect.map(describeFailure(cause), (failure) => Result.fail(failure)),
        );
        if (Result.isFailure(executed)) {
          if (executed.failure !== undefined) {
            yield* failRun(run.id, record, executed.failure, "step-failed");
          }
          return;
        }
        // A database failure here is not the action's: it has already taken
        // effect. It fails this effect, and the run fails as one the
        // controller could not carry out.
        yield* commitUninterruptibly(completeStep(executed.success));
      }),
      "StepRecordEnded",
      () => Effect.void,
    );

  /**
   * Executes a run from its rows until it has ended. Reads the run again
   * after each step, because each step adds the records of the steps after it.
   */
  const executeRun = (runId: string): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      for (;;) {
        const found = yield* runs.read(runId);
        if (Option.isNone(found)) return;
        const run = found.value;
        if (run.status !== "pending" && run.status !== "running") return;
        if (run.status === "pending") {
          yield* commitUninterruptibly(Effect.flatMap(nowIso, (at) => runs.start(runId, at)));
        }
        const next = run.steps.find(
          (record) => record.status === "running" || record.status === "pending",
        );
        if (next === undefined) {
          return yield* commitUninterruptibly(
            Effect.flatMap(nowIso, (at) => runs.finish(runId, { status: "completed" }, at)),
          );
        }
        const step = run.plan.steps.find((candidate) => candidate.id === next.stepId);
        if (
          next.status === "running" &&
          !(step?.kind === "action" && builtInActions.has(step.action))
        ) {
          return yield* failRun(runId, next, INTERRUPTED, "step-failed");
        }
        yield* executeStep(run, next);
      }
    });

  /**
   * Fails a run that could not be carried out for a reason other than a step's own
   * failure, such as a bug: at its current step with the code `unexpected`,
   * or as a whole if no step is current.
   */
  const failRunUnexpectedly = (runId: string): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      const found = yield* runs.read(runId);
      if (Option.isNone(found)) return;
      const current = found.value.steps.find(
        (record) => record.status === "running" || record.status === "pending",
      );
      if (current !== undefined) {
        return yield* failRun(runId, current, UNEXPECTED_RUN_FAILURE, "step-failed");
      }
      yield* commitUninterruptibly(
        Effect.flatMap(nowIso, (at) =>
          runs.finish(runId, { status: "failed", failureReason: "step-failed" }, at),
        ),
      );
    });

  /**
   * Starts executing a run on a fiber of the engine's own, unless a fiber
   * already executes it, and returns at once. It is synchronous so that it
   * can run right after a commit (see `afterCommit`).
   *
   * A forked fiber starts running on the caller's thread until its first
   * wait, and a step's database work never waits. The fiber therefore yields
   * first, so the request that started the run is answered before any step
   * runs, rather than after the whole run.
   */
  const executeInBackground = (runId: string): void => {
    const execution = Effect.catchCause(
      Effect.andThen(Effect.yieldNow, executeRun(runId)),
      (cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.failCause(cause)
          : Effect.andThen(
              Effect.logError(`Executing run ${runId} failed, so the run fails`, cause),
              absorbFailures(`Failing run ${runId} failed`, failRunUnexpectedly(runId)),
            ),
    );
    fork(runId, Effect.provideService(execution, AfterCommit, listener), {
      onlyIfMissing: true,
    });
  };

  /**
   * Stops the fiber executing a run, if one is, without waiting for it to
   * stop. It is synchronous so that it can run right after a commit.
   */
  const stopExecuting = (runId: string): void => {
    const fiber = FiberMap.getUnsafe(executing, runId);
    if (Option.isSome(fiber)) fiber.value.interruptUnsafe();
  };

  /**
   * Starts a run of a definition: validates it again, refuses what runs
   * cannot execute yet, resolves the inputs, and writes the run and its entry
   * step records. Returns the run's id at once, without waiting for any step.
   * Fails with `Validation`, starting no run, when the definition does not
   * validate or the inputs do not match its declarations, and with whatever
   * `readPlan` fails with.
   *
   * `readPlan` runs inside the transaction, so a stored workflow cannot change
   * between being read and its run being written.
   */
  const startRun = <E>(
    readPlan: Effect.Effect<WorkflowDefinition, E>,
    fields: {
      readonly workflowId: string | null;
      readonly inputs: Readonly<Record<string, unknown>>;
      readonly origin: RunOrigin;
    },
  ): Effect.Effect<RunStarted, E | Validation | SqlError> =>
    // Uninterruptible, because it only touches the local database: a caller
    // that disconnects while it commits must not leave a committed run whose
    // fiber was never started.
    Effect.uninterruptible(
      withTransaction(
        sql,
        Effect.gen(function* () {
          const plan = yield* readPlan;
          // What runs cannot do yet is checked only on a valid definition: an
          // action that does not exist is reported once, as unknown.
          const invalid = (yield* workflows.validateDefinition(plan)).errors;
          const problems =
            invalid.length > 0
              ? invalid
              : listUnsupportedElements(plan, yield* host.listActiveWorkflowActions());
          if (problems.length > 0) {
            return yield* Effect.fail(
              createValidationError(
                problems,
                fields.workflowId === null
                  ? "this workflow cannot run"
                  : "this workflow cannot run as it is saved now",
              ),
            );
          }
          const inputs = yield* resolveInputs(plan.inputs ?? [], fields.inputs);
          if (Result.isFailure(inputs)) {
            return yield* Effect.fail(
              createValidationError(inputs.failure, "the inputs are not valid"),
            );
          }
          const runId = yield* runs.insert(
            {
              workflowId: fields.workflowId,
              plan,
              inputs: inputs.success,
              origin: fields.origin,
              entryStepIds: listEntrySteps(plan).map((step) => step.id),
            },
            yield* nowIso,
          );
          // After the commit, so the fiber reads the rows this transaction
          // wrote. It runs even if the caller disconnects after the commit,
          // so a run that exists always starts. A run started by a step of
          // another run commits with that step, so it starts only if the step
          // completes.
          yield* afterCommit(() => executeInBackground(runId));
          return { runId };
        }),
      ),
    );

  /**
   * `workflow.run`: starts a run of a stored workflow and returns its id,
   * without waiting for any step. Fails with `NotFound` for an unknown
   * workflow, and with `Validation`, starting no run, when the workflow no
   * longer validates, has an element runs cannot execute yet, or the inputs
   * do not match its declarations. A disabled workflow can still be run:
   * `enabled` only decides whether its triggers match events.
   *
   * The `workflow.run` action calls it too, as the run whose step it is.
   */
  const startWorkflowRun = (
    input: StartInput,
  ): Effect.Effect<RunStarted, Unauthenticated | Forbidden | Validation | NotFound | SqlError> =>
    Effect.gen(function* () {
      const actor = yield* requireGrant("workflow.run");
      const decoded = yield* Effect.mapError(decodeStartInput(input), createDecodeValidationError);
      // The user starts a run by hand, from the web app or the CLI. A run's
      // step starts a child run. Any other caller is a program using the API.
      const origin: RunOrigin =
        actor._tag === "run"
          ? { kind: "action", parentRunId: actor.runId, stepId: actor.stepId }
          : { kind: actor._tag === "user" ? "manual" : "api", actor: yield* currentStamp };
      return yield* startRun(
        Effect.flatMap(
          workflows.readDefinition(decoded.id),
          Option.match({
            onNone: () => Effect.fail(createNotFoundError("no such workflow")),
            onSome: Effect.succeed,
          }),
        ),
        { workflowId: decoded.id, inputs: decoded.inputs ?? {}, origin },
      );
    });

  return {
    startWorkflowRun,

    /**
     * `workflow.submit`: starts a run of a workflow the request sends as
     * `source` or `definition`, and returns its id without waiting for any
     * step. The workflow is validated like a save and never stored, so the
     * run's `workflowId` is null. Fails with `Validation`, starting no run,
     * as `workflow.run` does.
     */
    submitWorkflow: (
      input: WorkflowSubmitInput,
    ): Effect.Effect<RunStarted, Unauthenticated | Forbidden | Validation | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("workflow.submit");
        const decoded = yield* Effect.mapError(
          decodeSubmitInput(input),
          createDecodeValidationError,
        );
        const plan = yield* workflows.parseDefinition(decoded);
        return yield* startRun(Effect.succeed(plan), {
          workflowId: null,
          inputs: decoded.inputs ?? {},
          origin: { kind: "api", actor: yield* currentStamp },
        });
      }),

    /**
     * `run.cancel`: cancels a pending or running run and returns it. The run
     * and every step record that has not ended are cancelled in one
     * transaction, and then the fiber executing the run is interrupted, which
     * aborts the signal of a plugin action in flight. A step whose action
     * ends after the cancel cannot end its record any more, and no later step
     * starts. Fails with `NotFound` for an unknown run, and with
     * `InvalidState` for a run that has already ended.
     */
    cancelRun: (
      input: typeof Identified.Type,
    ): Effect.Effect<
      Run,
      Unauthenticated | Forbidden | Validation | NotFound | InvalidState | SqlError
    > =>
      Effect.gen(function* () {
        yield* requireGrant("run.cancel");
        const { id } = yield* Effect.mapError(decodeIdentified(input), createDecodeValidationError);
        return yield* Effect.uninterruptible(
          withTransaction(
            sql,
            Effect.gen(function* () {
              const found = yield* runs.read(id);
              if (Option.isNone(found)) {
                return yield* Effect.fail(createNotFoundError("no such run"));
              }
              const { status } = found.value;
              if (status !== "pending" && status !== "running") {
                return yield* Effect.fail(
                  createInvalidStateError(
                    `the run ${describeEnding(status)}; only a pending or running run can be cancelled`,
                  ),
                );
              }
              const at = yield* nowIso;
              yield* runs.cancelUnfinishedSteps(id, at);
              yield* runs.finish(id, { status: "cancelled" }, at);
              yield* afterCommit(() => stopExecuting(id));
              // The same transaction found the run above, and runs are never
              // deleted.
              return Option.getOrThrow(yield* runs.read(id));
            }),
          ),
        );
      }),

    /**
     * Resumes every run that is pending or running and has no fiber executing
     * it. The controller calls this when it starts: the rows of a run that a
     * restart cut off are all there is to continue it from.
     */
    resumeUnfinishedRuns: Effect.map(runs.listUnfinished(), (ids) => {
      for (const runId of ids) executeInBackground(runId);
    }),
  };
});

/** The run engine: starts runs and executes their steps. */
export class RunEngine extends Context.Service<RunEngine, Effect.Success<typeof make>>()(
  "hercule/controller/daemon/RunEngine",
) {}

export const RunEngineLayer: Layer.Layer<
  RunEngine,
  never,
  SqlClient.SqlClient | WorkflowService | TaskService | PluginHost | AfterCommit
> = Layer.effect(RunEngine)(make);

/**
 * Resumes every unfinished run, as the controller does when it starts
 * serving. A resume that cannot even list the runs is a broken database, which
 * nothing after it could work around, so it dies.
 */
export const resumeUnfinishedRuns: Effect.Effect<void, never, RunEngine> = Effect.orDie(
  Effect.flatMap(RunEngine, (engine) => engine.resumeUnfinishedRuns),
);
