/**
 * Workspace Steps: sends a workspace step to the runner its run is pinned to,
 * and asks runners to stop steps.
 *
 * It lives in the controller daemon because only the controller daemon holds
 * the connections to runners. It sits in `runs/` because the port it
 * implements belongs to the runs domain, like the Run Executor beside it.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { WorkspaceStepKey, WorkspaceStepStart } from "@hercule/protocol";
import type { SessionTokens } from "../../permissions";
import { RunnerConnections } from "../../runners";
import { WorkspaceSteps, type WorkspaceStepToStart } from "../../runs";
import type { Secrets } from "../../secrets";
import { buildGitIdentity, gitCredentials, WorkspaceService } from "../../workspaces";

const make = Effect.gen(function* () {
  const workspaces = yield* WorkspaceService;
  const connections = yield* RunnerConnections;
  const credentials = yield* gitCredentials;

  /**
   * Builds the frame that starts a step. The commit author is the account of
   * the workspace's designated Connection, read now rather than stored, the
   * way a session start reads it. Without a usable account the frame carries
   * no identity, and the runner leaves git's own identity unchanged.
   */
  const buildStartFrame = (
    step: WorkspaceStepToStart,
  ): Effect.Effect<WorkspaceStepStart, SqlError> =>
    Effect.gen(function* () {
      const connectionId = yield* workspaces.readDesignatedConnectionId(step.workspaceId);
      const account =
        connectionId === null ? undefined : yield* credentials.githubAccountOf(connectionId);
      return {
        _tag: "workspaceStepStart",
        runId: step.runId,
        stepId: step.stepId,
        iteration: step.iteration,
        workspaceId: step.workspaceId,
        action: step.action,
        input: step.input,
        ...(step.resourceId === undefined ? {} : { resourceId: step.resourceId }),
        ...(account === undefined ? {} : { gitIdentity: buildGitIdentity(account.login) }),
      };
    });

  const start = (step: WorkspaceStepToStart): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      // Nothing is read or sent for a runner that is not connected: when it
      // connects, the controller daemon sends it every step it still owes it,
      // rebuilt from the rows at that moment.
      if (!(yield* connections.holdsConnection(step.runnerId))) return;
      // The first workspace step of a run opens its workspace in the same
      // transaction, so the runner may not have the workspace yet. The
      // provision goes first, on the same connection, so the runner has the
      // workspace before it is asked to run anything in it. Sending it again
      // is safe: the runner ignores a provision for a workspace it holds.
      // ROUND 2: switch to `workspaces.rebuildProvision(step.workspaceId)`.
      const owed = yield* workspaces.owedProvisioning(step.runnerId);
      for (const frame of owed) {
        if (frame.workspaceId === step.workspaceId) yield* connections.tell(step.runnerId, frame);
      }
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

    stop: (steps) =>
      Effect.gen(function* () {
        const byRunner = new Map<string, Array<WorkspaceStepKey>>();
        for (const { runnerId, runId, stepId, iteration } of steps) {
          const onRunner = byRunner.get(runnerId) ?? [];
          onRunner.push({ runId, stepId, iteration });
          byRunner.set(runnerId, onRunner);
        }
        for (const [runnerId, onRunner] of byRunner) {
          yield* connections.tell(runnerId, { _tag: "workspaceStepStop", steps: onRunner });
        }
      }),
  });
});

/** Implements the runs domain's Workspace Steps port over the runners' connections. */
export const WorkspaceStepsLayer: Layer.Layer<
  WorkspaceSteps,
  never,
  SqlClient.SqlClient | WorkspaceService | RunnerConnections | Secrets | SessionTokens
> = Layer.effect(WorkspaceSteps)(make);
