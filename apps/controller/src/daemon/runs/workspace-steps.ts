/**
 * Workspace Steps: sends a workspace step to the runner its run is pinned to,
 * opens and stops the sessions of a run's agent steps, and settles the steps
 * the controller no longer owes with their runners.
 *
 * It lives in the controller daemon because only the controller daemon holds
 * the connections to runners and the operations on sessions. It sits in
 * `runs/` because the port it implements belongs to the runs domain, like the
 * Run Executor beside it. The session half is in
 * `daemon/sessions/step-sessions.ts`.
 */
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  buildAgentStepResultRequest,
  MAX_WORKSPACE_STEPS,
  type ActionStepStart,
  type WorkspaceStepKey,
} from "@hercule/protocol";
import { RunnerConnections } from "../../runners";
import type { SessionService } from "../../sessions";
import { WorkspaceSteps, type ActionStepToStart, type WorkspaceStepToStart } from "../../runs";
import { WorkspaceService } from "../../workspaces";
import { Live, makeStepSessions, Placement } from "../sessions";

const make = Effect.gen(function* () {
  const workspaces = yield* WorkspaceService;
  const connections = yield* RunnerConnections;
  const { openSession, stopSessions } = yield* makeStepSessions;
  // The port's `settle` is synchronous, so its frames are sent on fibers of
  // their own. They end with the controller.
  const runInBackground = yield* FiberSet.makeRuntime();

  /**
   * Builds the frame that starts an action step, with the commit author the
   * workspaces domain reads for the step's workspace (see
   * `WorkspaceService.readCommitAuthor`).
   */
  const buildStartFrame = (step: ActionStepToStart): Effect.Effect<ActionStepStart, SqlError> =>
    Effect.gen(function* () {
      const gitIdentity = yield* workspaces.readCommitAuthor(step.workspaceId);
      return {
        _tag: "workspaceStepStart",
        kind: "action",
        runId: step.runId,
        stepId: step.stepId,
        iteration: step.iteration,
        workspaceId: step.workspaceId,
        action: step.action,
        input: step.input,
        ...(step.resourceId === undefined ? {} : { resourceId: step.resourceId }),
        ...(step.checkoutBranch === undefined ? {} : { checkoutBranch: step.checkoutBranch }),
        ...(gitIdentity === undefined ? {} : { gitIdentity }),
      };
    });

  const start = (step: WorkspaceStepToStart): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      // Nothing is read or sent for a runner that is not connected: when it
      // connects, the controller daemon sends it every step it still owes it,
      // rebuilt from the rows at that moment.
      if (!(yield* connections.holdsConnection(step.runnerId))) return;
      if (step.kind === "agent") {
        // The step's prompt already reached the runner as an input of its
        // session, after the workspace's provision. This only asks again how
        // the step's turn ended.
        return yield* connections.tell(
          step.runnerId,
          buildAgentStepResultRequest(step, step.workspaceId),
        );
      }
      // The first workspace step of a run opens its workspace in the same
      // transaction, so the runner may not have the workspace yet. The
      // provision goes first, on the same connection, so the runner has the
      // workspace before it is asked to run anything in it. Sending it again
      // is safe: the runner ignores a provision for a workspace it holds.
      const provision = yield* workspaces.rebuildOwedProvision(step.workspaceId);
      if (Option.isSome(provision)) yield* connections.tell(step.runnerId, provision.value);
      yield* connections.tell(step.runnerId, yield* buildStartFrame(step));
    });

  return WorkspaceSteps.of({
    // A failure to read the rows is logged rather than passed to the run's
    // execution, which cannot do anything about it. The step record stays
    // `running`, and the step is sent again when its runner next connects.
    start: (step) =>
      Effect.catch(start(step), (error) =>
        Effect.logError(
          `Sending workspace step ${step.stepId} of run ${step.runId} to its runner failed; ` +
            "it is sent again when the runner next connects",
          error,
        ),
      ),

    openSession,

    stopSessions,

    settle: (steps) => {
      const byRunner = new Map<string, Array<WorkspaceStepKey>>();
      for (const { runnerId, runId, stepId, iteration } of steps) {
        const onRunner = byRunner.get(runnerId) ?? [];
        onRunner.push({ runId, stepId, iteration });
        byRunner.set(runnerId, onRunner);
      }
      for (const [runnerId, onRunner] of byRunner) {
        // One frame holds at most `MAX_WORKSPACE_STEPS` steps, so a longer
        // list, such as the answer to a long report, is sent in parts.
        const parts: Array<ReadonlyArray<WorkspaceStepKey>> = [];
        for (let at = 0; at < onRunner.length; at += MAX_WORKSPACE_STEPS) {
          parts.push(onRunner.slice(at, at + MAX_WORKSPACE_STEPS));
        }
        runInBackground(
          Effect.forEach(
            parts,
            (part) => connections.tell(runnerId, { _tag: "workspaceStepSettle", steps: part }),
            { discard: true },
          ),
        );
      }
    },
  });
});

/**
 * Implements the runs domain's Workspace Steps port over the runners'
 * connections and the operations on sessions.
 */
export const WorkspaceStepsLayer: Layer.Layer<
  WorkspaceSteps,
  never,
  WorkspaceService | SessionService | RunnerConnections | Placement | Live | SqlClient.SqlClient
> = Layer.effect(WorkspaceSteps)(make);
