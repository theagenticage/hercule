/**
 * Action steps: one of the three kinds of step the run engine (`engine.ts`)
 * carries out, behind the `StepKind` interface.
 *
 * An action step calls one action from the action catalog with its input,
 * rendered for this iteration and decoded with the action's input schema.
 *
 * - A controller action runs on the controller, once the start transaction
 *   has committed, and its record ends in a transaction of its own (see
 *   `executeStep` in `step.ts`).
 * - A workspace action, such as a git action, runs in the run's workspace on
 *   the run's runner. Its start places the run (see `placeOnRunner`), and its
 *   runner reports the result.
 * - A built-in action's record that a restart cut off is executed again,
 *   because a built-in action takes no effect until its record ends. A
 *   plugin's action may already have taken effect, so its record cannot be
 *   executed again.
 */
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { StepError, WorkspacePolicy } from "@hercule/contract";
import { isBuiltInControllerActionId, runsInWorkspace } from "../plugins";
import { isGitActionId } from "../workflows";
import type { WorkspaceStepPlacement } from "./agent-steps";
import { runRepository, type ExecutionFailureReason, type StoredRun } from "./repository";
import {
  ENDED,
  findActionStep,
  makeStepExecution,
  type EngineStepError,
  type StepExecutionNeeds,
  type StepKind,
  type StepRecordKey,
} from "./step";
import { WorkspaceSteps, type ActionStepToStart } from "./workspace-steps";

/** Returns the `resourceId` a step's input names, if it names one. */
const readResourceId = (input: Schema.Json): string | undefined => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const resourceId = (input as { readonly resourceId?: unknown }).resourceId;
  return typeof resourceId === "string" ? resourceId : undefined;
};

/**
 * Builds the action step to hand to a runner from its step record, with the
 * `resourceId` its input names. `step.checkoutBranch` is the branch stored on
 * the record when it started; the step switches the checkout to it only when
 * it is set.
 */
export const buildActionStepToStart = (
  step: Omit<ActionStepToStart, "kind" | "resourceId">,
): ActionStepToStart => ({ kind: "action", ...step, resourceId: readResourceId(step.input) });

/** Returns the ids of the repos a run's workspace holds a checkout of. */
const listPolicyResourceIds = (policy: WorkspacePolicy): ReadonlyArray<string> =>
  policy.kind === "primary"
    ? [policy.resourceId]
    : policy.checkouts.map((checkout) => checkout.resourceId);

/**
 * Checks that a workspace step can run in the run's workspace, before a
 * runner is chosen or a workspace opened. Returns the error the step fails
 * with, or `undefined` when it can run: a `resourceId` in a git action's
 * input must name one of the workspace's checkouts. Validation at save and at
 * `run.start` refused every other mistake, but a `resourceId` can come from a
 * template, so only the rendered input shows this one.
 */
const findWorkspaceStepError = (
  policy: WorkspacePolicy,
  action: string,
  input: Schema.Json,
): EngineStepError | undefined => {
  if (!isGitActionId(action)) return undefined;
  const resourceIds = listPolicyResourceIds(policy);
  const resourceId = readResourceId(input);
  if (resourceId !== undefined && !resourceIds.includes(resourceId)) {
    return {
      code: "validation",
      message: `The run's workspace has no checkout of the resource ${resourceId}. Set resourceId to one of the workspace's repos: ${resourceIds.join(", ")}.`,
    };
  }
  return undefined;
};

/** What an action step needs from the run engine. */
interface ActionStepNeeds extends StepExecutionNeeds {
  /** Fails a step record and its run, inside the caller's transaction. */
  readonly writeStepFailure: (
    runId: string,
    attempt: StepRecordKey,
    error: StepError,
    failureReason: ExecutionFailureReason,
    at: string,
  ) => Effect.Effect<void, SqlError>;
  /**
   * Pins the run to a runner, unless it is pinned already, and opens the
   * run's workspace there when its plan has one.
   */
  readonly placeOnRunner: (
    run: StoredRun,
    record: StepRecordKey,
    at: string,
  ) => Effect.Effect<WorkspaceStepPlacement, SqlError>;
}

/** Builds the run engine's action steps, as a `StepKind`. */
export const makeActionSteps = ({ writeStepFailure, placeOnRunner, ...needs }: ActionStepNeeds) =>
  Effect.gen(function* () {
    const runs = yield* runRepository;
    const workspaceSteps = yield* WorkspaceSteps;
    const { prepareInput, executeStep } = yield* makeStepExecution(needs);

    const actionSteps: StepKind = {
      start: (run, record, at) =>
        Effect.gen(function* () {
          const step = findActionStep(run, record.stepId);
          const prepared = yield* prepareInput(run, step);
          if (Result.isFailure(prepared)) {
            const { error, failureReason } = prepared.failure;
            yield* writeStepFailure(run.id, record, error, failureReason, at);
            return ENDED;
          }
          const input = prepared.success;
          if (!runsInWorkspace(step.action)) {
            yield* runs.startStep(run.id, record, { input, checkoutBranch: undefined }, at);
            return {
              _tag: "started",
              execute: executeStep(run, { ...record, startedAt: at }, input),
            } as const;
          }
          const policy = run.plan.workspace;
          // Validation at `run.start` refuses a plan with a workspace action and
          // no workspace, and a run's plan never changes after that.
          if (policy === undefined) {
            return yield* Effect.die(
              `run ${run.id} has a workspace action and no workspace policy`,
            );
          }
          const refused = findWorkspaceStepError(policy, step.action, input);
          if (refused !== undefined) {
            yield* writeStepFailure(run.id, record, refused, "step-failed", at);
            return ENDED;
          }
          const placed = yield* placeOnRunner(run, record, at);
          if (placed._tag !== "placed") return placed;
          // A run with a workspace policy is pinned together with its workspace.
          if (placed.workspaceId === null) {
            return yield* Effect.die(`run ${run.id} is pinned with no workspace`);
          }
          const { checkoutBranch } = placed;
          yield* runs.startStep(run.id, record, { input, checkoutBranch }, at);
          return {
            _tag: "started",
            execute: workspaceSteps.start(
              buildActionStepToStart({
                runId: run.id,
                stepId: record.stepId,
                iteration: record.iteration,
                runnerId: placed.runnerId,
                workspaceId: placed.workspaceId,
                action: step.action,
                input,
                checkoutBranch,
              }),
            ),
          } as const;
        }),
      resume: (run, record) => {
        const step = findActionStep(run, record.stepId);
        if (!isBuiltInControllerActionId(step.action)) return undefined;
        // `startStep` stores the input of every record it starts, so a
        // running record without one is a bug. The run fails with
        // `controller-error` rather than calling the action with an input it
        // was never checked against.
        const { input } = record;
        return input === undefined
          ? Effect.die(`step ${record.stepId} of run ${run.id} is running with no input stored`)
          : executeStep(run, record, input);
      },
    };
    return actionSteps;
  });
