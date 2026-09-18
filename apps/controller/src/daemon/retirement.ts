/**
 * Retiring a machine: what it costs the fleet, the sessions it was hosting and
 * the working areas it held, in one write set, and what has to be said to the
 * machine once that write set is durable.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { RunnerDetail } from "@hydra/contract";
import { withTransaction } from "../db";
import { RunnerConnections, RunnerService, type MoveError, type RetireInput } from "../runners";
import { SessionService } from "../sessions";
import { WorkspaceService } from "../workspaces";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const runners = yield* RunnerService;
  const sessions = yield* SessionService;
  const workspaces = yield* WorkspaceService;
  const connections = yield* RunnerConnections;

  return {
    /**
     * Ends a machine's membership of the fleet. It finishes nothing: the
     * sessions it was hosting end with it and the working areas it held are
     * gone, because they were directories on a disk this controller will never
     * reach again.
     */
    retireRunner: (input: RetireInput): Effect.Effect<RunnerDetail, MoveError> =>
      // The commit and the close are one step: a client hanging up between
      // them would leave the row retired with its daemon still holding on,
      // pinging a controller that will never have it back.
      Effect.uninterruptible(
        Effect.gen(function* () {
          const { detail, toStop } = yield* withTransaction(
            sql,
            Effect.gen(function* () {
              // The instant comes back with the row, so the working areas are
              // lost at the instant the machine was retired at.
              const { at, ...detail } = yield* runners.retire(input);
              // Without `force` this ends only what is queued, since the row's
              // half already refused a machine with a session running; with it,
              // both kinds. Either way a retired runner never dispatches again,
              // so nothing else would ever end these.
              const toStop = yield* sessions.endOnRunner(detail.id);
              yield* workspaces.lostOnRunner(detail.id, at);
              return { detail, toStop };
            }),
          );
          // After the commit: a session the row now reads exited still had a
          // live harness on the machine, which needs its own word to stop - the
          // queued ones never had a frame to begin with, so they get none now
          // either.
          for (const sessionId of toStop) {
            yield* connections.tell(detail.id, { _tag: "sessionStop", sessionId });
          }
          // After the commit too: a socket closed for a retirement that then
          // rolled back would be a runner told to stop by a controller that
          // still has it.
          yield* connections.hangUp(detail.id);
          return detail;
        }),
      ),
  };
});

export class Retirement extends Context.Service<Retirement, Effect.Success<typeof make>>()(
  "hydra/controller/daemon/Retirement",
) {}

export const RetirementLayer: Layer.Layer<
  Retirement,
  never,
  SqlClient.SqlClient | RunnerService | SessionService | WorkspaceService | RunnerConnections
> = Layer.effect(Retirement)(make);
