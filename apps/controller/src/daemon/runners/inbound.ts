/**
 * The only consumer of what the fleet reports:
 *
 * - the sessions a runner holds, and what happens in them;
 * - the result of provisioning a workspace, and of each workspace step;
 * - the git credentials a runner asks for;
 * - the end of a device login, which calls for a fresh probe;
 * - every change that may have given a runner room for more work.
 *
 * There are two queues, each read by its own fiber. Session traffic has its
 * own queue, so a session's events are applied in the order the runner
 * numbered them, and the rest of the fleet's reports do not wait behind them.
 * Work that waits on a runner, such as a flush or a dispatch, is forked and
 * never done inline. A failure in one item is logged and dropped, so one
 * report that fails to write does not stop the traffic of every other runner.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { withTransaction } from "../../db";
import { ProviderProbes } from "../../providers";
import { RunnerConnections, type FleetTraffic, type SessionTraffic } from "../../runners";
import { RunService, WorkspaceSteps } from "../../runs";
import { SessionService, type StoredInput } from "../../sessions";
import { WorkspaceService } from "../../workspaces";
import { absorbFailures, forkAndAbsorbFailures } from "../absorbing";
import { Dispatch, Live } from "../sessions";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const connections = yield* RunnerConnections;
  const sessions = yield* SessionService;
  const workspaces = yield* WorkspaceService;
  const runs = yield* RunService;
  const workspaceSteps = yield* WorkspaceSteps;
  const probes = yield* ProviderProbes;
  const { dispatch } = yield* Dispatch;
  const { sendClaimed, deliverQueuedInput } = yield* Live;

  const applyFleetTraffic = (traffic: FleetTraffic): Effect.Effect<void, SqlError> => {
    switch (traffic._tag) {
      case "workspaceReported":
        return Effect.gen(function* () {
          // This is the only place the domains meet. The workspaces domain
          // records the runner's report, and the sessions and runs domains
          // decide what it means for the sessions and runs working in the
          // workspace. All the writes are one transaction, so a failed
          // workspace and the work it strands are updated together or not at
          // all.
          const settled = yield* withTransaction(
            sql,
            Effect.gen(function* () {
              const settled = yield* workspaces.reported(traffic.runnerId, traffic.report);
              // A workspace that failed to provision ends the sessions waiting
              // on it, with the runner's error message as the reason, and
              // fails the runs working in it.
              if (settled?.moved === "failed") {
                const { message } = traffic.report;
                yield* sessions.endForWorkspace(settled.workspaceId, message ?? null);
                yield* runs.failRunsInWorkspace(
                  settled.workspaceId,
                  message ?? "The runner could not provision the workspace, and gave no reason.",
                );
              }
              return settled;
            }),
          );
          // A workspace that became ready lets its waiting sessions start. The
          // dispatch sends frames to the runner, so it runs after the commit,
          // on its own fiber.
          if (settled?.moved === "ready") {
            yield* forkAndAbsorbFailures(
              "Dispatching sessions to a ready workspace failed",
              dispatch(traffic.runnerId),
            );
          }
        });
      case "credentialRequested":
        // The credential is valid for this one request only, so it is sent
        // straight back on the connection that asked, and never stored.
        return Effect.flatMap(
          workspaces.credentialAnswer(traffic.runnerId, traffic.request),
          (answer) => Effect.asVoid(connections.tell(traffic.runnerId, answer)),
        );
      case "workspaceStepReported":
        return Effect.gen(function* () {
          const { runnerId, result } = traffic;
          yield* runs.recordStepResult(runnerId, result);
          // The step's end is recorded now, or was already, or the result
          // was ignored because the runner has no business with the step.
          // Either way the controller never asks for this result again, so
          // the step is settled, and the runner deletes its result file. For a
          // step in a repo's main workspace, which is never deleted, nothing
          // else deletes it.
          const { runId, stepId, iteration } = result;
          workspaceSteps.settle([{ runnerId, runId, stepId, iteration }]);
        });
      case "workspaceStepsReported":
        // The runner holds steps whose records ended while it was away, for
        // example because their run was cancelled. Each one is settled.
        return Effect.map(
          runs.listEndedWorkspaceSteps(traffic.runnerId, traffic.report.steps),
          workspaceSteps.settle,
        );
      case "loginEnded":
        // A device login reads nothing back, so its end carries no outcome.
        // A fresh probe of the instance on that runner tells whether the user
        // finished it, and announces the new snapshot to everyone watching.
        // Forked, because the probe waits on the runner.
        return forkAndAbsorbFailures(
          "Probing an instance after its login ended failed",
          probes.probe(traffic.runnerId, traffic.ended.instanceId),
        );
      case "placementsChanged":
        // Forked, like the dispatch for a ready workspace: filling a runner's
        // free room takes a transaction and a credential read per session, and
        // the rest of the fleet must not wait behind one runner. The runner
        // may also have become placeable without reconnecting, for example by
        // being undrained, so the runs waiting for a runner are woken too.
        return Effect.andThen(
          forkAndAbsorbFailures("Dispatching to a freed slot failed", dispatch(traffic.runnerId)),
          runs.wakeRunsWaitingForRunner(),
        );
    }
  };

  const ingestSessionTraffic = (traffic: SessionTraffic): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      if (traffic.frame._tag === "sessionsReport") {
        const ended = yield* sessions.bound(traffic.runnerId, traffic.frame.sessions);
        // Mark the runner only after the write is committed. The mark lives in
        // a `Map`, which does not roll back, so a report that failed to write
        // must not make the runner dispatchable.
        yield* connections.markSessionsReported(traffic.runnerId, traffic.connection);
        // A process for a session the controller has already ended keeps
        // running without a token, and it blocks a resume of that session on
        // the runner. Nothing else would stop it, so the runner is told to.
        for (const id of ended) {
          yield* connections.tell(traffic.runnerId, sessions.stopping(id));
        }
        yield* forkAndAbsorbFailures(
          "Dispatching after a runner's sessions report failed",
          dispatch(traffic.runnerId),
        );
        return;
      }
      if (traffic.frame._tag === "sessionInputResult") {
        return yield* sessions.applyInputResult(traffic.runnerId, traffic.frame);
      }
      const { seq, event } = traffic.frame;
      // The fold reads and publishes but writes nothing, so it runs outside
      // the transaction. A browser watching the session gets the delta
      // whether or not the write succeeds.
      const report = yield* sessions.foldReport(traffic.runnerId, seq, event);
      if (report === undefined) return;
      const { applied, claimed } = yield* withTransaction(
        sql,
        Effect.gen(function* () {
          const applied = yield* sessions.applyReport(traffic.runnerId, event, report);
          // A session that went idle can take its oldest queued input. The
          // input is claimed in the same transaction as the change to idle,
          // so no delivery pass can read the session as idle and claim an
          // input of its own first.
          const claimed =
            applied.moved === "idle"
              ? yield* sessions.claimOldest(event.sessionId)
              : Option.none<StoredInput>();
          return { applied, claimed };
        }),
      );
      // The claimed input is sent after the commit, because the send waits on
      // the runner. A session that exited has freed a slot on its runner.
      if (Option.isSome(claimed)) {
        yield* forkAndAbsorbFailures(
          "Sending a session's queued input failed",
          sendClaimed(claimed.value),
        );
      }
      if (applied.moved === "exited") {
        yield* forkAndAbsorbFailures(
          "Dispatching to a freed slot failed",
          dispatch(traffic.runnerId),
        );
      }
      // A session that exited while input waited for it is resumed in place,
      // so the input runs, unless the session service holds it back.
      if (applied.exitedHoldingInput === true) {
        yield* forkAndAbsorbFailures(
          "Resuming an exited session for its waiting input failed",
          deliverQueuedInput(event.sessionId),
        );
      }
    });

  return {
    driving: Stream.runForEach(connections.fleetTraffic, (traffic) =>
      absorbFailures("Applying a runner's report failed", applyFleetTraffic(traffic)),
    ),

    ingesting: Stream.runForEach(connections.sessionTraffic, (traffic) =>
      absorbFailures("Recording a session report failed", ingestSessionTraffic(traffic)),
    ),
  };
});

export class Inbound extends Context.Service<Inbound, Effect.Success<typeof make>>()(
  "hercule/controller/daemon/Inbound",
) {}

export const InboundLayer: Layer.Layer<
  Inbound,
  never,
  | SqlClient.SqlClient
  | RunnerConnections
  | SessionService
  | WorkspaceService
  | RunService
  | WorkspaceSteps
  | ProviderProbes
  | Dispatch
  | Live
> = Layer.effect(Inbound)(make);
