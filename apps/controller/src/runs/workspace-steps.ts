/**
 * Workspace Steps: the port through which the runs domain hands a workspace
 * step to the runner its run is pinned to, and settles the step with that
 * runner once the controller no longer owes it.
 *
 * A workspace step is a step that runs on the run's runner rather than on the
 * controller:
 *
 * - an action step whose action runs in the run's workspace, such as
 *   `git.commit`;
 * - an agent step, whose turn runs in a session on that runner.
 *
 * The runs domain decides when such a step starts and records how it ends; it
 * never talks to a runner, and never writes a session, itself. The controller
 * daemon implements this port, because it holds the connections to runners
 * and the operations that place and feed sessions.
 */
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { Run, WorkflowDefinition } from "@hercule/contract";
import type { WorkspaceStepKey } from "@hercule/protocol";

/** An agent step of a workflow's plan, as the plan declares it. */
export type AgentStep = Extract<WorkflowDefinition["steps"][number], { readonly kind: "agent" }>;

/** A workspace step to settle: its step key, and the runner that runs it. */
export interface WorkspaceStepToSettle extends WorkspaceStepKey {
  /** The runner the step's run is pinned to. */
  readonly runnerId: string;
}

/** An action step to hand to a runner: its step key, and everything the runner needs to run it. */
export interface ActionStepToStart extends WorkspaceStepKey {
  readonly kind: "action";
  /** The runner the step's run is pinned to. */
  readonly runnerId: string;
  /** The run's workspace, on that runner. */
  readonly workspaceId: string;
  /** The id of the workspace action, such as `git.commit`. */
  readonly action: string;
  /** The step's input as stored on its step record: rendered and checked against the action's input schema. */
  readonly input: Schema.Json;
  /** The resource whose checkout the action works in, when the step names one. */
  readonly resourceId?: string;
  /**
   * The branch the checkout is switched to before the action runs: the
   * branch a run on a repo's main workspace names. A main workspace is
   * shared, so something else may have switched it since the run's last
   * step. Absent for an ephemeral workspace, which is already on the run's
   * own branch.
   */
  readonly checkoutBranch?: string;
}

/**
 * An agent step whose runner is asked how its turn ended: its step key, and
 * the run's workspace, which names where the runner keeps the step's result.
 */
export interface AgentStepResultToRequest extends WorkspaceStepKey {
  readonly kind: "agent";
  /** The runner the step's run is pinned to. */
  readonly runnerId: string;
  /** The run's workspace, or null for a run that has none. */
  readonly workspaceId: string | null;
}

/** A workspace step to hand to its runner (see `WorkspaceSteps.start`). */
export type WorkspaceStepToStart = ActionStepToStart | AgentStepResultToRequest;

/** The session one iteration of an agent step is to run in (see `WorkspaceSteps.openSession`). */
export interface StepSessionToOpen {
  readonly step: WorkspaceStepKey;
  /** The agent step as the run's plan declares it. */
  readonly definition: AgentStep;
  /** The runner the step's run is pinned to. */
  readonly runnerId: string;
  /** The run's workspace, or null for a run that has none. */
  readonly workspaceId: string | null;
  /** The step's prompt, rendered for this iteration. */
  readonly prompt: string;
  /**
   * The title of a new session: the run's workflow name and the step's id,
   * as `<workflow name> · <step id>`.
   */
  readonly title: string;
  /**
   * The session an earlier iteration of the step ran in, whose next turn
   * this iteration is, or undefined to start a new session.
   */
  readonly previousSessionId: string | undefined;
}

/** The session an agent step's iteration runs in, and what to send once the caller commits. */
export interface OpenedStepSession {
  readonly sessionId: string;
  /**
   * Starts the session, or delivers the prompt to it. Run it only after the
   * transaction that opened the session has committed. A failure is logged,
   * not returned: the prompt waits in the session, and the controller
   * delivers it later.
   */
  readonly send: Effect.Effect<void>;
}

