/**
 * Workspace steps on the wire: a step of a run whose action runs in the run's
 * workspace on a runner, such as `git.commit`, rather than on the controller.
 *
 * Every frame names its step by the step key: the run, the step's id in the
 * run's plan, and the iteration of that step. The key makes every delivery
 * idempotent. The controller sends a start again whenever it cannot know
 * whether the runner has the step, for example after either side restarts,
 * and the runner answers a repeated start from what it already knows about
 * the step instead of running it twice.
 */
import { Schema } from "effect";

import { Fact, StorageId } from "./primitives";
import { GitIdentity, MAX_MESSAGE_LENGTH } from "./sessions";

const Message = Schema.String.check(Schema.isMaxLength(MAX_MESSAGE_LENGTH));

/**
 * The most step keys one frame lists. A runner runs one step at a time per
 * workspace, so the steps in flight on one runner are far fewer; this only
 * rejects a nonsense frame.
 */
export const MAX_WORKSPACE_STEPS = 256;

/**
 * Returns the hello capability that stands for one workspace action, such as
 * `action:git.commit` for `git.commit`.
 *
 * A runner lists one for each workspace action its build implements, and the
 * controller one for each workspace action in its catalog. The negotiated list
 * then holds exactly the workspace actions both sides know, and a run is
 * pinned only to a runner whose list holds every workspace action in its plan.
 */
export const buildWorkspaceActionCapability = (actionId: string): string => `action:${actionId}`;

/**
 * Identifies one step record of a run. The run id and the step id are storage
 * ids because the runner names the step's result file after them, so neither
 * may escape the directory that file goes in.
 */
export const WorkspaceStepKey = Schema.Struct({
  runId: StorageId,
  stepId: StorageId,
  iteration: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});

export type WorkspaceStepKey = Schema.Schema.Type<typeof WorkspaceStepKey>;

/**
 * Starts one workspace step. It carries everything the runner needs to run
 * the action, because the runner holds no Hercule state and cannot look any of
 * it up.
 */
export const WorkspaceStepStart = Schema.Struct({
  _tag: Schema.Literal("workspaceStepStart"),
  ...WorkspaceStepKey.fields,
  /** The run's workspace, which the runner already holds. */
  workspaceId: StorageId,
  /** The id of the workspace action to run, such as `git.commit`. */
  action: Fact,
  /**
   * The step's params, rendered from their templates and checked against the
   * action's input schema by the controller.
   */
  input: Schema.Json,
  /**
   * The resource whose checkout the action works in. Absent when the
   * workspace has one checkout, which is then the one used.
   */
  resourceId: Schema.optionalKey(StorageId),
  /**
   * The branch the checkout is switched to before the action runs, as a
   * session start switches it. Set only for a run on a main workspace whose
   * workflow names a branch: a main workspace is shared, so something else
   * may have switched it since the last step. An ephemeral checkout is
   * already on the run's own branch.
   */
  checkoutBranch: Schema.optionalKey(Fact),
  /**
   * Who a commit is made as: the account of the workspace's designated
   * Connection. Absent when no Connection backs the workspace; the machine
   * then leaves git's own identity unchanged rather than inventing one.
   */
  gitIdentity: Schema.optionalKey(GitIdentity),
});

export type WorkspaceStepStart = Schema.Schema.Type<typeof WorkspaceStepStart>;

/**
 * Settles these steps: tells the runner that the controller no longer owes
 * them, because their records have ended, for example because their run was
 * cancelled or the runner already reported how they ended. The runner:
 *
 * - stops a step that is still running, and drops a queued one;
 * - deletes the step's result file;
 * - remembers the step's key, so a start of the step that arrives late is
 *   ignored.
 *
 * There is no reply frame.
 */
export const WorkspaceStepSettle = Schema.Struct({
  _tag: Schema.Literal("workspaceStepSettle"),
  steps: Schema.Array(WorkspaceStepKey).check(Schema.isMaxLength(MAX_WORKSPACE_STEPS)),
});

export type WorkspaceStepSettle = Schema.Schema.Type<typeof WorkspaceStepSettle>;

/**
 * Why a workspace step failed:
 *
 * - `action_failed`: the action ran and failed, for example a push the remote
 *   rejected;
 * - `timeout`: the action ran past its deadline and was stopped;
 * - `unsupported_action`: this runner build does not implement the action;
 * - `interrupted`: the step was stopped before it finished.
 */
export const WorkspaceStepFailureCode = Schema.Literals([
  "action_failed",
  "timeout",
  "unsupported_action",
  "interrupted",
]);

export type WorkspaceStepFailureCode = Schema.Schema.Type<typeof WorkspaceStepFailureCode>;

/**
 * How a workspace step ended. A completed step's `output` is what the action
 * returned; the controller decodes it against the action's output schema,
 * because the runner's build may not match the controller's catalog.
 */
export const WorkspaceStepOutcome = Schema.Union([
  Schema.Struct({ status: Schema.Literal("completed"), output: Schema.Json }),
  Schema.Struct({
    status: Schema.Literal("failed"),
    code: WorkspaceStepFailureCode,
    /** What went wrong, for a person: for a git action, the tail of git's error output. */
    message: Message,
  }),
]);

export type WorkspaceStepOutcome = Schema.Schema.Type<typeof WorkspaceStepOutcome>;

/** How one workspace step ended, sent once the step has finished. */
export const WorkspaceStepResult = Schema.Struct({
  _tag: Schema.Literal("workspaceStepResult"),
  ...WorkspaceStepKey.fields,
  outcome: WorkspaceStepOutcome,
});

export type WorkspaceStepResult = Schema.Schema.Type<typeof WorkspaceStepResult>;

/**
 * The workspace steps the runner is running now: started and not yet
 * finished. Sent on connect, like `sessionsReport`, so the controller can
 * settle every step whose record ended while the runner was away.
 */
export const WorkspaceStepsReport = Schema.Struct({
  _tag: Schema.Literal("workspaceStepsReport"),
  steps: Schema.Array(WorkspaceStepKey).check(Schema.isMaxLength(MAX_WORKSPACE_STEPS)),
});

export type WorkspaceStepsReport = Schema.Schema.Type<typeof WorkspaceStepsReport>;
