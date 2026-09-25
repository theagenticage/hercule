/**
 * Retiring a runner: marks it retired, ends the sessions it hosted and the
 * workspaces it held, and fails the runs pinned to it, in one transaction.
 * Then it tells the runner what to stop once that transaction has committed.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { RunnerDetail } from "@hercule/contract";
import { withTransaction } from "../../db";
import { RunnerConnections, RunnerService, type MoveError, type RetireInput } from "../../runners";
import { RunService } from "../../runs";
import { SessionService } from "../../sessions";
import { WorkspaceService } from "../../workspaces";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const runners = yield* RunnerService;
  const sessions = yield* SessionService;
  const workspaces = yield* WorkspaceService;
  const runs = yield* RunService;
  const connections = yield* RunnerConnections;

  return {
    /**
     * Removes a runner from the fleet. Returns the retired runner. It does not
     * wait for work to finish: the sessions it hosted end with it, and its
     * workspaces are marked lost, because they are directories on a disk this
     * controller will never reach again.
     */
    retireRunner: (input: RetireInput): Effect.Effect<RunnerDetail, MoveError> =>
      // The commit and the hang-up must not be split. If the client
      // disconnected between them, the row would be retired while the runner
      // stayed connected, pinging a controller that will never take it back.
      Effect.uninterruptible(
        Effect.gen(function* () {
          const { detail, toStop } = yield* withTransaction(
            sql,
            Effect.gen(function* () {
              // `retire` returns its timestamp, so the workspaces are marked lost
              // at the same instant the runner was retired.
              const { at, ...detail } = yield* runners.retire(input);
              // Without `force`, `retire` has already rejected a runner with a
              // running session, so this ends only queued sessions. With
              // `force`, it ends both. Either way a retired runner never
              // dispatches again, so nothing else would ever end them.
              const toStop = yield* sessions.endOnRunner(detail.id);
              yield* workspaces.lostOnRunner(detail.id, at);
              // A run pinned to the runner can never run another step in its
              // workspace, which is lost with the runner.
              yield* runs.failRunsPinnedTo(detail.id, `runner ${detail.name} was retired`);
              return { detail, toStop };
            }),
          );
          // After the commit: a session now marked exited may still have a
          // running harness on the runner, which needs a stop frame. Queued
          // sessions were never sent to the runner, so they get no frame.
          for (const sessionId of toStop) {
            yield* connections.tell(detail.id, sessions.stopping(sessionId));
          }
          // Also after the commit: closing the socket for a retirement that then
          // rolled back would disconnect a runner the controller still has.
          yield* connections.hangUp(detail.id);
          return detail;
        }),
      ),
  };
});

export class Retirement extends Context.Service<Retirement, Effect.Success<typeof make>>()(
  "hercule/controller/daemon/Retirement",
) {}

export const RetirementLayer: Layer.Layer<
  Retirement,
  never,
  | SqlClient.SqlClient
  | RunnerService
  | SessionService
  | WorkspaceService
  | RunService
  | RunnerConnections
> = Layer.effect(Retirement)(make);
