/**
 * Workspace steps on the wire: a step of a run that runs on the run's runner
 * rather than on the controller. That is an action step whose action runs in
 * the run's workspace, such as `git.commit`, or an agent step, whose turn runs
 * in a session on that runner.
 *
 * Every frame names its step by the step key: the run, the step's id in the
 * run's plan, and the iteration of that step. The key makes every delivery
 * idempotent. The controller sends a start again whenever it cannot know
 * whether the runner has the step, for example after either side restarts,
 * and the runner answers a repeated start from what it already knows about
 * the step instead of running it twice.
 */
import { Schema } from "effect";

import { Fact, SessionId, StorageId, WorkspaceStepKey } from "./primitives";
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
 * The capability for agent steps. A runner lists it at hello when it can run
 * an agent step's turn and answer `AgentStepResultRequest`; the controller
 * lists it when it can send agent steps. A runner on an older build closes
 * the socket on a frame it cannot read, and ignores the `step` field of a
 * `TurnInput`, so the controller places a run with an agent step only on a
 * runner whose hello lists this.
 */
export const AGENT_STEPS_CAPABILITY = "agentSteps";

/**
 * Starts one workspace action step. It carries everything the runner needs to
 * run the action, because the runner holds no Hercule state and cannot look
 * any of it up.
 */
export const ActionStepStart = Schema.Struct({
  _tag: Schema.Literal("workspaceStepStart"),
  /**
   * Always written by the controller. Optional only so a runner still reads
   * the frame from a controller built before agent steps, which sent no
   * `kind`.
   */
  kind: Schema.optionalKey(Schema.Literal("action")),
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
   * session start switches it. Set only for the run's first workspace step,
   * in a run on a main workspace whose workflow names a branch: the run
   * starts on that branch, and after that the branch belongs to the run's
   * agents, so no later step switches it back. An ephemeral checkout is
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

export type ActionStepStart = Schema.Schema.Type<typeof ActionStepStart>;

/**
 * Asks for the result of one agent step: the turn its session runs for this
 * step key. The controller sends the turn's prompt as the session's input,
 * not in this frame. This frame only asks how the turn ended, and it is sent
 * again whenever the controller cannot know whether the runner still owes
 * the answer, for example after either side restarts, or when the runner did
 * not answer the input that carried the prompt. The runner answers:
 *
 * - from the step's result file, when the turn has ended;
 * - when the turn ends, when it is still running;
 * - at once with a failed `interrupted` outcome otherwise: the runner
 *   restarted and lost the turn, or the harness refused the step's input, so
 *   no turn ran.
 */
export const AgentStepResultRequest = Schema.Struct({
  _tag: Schema.Literal("workspaceStepStart"),
  kind: Schema.Literal("agent"),
  ...WorkspaceStepKey.fields,
  /**
   * The session the step's turn runs in. The runner handles the request only
   * after every frame of that session it received earlier, so the request
   * never overtakes the input that carries the step's prompt.
   */
  sessionId: SessionId,
  /**
   * The run's workspace, which names the directory the step's result file is
   * kept in. `null` for a run with no workspace.
   */
  workspaceId: Schema.NullOr(StorageId),
});

export type AgentStepResultRequest = Schema.Schema.Type<typeof AgentStepResultRequest>;

/**
 * Builds the request for the result of the agent step `key`, whose turn runs
 * in the session `sessionId`. `workspaceId` is the workspace that session
 * works in, or `null` for a session with no workspace.
 */
export const buildAgentStepResultRequest = (
  key: WorkspaceStepKey,
  sessionId: string,
  workspaceId: string | null,
): AgentStepResultRequest => ({
  _tag: "workspaceStepStart",
  kind: "agent",
  runId: key.runId,
  stepId: key.stepId,
  iteration: key.iteration,
  sessionId,
  workspaceId,
});

/**
 * Starts one workspace step, or asks for its result: a workspace action step
 * runs on the runner, and an agent step's turn runs in a session there. Both
 * kinds share the step key, so a runner answers both with
 * `WorkspaceStepResult` and keeps both results in the same place.
 */
export const WorkspaceStepStart = Schema.Union([ActionStepStart, AgentStepResultRequest]);

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
 * - `interrupted`: the step was stopped before it finished. For an agent
 *   step, the runner restarted while the step's turn ran, so the turn was
 *   lost;
 * - `schema_failure`: an agent step's turn ended without a value that matches
 *   the step's output schema;
 * - `session_failed`: an agent step's turn failed or was interrupted, or its
 *   session exited, crashed, timed out or was stopped while the turn ran. The
 *   message names which.
 */
export const WorkspaceStepFailureCode = Schema.Literals([
  "action_failed",
  "timeout",
  "unsupported_action",
  "interrupted",
  "schema_failure",
  "session_failed",
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
