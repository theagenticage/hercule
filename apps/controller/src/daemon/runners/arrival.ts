/**
 * What a runner that has just connected is sent: the work the controller
 * still owes it, rebuilt from the rows, because anything sent while it was
 * away was lost. In order:
 *
 * 1. the provision of every workspace on it that is still provisioning and
 *    has no step running in it;
 * 2. every workspace step still running on it: a workspace action again,
 *    after the provision of its workspace when that workspace is still
 *    provisioning, and for an agent step whose prompt is `sent` or
 *    `delivered`, a request for the step's result;
 * 3. a stop for every session on it whose run ended while it was away;
 * 4. then the runs waiting for a runner are woken, because this one may be
 *    able to take them.
 *
 * Each delivery is idempotent by its key, so a runner that already has the
 * workspace or the step ignores it, or answers from the result it kept.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { RunnerConnections } from "../../runners";
import { RunService, WorkspaceSteps } from "../../runs";
import { WorkspaceService } from "../../workspaces";
import { forkAndAbsorbFailures } from "../absorbing";

const make = Effect.gen(function* () {
  const connections = yield* RunnerConnections;
  const workspaces = yield* WorkspaceService;
  const runs = yield* RunService;
  const workspaceSteps = yield* WorkspaceSteps;

  /** Sends a runner that has just connected the work owed to it, and wakes the runs waiting for one. */
  const sendOwedWork = (runnerId: string): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      const steps = yield* runs.listOwedWorkspaceSteps(runnerId);
      // Starting an action step sends its workspace's provision first, so
      // those workspaces are left out here rather than provisioned twice. A
      // request for an agent step's result sends no provision.
      const startedWorkspaceIds = new Set(
        steps.flatMap((step) => (step.kind === "action" ? [step.workspaceId] : [])),
      );
      for (const frame of yield* workspaces.listOwedProvisioning(runnerId)) {
        if (!startedWorkspaceIds.has(frame.workspaceId)) yield* connections.tell(runnerId, frame);
      }
      for (const step of steps) yield* workspaceSteps.start(step);
      yield* runs.stopSessionsOfEndedRuns(runnerId);
      yield* runs.wakeRunsWaitingForRunner();
    });

  return {
    /** Runs forever. Sends each runner that connects the work owed to it. */
    driving: Stream.runForEach(connections.arrivals, (runnerId) =>
      forkAndAbsorbFailures(
        `Sending runner ${runnerId} the work owed to it failed`,
        sendOwedWork(runnerId),
      ),
    ),
  };
});

export class Arrival extends Context.Service<Arrival, Effect.Success<typeof make>>()(
  "hercule/controller/daemon/Arrival",
) {}

export const ArrivalLayer: Layer.Layer<
  Arrival,
  never,
  RunnerConnections | WorkspaceService | RunService | WorkspaceSteps
> = Layer.effect(Arrival)(make);
