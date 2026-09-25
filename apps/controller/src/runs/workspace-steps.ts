/**
 * Workspace Steps: the port through which the runs domain hands a workspace
 * step to the runner its run is pinned to, and asks that runner to stop one.
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

/**
 * Names one step record of a run on the runner that runs it: the run, the
 * step's id in the run's plan, and the iteration of that step.
 */
export interface WorkspaceStepToStop {
  /** The runner the step's run is pinned to. */
  readonly runnerId: string;
  readonly runId: string;
  readonly stepId: string;
  readonly iteration: number;
}

/** A workspace step to hand to a runner: its step key, and everything the runner needs to run it. */
export interface WorkspaceStepToStart {
  readonly runId: string;
  readonly stepId: string;
  readonly iteration: number;
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
     * Asks the runners to stop these steps if they are still running, for
     * example because their run was cancelled, and returns without waiting
     * for them to stop. A stop that cannot be delivered because the runner is
     * not connected is not retried: when the runner connects, it reports the
     * steps it is running, and the controller daemon stops each one whose
     * record has ended.
     */
    readonly stop: (steps: ReadonlyArray<WorkspaceStepToStop>) => Effect.Effect<void>;
  }
>()("hercule/controller/runs/WorkspaceSteps") {}
