/**
 * Starting a run: what `run.start` and `run.rerun` check before they write a
 * run, and the write itself. The run engine (`engine.ts`) serves both
 * operations, the `run.start` action, and the runs that start triggers start
 * through this, and hands each run to the Run Executor once it commits.
 *
 * Starting a run reads the workflows domain, the action catalog, the fleet's
 * runners and the controller's settings. All four sit below runs in the
 * domain graph.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  createCapExceededError,
  createDecodeValidationError,
  createInvalidStateError,
  createNotFoundError,
  createValidationError,
  formatIssue,
  isId,
  listEntrySteps,
  RunRerunInput,
  RunStartInput,
  type CapExceeded,
  type Event,
  type Forbidden,
  type InvalidState,
  type Issue,
  type NotFound,
  type Run,
  type RunOrigin,
  type RunStarted,
  type Unauthenticated,
  Validation,
  type WorkflowDefinition,
} from "@hercule/contract";
import { checkActorHoldsGrant, currentStamp, requireGrant, type Actor } from "../actor";
import { connectionRepository } from "../connections";
import { afterCommit, nowIso, withTransaction } from "../db";
import { CONNECTION_PARAM, PluginHost } from "../plugins";
import { runnerRepository } from "../runners";
import { Settings, type SettingError } from "../settings";
import { workflowRepository, WorkflowService, type PendingTriggerEffect } from "../workflows";
import { runRepository, type RunOutcome } from "./repository";
import { describeMissingCapableRunner, listWorkspaceActionIds } from "./runner-capabilities";
import { isUnfinished } from "./step-records";

/**
 * How many runs deep a run may be when the controller's `run.nestingLimit`
 * setting is not set. A run started by hand or through the API is 1 deep; a
 * run that a `run.start` step starts is one deeper than the step's run.
 */
const DEFAULT_RUN_NESTING_LIMIT = 5;

const decodeStartInput = Schema.decodeUnknownEffect(RunStartInput);
const decodeRerunInput = Schema.decodeUnknownEffect(RunRerunInput);

type PlanStep = WorkflowDefinition["steps"][number];

/** The refusal of a `run.start` that names no workflow, or more than one. */
const ONE_WORKFLOW =
  "Send exactly one of workflowId (a stored workflow), source (YAML text) or definition (an object).";

/** The errors `run.start` can fail with. */
export type RunStartError =
  Unauthenticated | Forbidden | Validation | NotFound | CapExceeded | SettingError | SqlError;

/** The errors `run.rerun` can fail with. */
export type RunRerunError = RunStartError | InvalidState;

/**
 * What a refused re-run tells the caller to do instead, when the original
 * run's plan may still run although the stored workflow cannot.
 */
const REPLAY_HINT = "Replay the original run's plan instead.";

/**
 * The messages of the `Validation` errors `writeRun` fails with, which differ
 * with where the run's plan and inputs came from.
 */
interface RefusalMessages {
  /** The message when the plan does not validate or has an element runs cannot execute yet. */
  readonly unrunnablePlan: string;
  /** The message when the inputs do not match the plan's declarations. */
  readonly invalidInputs: string;
}

/** The refusal messages of a run of the workflow the caller sent. */
const SENT_WORKFLOW_REFUSALS: RefusalMessages = {
  unrunnablePlan: "this workflow cannot run",
  invalidInputs: "the inputs are not valid",
};

/** The refusal messages of a run of a stored workflow. */
const STORED_WORKFLOW_REFUSALS: RefusalMessages = {
  unrunnablePlan: "this workflow cannot run as it is saved now",
  invalidInputs: "the inputs are not valid",
};

/**
 * The refusal messages of a run a start trigger starts. The inputs came from
 * the trigger's mapping, not from a caller.
 */
const TRIGGERED_RUN_REFUSALS: RefusalMessages = {
  unrunnablePlan: "this workflow cannot run as it is saved now",
  invalidInputs: "the inputs the trigger mapped from the event are not valid",
};

