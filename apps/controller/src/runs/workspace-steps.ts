/**
 * Workspace Steps: the port through which the runs domain hands a workspace
 * step to the runner its run is pinned to, and settles the step with that
 * runner once the controller no longer owes it.
 *
 * A workspace step is a step whose action runs in the run's workspace on a
 * runner, such as `git.commit`, rather than on the controller. The runs
 * domain decides when such a step starts and records how it ends; it never
 * talks to a runner itself. The controller daemon implements this port,
 * because it holds the connections to runners.
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import type { WorkspaceStepKey } from "@hercule/protocol";

/** A workspace step to settle: its step key, and the runner that runs it. */
export interface WorkspaceStepToSettle extends WorkspaceStepKey {
  /** The runner the step's run is pinned to. */
  readonly runnerId: string;
}

/** A workspace step to hand to a runner: its step key, and everything the runner needs to run it. */
export interface WorkspaceStepToStart extends WorkspaceStepKey {
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

/** The Workspace Steps port, which the controller daemon implements. */
export class WorkspaceSteps extends Context.Service<
  WorkspaceSteps,
  {
    /**
     * Hands a workspace step to its runner, and returns once the step is
     * handed on, never when it ends. How the step ends reaches the runs
     * domain later, as a step result from the runner.
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
     * Settles these steps with their runners: tells each runner that the
     * controller no longer owes the step, because its record has ended. The
     * record ended because the step's run was cancelled or failed, or
     * because the runner reported how the step ended. Settling means two
     * things on the runner:
     *
     * - a step that is still running is stopped, and a queued one dropped;
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
