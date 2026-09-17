/**
 * The one consumer of what the fleet publishes that is not about a session: a
 * machine's report about a working area, its request for a git credential, and
 * every change that may have left it room for work.
 *
 * One fiber, so what a machine reported first is applied first, except the
 * dispatch it forks off. Each item absorbs its own failure: one report that
 * will not write must not stop the traffic of every other machine.
 */
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { RunnerPresence, type FleetTraffic } from "../runners";
import { SessionService } from "../sessions";
import { WorkspaceService } from "../workspaces";

/**
 * A driver must not stop on one item, so the cause is logged and dropped - a
 * defect as much as a failure, because a bug applying one report would
 * otherwise take the driver down for the life of the process, silently and for
 * the whole fleet. A cause carrying an interrupt is the driver being stopped
 * and is passed on whole, so nothing that rode along with it is lost.
 */
const absorbing = (
  what: string,
  effect: Effect.Effect<void, SqlError>,
): Effect.Effect<void, SqlError> =>
  Effect.catchCause(effect, (cause) =>
    Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.logError(what, cause),
  );

const make = Effect.gen(function* () {
  const presence = yield* RunnerPresence;
  const sessions = yield* SessionService;
  const workspaces = yield* WorkspaceService;

  const applying = (traffic: FleetTraffic): Effect.Effect<void, SqlError> => {
    switch (traffic._tag) {
      case "workspaceReported":
        return Effect.gen(function* () {
          // The two domains meet here and nowhere else: what a machine made of
          // a working area is the workspaces domain's to record, and what it
          // means for the sessions waiting on it is the sessions domain's.
          const settled = yield* workspaces.reported(traffic.runnerId, traffic.report);
          if (settled === undefined) return;
          yield* sessions.workspaceSettled(
            traffic.runnerId,
            settled,
            traffic.report.message ?? null,
          );
        });
      case "credentialRequested":
        return workspaces.credentialAsked(traffic.runnerId, traffic.request);
      case "placementsChanged":
        // Forked, unlike the two above: starting what a machine now has room
        // for is a transaction and a credential read per session, and the rest
        // of the fleet must not wait behind one machine's.
        return Effect.asVoid(
          Effect.forkChild(
            absorbing("A freed slot could not be dispatched", sessions.dispatch(traffic.runnerId)),
          ),
        );
    }
  };

  return {
    driving: Stream.runForEach(presence.fleetTraffic, (traffic) =>
      absorbing("A runner's report could not be applied", applying(traffic)),
    ),
  };
});

export class Inbound extends Context.Service<Inbound, Effect.Success<typeof make>>()(
  "hydra/controller/daemon/Inbound",
) {}

export const InboundLayer: Layer.Layer<
  Inbound,
  never,
  RunnerPresence | SessionService | WorkspaceService
> = Layer.effect(Inbound)(make);