/**
 * The refusal messages of a re-stamp. Both point at replay, because the
 * original run's plan and inputs matched each other when it ran. A missing
 * runner is not among them: a replay needs the same runners.
 */
const RESTAMP_REFUSALS: RefusalMessages = {
  unrunnablePlan: `this workflow cannot run as it is saved now. ${REPLAY_HINT}`,
  invalidInputs: `the original run's inputs do not match the workflow as it is saved now. ${REPLAY_HINT}`,
};

/** The refusal messages of a replay. */
const REPLAY_REFUSALS: RefusalMessages = {
  unrunnablePlan: "the original run's plan cannot run any more",
  invalidInputs: "the original run's inputs no longer match its plan",
};

/**
 * Returns an issue for each element of a definition that runs cannot execute
 * yet, each at its path. Such a workflow can be saved, but starting a run of
 * it is refused: a run that ignored a step or a trigger it cannot execute
 * would do something the author did not write.
 */
const listUnsupportedElements = (definition: WorkflowDefinition): ReadonlyArray<Issue> => {
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
  const stepIssues = definition.steps.flatMap((step: PlanStep, index): ReadonlyArray<Issue> => {
    if (step.kind !== "agent") return [];
    return [
      {
        path: ["steps", String(index), "kind"],
        message: "Runs cannot run agent steps yet. Only action steps can run.",
      },
    ];
  });
  return [...triggerIssues, ...stepIssues];
};

/**
 * A run about to be written: the plan it runs, the stored workflow the plan
 * belongs to, if any, the inputs as given, and the run it re-runs, if any.
 */
interface RunToWrite {
  readonly plan: WorkflowDefinition;
  readonly workflowId: string | null;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly originalRunId?: string;
}

/** The message of the `Forbidden` error for a sent workflow that acts through a Connection. */
const CONNECTION_USE_REFUSAL =
  "This run's definition has a step that acts through a Connection, and this session lacks the connection.use grant. Start a stored workflow that names the Connection instead, or ask the user to grant connection.use.";

/**
 * Returns the message a run stores when it could not start: the refusal's
 * message as a sentence, followed by each issue with its path.
 */
const describeRefusal = (refusal: Validation): string => {
  const { message, details } = refusal.error;
  const sentence = message.charAt(0).toUpperCase() + message.slice(1);
  return details.issues.length === 0
    ? `${sentence}.`
    : `${sentence}: ${details.issues.map(formatIssue).join("; ")}`;
};

/**
 * Returns the origin of a run that `actor` starts. The user starts a run by
 * hand, from the web app or the CLI. A run's step starts a child run. Any
 * other caller is a program using the API.
 */
const decideOrigin = (actor: Actor): Effect.Effect<RunOrigin> =>
  actor._tag === "run"
    ? Effect.succeed({ kind: "action", parentRunId: actor.runId, stepId: actor.stepId })
    : Effect.map(currentStamp, (stamp) => ({
        kind: actor._tag === "user" ? "manual" : "api",
        actor: stamp,
      }));

/**
 * Builds `run.start`, `run.rerun` and the start of a run by a start trigger.
 *
 * - `executeInBackground` is called with the new run's id once the run's
 *   rows commit; the engine passes the function that hands the run's
 *   execution to the Run Executor.
 * - `writeRunEnding` ends a run inside the caller's transaction; the engine
 *   passes its own, the one place every run ends.
 */
