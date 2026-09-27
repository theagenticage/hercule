/**
 * Starting a run: what `run.start` and `run.rerun` check before they write a
 * run, and the write itself. The run engine (`engine.ts`) serves both
 * operations and the `run.start` action through this, and hands each run to
 * the Run Executor once it commits.
 *
 * Starting a run reads the workflows domain, the action catalog, the fleet's
 * runners and the controller's settings. All four sit below runs in the
 * domain graph.
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
  createInvalidStateError,
  createNotFoundError,
  createValidationError,
  listEntrySteps,
  RunRerunInput,
  RunStartInput,
  type CapExceeded,
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
import { currentStamp, requireGrant, type Actor } from "../actor";
import { afterCommit, nowIso } from "../db";
import { PluginHost, type RegisteredWorkflowAction } from "../plugins";
import { runnerRepository } from "../runners";
import { Settings, type SettingError } from "../settings";
import { workflowRepository, WorkflowService } from "../workflows";
import { runRepository } from "./repository";
import { describeMissingCapableRunner, listWorkspaceActionIds } from "./runner-capabilities";
import { isUnfinished } from "./step-records";
import { commitUninterruptibly } from "./transaction";

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

/** What a re-stamp that cannot run tells the caller to do instead. */
const REPLAY_HINT = "Re-run with mode replay to run the original run's plan instead.";

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
    const action = actions.find((candidate) => candidate.id === step.action);
    // Which of a step's params names the Connection is not settled yet, and
    // an action called without its Connection would fail in ways its author
    // never planned for.
    return action?.connection === undefined
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
 * Builds `run.start` and `run.rerun`. `executeInBackground` is called with
 * the new run's id once the run's rows commit; the engine passes the
 * function that hands the run's execution to the Run Executor.
 */
export const makeRunStart = (executeInBackground: (runId: string) => void) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const runs = yield* runRepository;
    const storedWorkflows = yield* workflowRepository;
    const workflows = yield* WorkflowService;
    const host = yield* PluginHost;
    const settings = yield* Settings;
    const runners = yield* runnerRepository;

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
     * Writes the run `prepare` returns: validates its plan again, refuses
     * what runs cannot execute yet and what no runner can run, checks how
     * deep the run is nested, resolves the inputs, and writes the run and its
     * entry step records. Returns the run's id at once, without waiting for
     * any step. Fails, starting no run, with:
     *
     * - `Validation` when the plan does not validate, no runner can run it,
     *   or the inputs do not match its declarations. `unrunnable` is the
     *   error's message when the plan itself cannot run;
     * - `CapExceeded` when the run is nested too deep;
     * - whatever `prepare` fails with.
     *
     * `prepare` runs inside the transaction, so a stored workflow cannot
     * change between being read and its run being written.
     */
    const writeRun = <E>(
      prepare: Effect.Effect<RunToWrite, E>,
      origin: RunOrigin,
      unrunnable: string,
    ): Effect.Effect<RunStarted, E | Validation | CapExceeded | SettingError | SqlError> =>
      // Uninterruptible, because it only touches the local database: a
      // caller that disconnects while it commits must not leave a committed
      // run that was never handed to the Run Executor.
      commitUninterruptibly(
        sql,
        Effect.gen(function* () {
          const run = yield* prepare;
          const plan = run.plan;
          // What runs cannot do yet is checked only on a valid definition:
          // an action that does not exist is reported once, as unknown.
          const invalid = (yield* workflows.validateDefinition(plan)).errors;
          const problems =
            invalid.length > 0
              ? invalid
              : listUnsupportedElements(plan, yield* host.listActiveWorkflowActions());
          if (problems.length > 0) {
            return yield* Effect.fail(createValidationError(problems, unrunnable));
          }
          // A retired runner never takes the run, and neither does a reserved
          // one, because a run names no runner. An offline or draining one
          // may come back, and the run waits for it.
          const missingRunner = describeMissingCapableRunner(
            listWorkspaceActionIds(plan),
            yield* runners.listPlacementCandidates(),
          );
          if (missingRunner !== undefined) {
            return yield* Effect.fail(
              createValidationError(
                [{ path: [], message: missingRunner }],
                "no runner can run this workflow",
              ),
            );
          }
          yield* checkNesting(origin);
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
              origin,
              entryStepIds: listEntrySteps(plan).map((step) => step.id),
              ...(run.originalRunId === undefined ? {} : { originalRunId: run.originalRunId }),
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
     * Reads a stored workflow's definition. Fails with `notFound` when no
     * workflow has the id.
     */
    const readStoredDefinition = <E>(
      workflowId: string,
      notFound: () => E,
    ): Effect.Effect<WorkflowDefinition, E | SqlError> =>
      Effect.flatMap(
        storedWorkflows.readDefinition(workflowId),
        Option.match({ onNone: () => Effect.fail(notFound()), onSome: Effect.succeed }),
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
            "this workflow cannot run as it is saved now",
          );
        }
        const plan = yield* workflows.parseDefinition(content);
        return yield* writeRun(
          Effect.succeed({ plan, workflowId: null, inputs }),
          origin,
          "this workflow cannot run",
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
     * - `Validation`, starting no run, as for `run.start`. A re-stamp's
     *   message tells the caller that replay may still run;
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
            "the original run's plan cannot run any more",
          );
        }
        const restamp = Effect.gen(function* () {
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
        return yield* Effect.catchIf(
          writeRun(restamp, origin, "this workflow cannot run as it is saved now"),
          (error) => error instanceof Validation,
          (refused) =>
            Effect.fail(
              createValidationError(
                refused.error.details.issues,
                `${refused.error.message}. ${REPLAY_HINT}`,
              ),
            ),
        );
      });

    return { start, rerun };
  });