/**
 * An agent step's session could not be opened, for example because the
 * step's Agent was deleted, or the session of the step's earlier iteration
 * has exited and cannot be resumed. The message says why, for a person.
 */
export class StepSessionRefused extends Data.TaggedError("StepSessionRefused")<{
  readonly message: string;
}> {}

/** The Workspace Steps port, which the controller daemon implements. */
export class WorkspaceSteps extends Context.Service<
  WorkspaceSteps,
  {
    /**
     * Hands a workspace step to its runner, and returns once the step is
     * handed on, never when it ends. How the step ends reaches the runs
     * domain later, as a step result from the runner.
     *
     * - For an action step, the runner runs the action.
     * - For an agent step, the runner is asked how the step's turn ended. Its
     *   prompt went to the session as an input (see `openSession`); this
     *   only asks again for the answer, for example after the runner
     *   restarted.
     *
     * Call it only after the transaction that marked the step record
     * `running` has committed, so a result can never arrive for a record
     * that does not say so yet.
     *
     * When the run's workspace is still provisioning, the implementation
     * first sends the workspace's provision again, rebuilt from its rows, and
     * then the step. Both deliveries are idempotent by their keys, so calling
     * `start` twice for one step, or after a restart, runs the step once.
     * When the runner is not connected, nothing is sent: the controller daemon
     * sends every workspace step still running on a runner again when that
     * runner connects.
     */
    readonly start: (step: WorkspaceStepToStart) => Effect.Effect<void>;

    /**
     * Opens the session that one iteration of an agent step runs in, inside
     * the caller's transaction:
     *
     * - with no previous session, it places a new session of the step's
     *   Agent on the run's runner, in the run's workspace, with the prompt
     *   as its first input;
     * - otherwise, it queues the prompt as the next input of the previous
     *   session, and resumes that session if it has exited.
     *
     * Either way the prompt carries the step key, so the runner reports the
     * turn that answers it as the step's result. The current actor must be
     * the step's run. Returns the session's id and what to send once the
     * caller commits. Fails with `StepSessionRefused` when the session cannot
     * be opened, and writes nothing then.
     */
    readonly openSession: (
      request: StepSessionToOpen,
    ) => Effect.Effect<OpenedStepSession, StepSessionRefused | SqlError>;

    /**
     * Stops every session of a run that has not exited, so their workspace
     * leases are released and the runner frees their slots, and cancels the
     * step prompts still waiting on any session of the run. Call it in the
     * transaction that ends the run: the run has ended, so no turn of these
     * sessions is owed to it any more.
     *
     * It reads the sessions in the caller's transaction, and stops them once
     * that transaction commits, as the run. It does not wait for the
     * sessions to stop. A stop that cannot be delivered because the runner
     * is not connected is logged, and sent again when the runner connects
     * (`RunService.stopSessionsOfEndedRuns`).
     */
    readonly stopSessions: (run: Pick<Run, "id" | "workflowId">) => Effect.Effect<void, SqlError>;

    /**
     * Settles these steps with their runners: tells each runner that the
     * controller no longer owes the step, because its record has ended. The
     * record ended because the step's run was cancelled or failed, or
     * because the runner reported how the step ended. Settling means two
     * things on the runner:
     *
     * - an action step that is still running is stopped, and a queued one
     *   dropped. An agent step's session is left running: `stopSessions`
     *   stops it when its run ends;
     * - the step's result file is deleted, and its key remembered, so a
     *   start of the step that arrives late is ignored.
     *
     * Returns at once, without waiting for the frames to be sent. It is
     * synchronous so that it can run right after a commit (see
     * `afterCommit`).
     *
     * A settle that cannot be delivered because the runner is not connected
     * is not retried: when the runner connects, it reports the steps it
     * holds, and the controller daemon settles each one whose record has
     * ended.
     */
    readonly settle: (steps: ReadonlyArray<WorkspaceStepToSettle>) => void;
  }
>()("hercule/controller/runs/WorkspaceSteps") {}