export const makeRunStart = (
  executeInBackground: (runId: string) => void,
  writeRunEnding: (runId: string, outcome: RunOutcome, at: string) => Effect.Effect<void, SqlError>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const runs = yield* runRepository;
    const storedWorkflows = yield* workflowRepository;
    const workflows = yield* WorkflowService;
    const host = yield* PluginHost;
    const settings = yield* Settings;
    const runners = yield* runnerRepository;
    const connections = yield* connectionRepository;

    /**
     * Checks that a run started by a step of another run is not nested
     * deeper than the controller's `run.nestingLimit`. Fails with
     * `CapExceeded` when it would be. A run that no run started is 1 deep,
     * which the limit always allows.
     */
    const checkNesting = (
      origin: RunOrigin,
    ): Effect.Effect<void, CapExceeded | SettingError | SqlError> =>
      Effect.gen(function* () {
        if (origin.kind !== "action") return;
        const depth = (yield* runs.measureNesting(origin.parentRunId)) + 1;
        const limit = (yield* settings.all())["run.nestingLimit"] ?? DEFAULT_RUN_NESTING_LIMIT;
        if (depth <= limit) return;
        return yield* Effect.fail(
          createCapExceededError(
            { count: depth, cap: limit },
            `This run would be ${String(depth)} runs deep, and the limit is ${String(limit)}. A workflow may be starting itself, directly or through another workflow. Raise the run.nestingLimit setting, or change the workflow.`,
          ),
        );
      });

    /**
     * Returns an issue for each step of a valid `plan` that names a disabled
     * Connection as a literal id in its `connection` param, at the param's
     * path. Only steps whose action acts through a Connection are checked.
     *
     * Saving the workflow checked that the Connection exists and is of the
     * right type, but not that it is enabled: it can be enabled again before
     * a run starts, in the same way as the default of a Connection input. A
     * template is rendered only when the step runs, so the run engine checks
     * the Connection it names then.
     */
    const listDisabledConnectionIssues = (
      plan: WorkflowDefinition,
    ): Effect.Effect<ReadonlyArray<Issue>, SqlError> =>
      Effect.gen(function* () {
        const actions = yield* host.listActiveWorkflowActions();
        const issues: Array<Issue> = [];
        for (const [index, step] of plan.steps.entries()) {
          if (step.kind !== "action") continue;
          const action = actions.find((candidate) => candidate.id === step.action);
          const connectionId = step.params?.[CONNECTION_PARAM];
          if (action?.connection === undefined || !isId(connectionId)) continue;
          const found = yield* connections.one(connectionId);
          if (Option.isSome(found) && found.value.status === "disabled") {
            issues.push({
              path: ["steps", String(index), "params", CONNECTION_PARAM],
              message: `This Connection is disabled. Enable it, or name another Connection of type ${action.connection.type}.`,
            });
          }
        }
        return issues;
      });

    /**
     * Checks that `actor` may start the sent workflow `plan`. Fails with
     * `Forbidden` when a step calls an action that acts through a Connection
     * and the actor lacks the `connection.use` grant.
     *
     * A stored workflow needs no such check: the user authored its steps, and
     * a caller can only fill in the Connection inputs the user declared. A
     * sent workflow is authored by the caller, who could otherwise act
     * through any Connection. A template in the step's `connection` param is
     * no safer than a literal id, because a sent workflow declares its own
     * inputs.
     */
    const requireConnectionUse = (
      plan: WorkflowDefinition,
      actor: Actor,
    ): Effect.Effect<void, Forbidden> =>
      Effect.gen(function* () {
        const actions = yield* host.listActiveWorkflowActions();
        const actsThroughConnection = plan.steps.some(
          (step) =>
            step.kind === "action" &&
            actions.some((action) => action.id === step.action && action.connection !== undefined),
        );
        if (!actsThroughConnection) return;
        const refused = checkActorHoldsGrant("connection.use", actor, CONNECTION_USE_REFUSAL);
        if (refused !== undefined) return yield* Effect.fail(refused);
      });

    /**
     * Checks that `plan` can run with `unresolvedInputs`, and returns the
     * inputs with their defaults applied. It validates the plan again,
     * refuses what runs cannot execute yet and steps that name a disabled
     * Connection, and resolves the inputs. Fails with `Validation` when any
     * check fails, with the message from `refusals` where it has one.
     */
    const checkRunnable = (
      plan: WorkflowDefinition,
      unresolvedInputs: Readonly<Record<string, unknown>>,
      refusals: RefusalMessages,
    ): Effect.Effect<Record<string, unknown>, Validation | SqlError> =>
      Effect.gen(function* () {
        // What runs cannot do yet is checked only on a valid definition:
        // an action that does not exist is reported once, as unknown.
        const invalid = (yield* workflows.validateDefinition(plan)).errors;
        const problems =
          invalid.length > 0
            ? invalid
            : [...listUnsupportedElements(plan), ...(yield* listDisabledConnectionIssues(plan))];
        if (problems.length > 0) {
          return yield* Effect.fail(createValidationError(problems, refusals.unrunnablePlan));
        }
        const inputs = yield* workflows.resolveRunInputs(plan, unresolvedInputs);
        if (Result.isFailure(inputs)) {
          return yield* Effect.fail(createValidationError(inputs.failure, refusals.invalidInputs));
        }
        return inputs.success;
      });

    /**
     * Checks that some runner can run the workspace steps of `plan`. Fails
     * with `Validation` when none can. A retired runner never takes the run,
     * and neither does a reserved one, because a run names no runner. An
     * offline or draining one may come back, and the run waits for it.
     */
    const checkCapableRunner = (
      plan: WorkflowDefinition,
    ): Effect.Effect<void, Validation | SqlError> =>
      Effect.gen(function* () {
        const missingRunner = describeMissingCapableRunner(
          listWorkspaceActionIds(plan),
          yield* runners.listPlacementCandidates(),
        );
        if (missingRunner === undefined) return;
        return yield* Effect.fail(
          createValidationError(
            [{ path: [], message: missingRunner }],
            "no runner can run this workflow",
          ),
        );
      });

    /**
     * Writes the run `readRunToWrite` returns: checks that it can run (see
     * `checkRunnable`), that a runner can run it (see `checkCapableRunner`),
     * checks how deep the run is nested, and writes the run
     * and its entry step records. Returns the run's id at once, without
     * waiting for any step. Fails, starting no run, with:
     *
     * - `Validation` when `checkRunnable` or `checkCapableRunner` refuses the run;
     * - `CapExceeded` when the run is nested too deep;
     * - whatever `readRunToWrite` fails with.
     *
     * `readRunToWrite` runs inside the transaction, so a stored workflow
     * cannot change between being read and its run being written.
     */
    const writeRun = <E>(
      readRunToWrite: Effect.Effect<RunToWrite, E>,
      origin: RunOrigin,
      refusals: RefusalMessages,
    ): Effect.Effect<RunStarted, E | Validation | CapExceeded | SettingError | SqlError> =>
      withTransaction(
        sql,
        Effect.gen(function* () {
          const { plan, workflowId, inputs, originalRunId } = yield* readRunToWrite;
          const resolvedInputs = yield* checkRunnable(plan, inputs, refusals);
          yield* checkCapableRunner(plan);
          yield* checkNesting(origin);
          const runId = yield* runs.insert(
            {
              workflowId,
              plan,
              inputs: resolvedInputs,
              origin,
              entryStepIds: listEntrySteps(plan).map((step) => step.id),
              ...(originalRunId === undefined ? {} : { originalRunId }),
            },
            yield* nowIso,
          );
          // After the commit, so the execution reads the rows this
          // transaction wrote. It runs even if the caller disconnects after
          // the commit, so a run that exists always starts. A run started by
          // a step of another run commits with that step, so it starts only
          // if the step completes.
          yield* afterCommit(() => executeInBackground(runId));
          return { runId };
        }),
      );

    /**
     * Reads a stored workflow's definition. Fails with the error
     * `createMissingError` returns when no workflow has the id.
     */
    const readStoredDefinition = <E>(
      workflowId: string,
      createMissingError: () => E,
    ): Effect.Effect<WorkflowDefinition, E | SqlError> =>
      Effect.flatMap(
        storedWorkflows.readDefinition(workflowId),
        Option.match({ onNone: () => Effect.fail(createMissingError()), onSome: Effect.succeed }),
      );

    /**
     * `run.start`: starts a run of a stored workflow, or of a workflow the
     * request sends as `source` or `definition`, and returns its id without
     * waiting for any step. A sent workflow is validated like a save and
     * never stored, so the run's `workflowId` is null. A disabled workflow
     * can still be run: `enabled` only decides whether its triggers match
     * events.
     *
     * Fails with:
     *
     * - `Validation`, starting no run, when the request names no workflow or
     *   more than one, the workflow does not validate or has an element runs
     *   cannot execute yet, no runner that is not retired offers every
     *   workspace action the workflow uses, or the inputs do not match its
     *   declarations;
     * - `NotFound` for an unknown `workflowId`;
     * - `Forbidden` when the request sends a workflow with a step that acts
     *   through a Connection, and the caller lacks the `connection.use` grant;
     * - `CapExceeded` when the run would be nested deeper than the
     *   controller's `run.nestingLimit`.
     *
     * The `run.start` action calls it too, as the run whose step it is.
     */
    const start = (input: RunStartInput): Effect.Effect<RunStarted, RunStartError> =>
      Effect.gen(function* () {
        const actor = yield* requireGrant("run.start");
        const {
          workflowId,
          inputs = {},
          ...content
        } = yield* Effect.mapError(decodeStartInput(input), createDecodeValidationError);
        const sendsWorkflow = content.source !== undefined || content.definition !== undefined;
        if ((workflowId !== undefined) === sendsWorkflow) {
          return yield* Effect.fail(
            createValidationError(
              [{ path: [], message: ONE_WORKFLOW }],
              "the request must name exactly one workflow",
            ),
          );
        }
        const origin = yield* decideOrigin(actor);
        if (workflowId !== undefined) {
          return yield* writeRun(
            Effect.map(
              readStoredDefinition(workflowId, () => createNotFoundError("no such workflow")),
              (plan) => ({ plan, workflowId, inputs }),
            ),
            origin,
            STORED_WORKFLOW_REFUSALS,
          );
        }
        const plan = yield* workflows.parseDefinition(content);
        yield* requireConnectionUse(plan, actor);
        return yield* writeRun(
          Effect.succeed({ plan, workflowId: null, inputs }),
          origin,
          SENT_WORKFLOW_REFUSALS,
        );
      });

    /**
     * Returns the run `run.rerun` re-runs: the run with the id, once it has
     * ended. Fails with `NotFound` when no run has the id, and with
     * `InvalidState` when the run is still pending or running.
     */
    const readEndedRun = (id: string): Effect.Effect<Run, NotFound | InvalidState | SqlError> =>
      Effect.gen(function* () {
        const found = yield* runs.read(id);
        if (Option.isNone(found)) return yield* Effect.fail(createNotFoundError("no such run"));
        const run = found.value;
        if (isUnfinished(run.status)) {
          return yield* Effect.fail(
            createInvalidStateError(
              `This run is still ${run.status}, and only a run that has ended can be re-run. Wait for it to end, or cancel it, then re-run it.`,
            ),
          );
        }
        return run;
      });

    /**
     * `run.rerun`: starts a new run that re-runs an ended run with the same
     * resolved inputs, and returns its id without waiting for any step. The
     * new run names the original in `originalRunId`, and its origin follows the
     * caller, as for `run.start`.
     *
     * - `re-stamp`, the default, runs the workflow as it is stored now, so it
     *   picks up edits made since the original ran.
     * - `replay` runs the original run's frozen plan again.
     *
     * Fails with:
     *
     * - `NotFound` when no run has the id;
     * - `InvalidState` when the run has not ended, or when a re-stamp has no
     *   stored workflow to read, because the run's workflow was sent with
     *   `run.start` or has been deleted since. It never falls back to
     *   replay, because the caller would get the old plan without knowing;
     * - `Validation`, starting no run, as for `run.start`. When a re-stamp
     *   fails because of the stored workflow, the message tells the caller
     *   that replay may still run;
     * - `CapExceeded` as for `run.start`.
     */
    const rerun = (id: string, input: RunRerunInput): Effect.Effect<RunStarted, RunRerunError> =>
      Effect.gen(function* () {
        const actor = yield* requireGrant("run.rerun");
        const { mode = "re-stamp" } = yield* Effect.mapError(
          decodeRerunInput(input),
          createDecodeValidationError,
        );
        const origin = yield* decideOrigin(actor);
        if (mode === "replay") {
          return yield* writeRun(
            Effect.map(readEndedRun(id), (original) => ({
              plan: original.plan,
              workflowId: original.workflowId,
              inputs: original.inputs,
              originalRunId: original.id,
            })),
            origin,
            REPLAY_REFUSALS,
          );
        }
        const readRestampedRun = Effect.gen(function* () {
          const original = yield* readEndedRun(id);
          if (original.workflowId === null) {
            return yield* Effect.fail(
              createInvalidStateError(
                `This run's workflow was sent with run.start and never stored, so there is no stored workflow to re-stamp from. ${REPLAY_HINT}`,
              ),
            );
          }
          const plan = yield* readStoredDefinition(original.workflowId, () =>
            createInvalidStateError(
              `This run's workflow has been deleted, so there is no stored workflow to re-stamp from. ${REPLAY_HINT}`,
            ),
          );
          return {
            plan,
            workflowId: original.workflowId,
            inputs: original.inputs,
            originalRunId: original.id,
          };
        });
        return yield* writeRun(readRestampedRun, origin, RESTAMP_REFUSALS);
      });

    /**
     * Writes a run of a stored workflow because one of its start triggers
     * matched `event`, and returns the run's id. Joins the caller's
     * transaction, and hands the run to the Run Executor once it commits.
     * The workflows domain calls it through its `TriggeredRuns` port.
     *
     * Nobody is waiting on this start to refuse it, so a run that cannot
     * start is still written, and fails at once with `validation-error` and
     * a message that says what did not validate. The failure raises its
     * notification like any failed run, so the user learns that the
     * trigger's runs are failing. The checks are those of `run.start`,
     * except two:
     *
     * - the nesting limit, because a triggered run is 1 deep;
     * - the capable runner. A run no runner can run starts, and its first
     *   workspace step fails with `workspace-failed`, as for a run whose
     *   runners were retired after it started. Which runners exist says
     *   nothing about the workflow, so the failure is not held back like a
     *   validation error.
     *
     * The caller must have read the workflow's id from a row that its
     * transaction holds, so the workflow exists. There is no grant check:
     * the controller starts the run on nobody's behalf, after the workflow's
     * author saved the trigger.
     */
    const startTriggeredRun = (
      effect: PendingTriggerEffect,
      event: Event,
      at: string,
    ): Effect.Effect<string, SqlError> =>
      Effect.gen(function* () {
        const plan = Option.getOrThrow(yield* storedWorkflows.readDefinition(effect.workflowId));
        const checked = yield* checkRunnable(plan, effect.inputs, TRIGGERED_RUN_REFUSALS).pipe(
          Effect.map(Result.succeed),
          Effect.catchIf(
            (error) => error instanceof Validation,
            (refusal) => Effect.succeed(Result.fail(refusal)),
          ),
        );
        const runId = yield* runs.insert(
          {
            workflowId: effect.workflowId,
            plan,
            inputs: Result.isSuccess(checked) ? checked.success : effect.inputs,
            origin: { kind: "trigger", triggerId: effect.triggerId, eventId: event.id },
            // The run keeps its own copy of the event, so the run still shows
            // what started it after the log is pruned. `raw` is left out: it
            // is the vendor's payload, kept in the log for debugging only.
            triggerEvent: Struct.omit(event, ["raw"]),
            entryStepIds: Result.isSuccess(checked)
              ? listEntrySteps(plan).map((step) => step.id)
              : [],
          },
          at,
        );
        if (Result.isFailure(checked)) {
          yield* writeRunEnding(
            runId,
            {
              status: "failed",
              failureReason: "validation-error",
              failureMessage: describeRefusal(checked.failure),
            },
            at,
          );
        } else {
          yield* afterCommit(() => executeInBackground(runId));
        }
        return runId;
      });

    return { start, rerun, startTriggeredRun };
  });
