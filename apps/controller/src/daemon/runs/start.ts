/**
 * Starting a run: what `run.start` checks before it writes a run, and the
 * write itself. The run engine (`engine.ts`) serves the operation and the
 * `run.start` action through this, and executes each run once it commits.
 *
 * Starting a run crosses domains - workflows, runs, Connections, the action
 * catalog and the controller's settings - which is why it is a controller
 * daemon use case.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  createCapExceededError,
  createDecodeValidationError,
  createNotFoundError,
  createValidationError,
  listEntrySteps,
  RunStartInput,
  type CapExceeded,
  type Forbidden,
  type Issue,
  type NotFound,
  type RunOrigin,
  type RunStarted,
  type Unauthenticated,
  type Validation,
  type WorkflowDefinition,
} from "@hercule/contract";
import { currentStamp, requireGrant } from "../../actor";
import { afterCommit, nowIso, withTransaction } from "../../db";
import { PluginHost, type RegisteredWorkflowAction } from "../../plugins";
import { runRepository } from "../../runs";
import { Settings, type SettingError } from "../../settings";
import { workflowRepository, WorkflowService } from "../../workflows";

/**
 * How many runs deep a run may be when the controller's `run.nestingLimit`
 * setting is not set. A run started by hand or through the API is 1 deep; a
 * run that a `run.start` step starts is one deeper than the step's run.
 */
const DEFAULT_RUN_NESTING_LIMIT = 5;

const decodeStartInput = Schema.decodeUnknownEffect(RunStartInput);

type PlanStep = WorkflowDefinition["steps"][number];

/** The refusal of a `run.start` that names no workflow, or more than one. */
const ONE_WORKFLOW =
  "Send exactly one of workflowId (a stored workflow), source (YAML text) or definition (an object).";

/** The errors `run.start` can fail with. */
export type RunStartError =
  Unauthenticated | Forbidden | Validation | NotFound | CapExceeded | SettingError | SqlError;

/**
 * Returns an issue for each element of a definition that runs cannot execute
 * yet, each at its path. Such a workflow can be saved, but starting a run of
 * it is refused: a run that ignored a step or a trigger it cannot execute
 * would do something the author did not write.
 */
const listUnsupportedElements = (
  definition: WorkflowDefinition,
  actions: ReadonlyArray<RegisteredWorkflowAction>,
): ReadonlyArray<Issue> => {
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
    const path = ["steps", String(index)];
    if (step.kind === "agent") {
      return [
        {
          path: [...path, "kind"],
          message: "Runs cannot run agent steps yet. Only action steps can run.",
        },
      ];
    }
    // Which of a step's params names the Connection is not settled yet, and
    // an action called without its Connection would fail in ways its author
    // never planned for.
    return actions.find((action) => action.id === step.action)?.connection === undefined
      ? []
      : [
          {
            path: [...path, "action"],
            message:
              "Runs cannot call an action that acts through a Connection yet. Remove this step to run this workflow.",
          },
        ];
  });
  return [...triggerIssues, ...stepIssues];
};

/** A run about to be written: the stored workflow it runs, if any, the inputs as given, and how it was started. */
interface RunToStart {
  readonly workflowId: string | null;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly origin: RunOrigin;
}

/**
 * Builds `run.start`. `executeInBackground` is called with the new run's id
 * once the run's rows commit; the engine passes the function that executes a
 * run on a fiber of its own.
 */
export const makeRunStart = (executeInBackground: (runId: string) => void) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const runs = yield* runRepository;
    const storedWorkflows = yield* workflowRepository;
    const workflows = yield* WorkflowService;
    const host = yield* PluginHost;
    const settings = yield* Settings;

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
     * Writes a run of the plan `readPlan` returns: validates the plan again,
     * refuses what runs cannot execute yet, checks how deep the run is
     * nested, resolves the inputs, and writes the run and its entry step
     * records. Returns the run's id at once, without waiting for any step.
     * Fails with `Validation`, starting no run, when the plan does not
     * validate or the inputs do not match its declarations; with
     * `CapExceeded` when the run is nested too deep; and with whatever
     * `readPlan` fails with.
     *
     * `readPlan` runs inside the transaction, so a stored workflow cannot
     * change between being read and its run being written.
     */
    const writeRun = <E>(
      readPlan: Effect.Effect<WorkflowDefinition, E>,
      run: RunToStart,
    ): Effect.Effect<RunStarted, E | Validation | CapExceeded | SettingError | SqlError> =>
      // Uninterruptible, because it only touches the local database: a
      // caller that disconnects while it commits must not leave a committed
      // run whose fiber was never started.
      Effect.uninterruptible(
        withTransaction(
          sql,
          Effect.gen(function* () {
            const plan = yield* readPlan;
            // What runs cannot do yet is checked only on a valid definition:
            // an action that does not exist is reported once, as unknown.
            const invalid = (yield* workflows.validateDefinition(plan)).errors;
            const problems =
              invalid.length > 0
                ? invalid
                : listUnsupportedElements(plan, yield* host.listActiveWorkflowActions());
            if (problems.length > 0) {
              return yield* Effect.fail(
                createValidationError(
                  problems,
                  run.workflowId === null
                    ? "this workflow cannot run"
                    : "this workflow cannot run as it is saved now",
                ),
              );
            }
            yield* checkNesting(run.origin);
            const inputs = yield* workflows.resolveRunInputs(plan, run.inputs);
            if (Result.isFailure(inputs)) {
              return yield* Effect.fail(
                createValidationError(inputs.failure, "the inputs are not valid"),
              );
            }
            const runId = yield* runs.insert(
              {
                workflowId: run.workflowId,
                plan,
                inputs: inputs.success,
                origin: run.origin,
                entryStepIds: listEntrySteps(plan).map((step) => step.id),
              },
              yield* nowIso,
            );
            // After the commit, so the fiber reads the rows this transaction
            // wrote. It runs even if the caller disconnects after the commit,
            // so a run that exists always starts. A run started by a step of
            // another run commits with that step, so it starts only if the
            // step completes.
            yield* afterCommit(() => executeInBackground(runId));
            return { runId };
          }),
        ),
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
     *   cannot execute yet, or the inputs do not match its declarations;
     * - `NotFound` for an unknown `workflowId`;
     * - `CapExceeded` when the run would be nested deeper than the
     *   controller's `run.nestingLimit`.
     *
     * The `run.start` action calls it too, as the run whose step it is.
     */
    return (input: RunStartInput): Effect.Effect<RunStarted, RunStartError> =>
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
        // The user starts a run by hand, from the web app or the CLI. A run's
        // step starts a child run. Any other caller is a program using the API.
        const origin: RunOrigin =
          actor._tag === "run"
            ? { kind: "action", parentRunId: actor.runId, stepId: actor.stepId }
            : { kind: actor._tag === "user" ? "manual" : "api", actor: yield* currentStamp };
        if (workflowId !== undefined) {
          return yield* writeRun(
            Effect.flatMap(
              storedWorkflows.readDefinition(workflowId),
              Option.match({
                onNone: () => Effect.fail(createNotFoundError("no such workflow")),
                onSome: Effect.succeed,
              }),
            ),
            { workflowId, inputs, origin },
          );
        }
        const plan = yield* workflows.parseDefinition(content);
        return yield* writeRun(Effect.succeed(plan), { workflowId: null, inputs, origin });
      });
  });
