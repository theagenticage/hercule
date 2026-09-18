/**
 * The one consumer of everything the fleet publishes: what a machine says about
 * the sessions it holds, what it made of a working area, the git credentials it
 * asks for, and every change that may have left it room for work.
 *
 * Two queues, two fibers. Session traffic is its own, so a session's events are
 * applied in the order the machine numbered them; the rest of the fleet's
 * reports must not wait behind them. What either fiber forks - a flush, a
 * dispatch - waits on a machine and so is never done inline. Each item absorbs
 * its own failure: one report that will not write must not stop the traffic of
 * every other machine.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { withTransaction } from "../db";
import { RunnerPresence, type FleetTraffic, type SessionTraffic } from "../runners";
import { SessionService } from "../sessions";
import { WorkspaceService } from "../workspaces";
import { absorbing, forking } from "./absorbing";
import { Dispatch } from "./dispatch";
import { Live } from "./live";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const presence = yield* RunnerPresence;
  const sessions = yield* SessionService;
  const workspaces = yield* WorkspaceService;
  const { dispatch } = yield* Dispatch;
  const { flush } = yield* Live;

  const applying = (traffic: FleetTraffic): Effect.Effect<void, SqlError> => {
    switch (traffic._tag) {
      case "workspaceReported":
        return Effect.gen(function* () {
          // The two domains meet here and nowhere else: what a machine made of
          // a working area is the workspaces domain's to record, and what it
          // means for the sessions waiting on it is the sessions domain's. One
          // write set, so a working area that could not be made and the
          // sessions it strands move together or not at all.
          const settled = yield* withTransaction(
            sql,
            Effect.gen(function* () {
              const settled = yield* workspaces.reported(traffic.runnerId, traffic.report);
              // A working area that could not be made ends the sessions waiting
              // on it, with the machine's own words.
              if (settled?.moved === "failed") {
                yield* sessions.endForWorkspace(
                  settled.workspaceId,
                  traffic.report.message ?? null,
                );
              }
              return settled;
            }),
          );
          // After the commit, and forked: a working area that came up releases
          // the sessions waiting on it, and that reaches the machine.
          if (settled?.moved === "ready") {
            yield* forking(
              "A ready working area could not be dispatched",
              dispatch(traffic.runnerId),
            );
          }
        });
      case "credentialRequested":
        // The answer is good for this one request, so it goes straight back on
        // the connection that asked and is written down nowhere.
        return Effect.flatMap(
          workspaces.credentialAnswer(traffic.runnerId, traffic.request),
          (answer) => Effect.asVoid(presence.tell(traffic.runnerId, answer)),
        );
      case "placementsChanged":
        // Forked, like the dispatch a ready working area sets off: starting
        // what a machine now has room for is a transaction and a credential
        // read per session, and the rest of the fleet must not wait behind one
        // machine's.
        return forking("A freed slot could not be dispatched", dispatch(traffic.runnerId));
    }
  };

  const ingesting = (traffic: SessionTraffic): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      if (traffic.frame._tag === "sessionsReport") {
        yield* sessions.bound(traffic.runnerId, traffic.frame.sessions);
        // Once that write set is durable and not before: a `Map` does not roll
        // back, so a runner is not dispatchable on a report that never landed.
        yield* presence.markSessionsReported(traffic.runnerId, traffic.connection);
        yield* forking("A runner's report could not be dispatched", dispatch(traffic.runnerId));
        return;
      }
      const { seq, event } = traffic.frame;
      // The fold reads and taps but writes nothing, so it stays outside: a
      // delta reaches a watching browser whether or not the write lands.
      const report = yield* sessions.foldReport(traffic.runnerId, seq, event);
      if (report === undefined) return;
      const applied = yield* withTransaction(
        sql,
        Effect.gen(function* () {
          const applied = yield* sessions.applyReport(traffic.runnerId, event, report);
          // In the session's own write set: a session starting or ending is
          // work in the working area it runs in, which is what keeps that area
          // from expiring under it, and the two facts are one commit.
          if (applied.worked !== undefined) {
            yield* workspaces.touched(applied.worked.workspaceId, applied.worked.at);
          }
          return applied;
        }),
      );
      // A session that has gone idle can take what is queued for it; one that
      // has exited has left its machine a slot free.
      if (applied.moved === "idle") {
        yield* forking("A session's queued input could not be sent", flush(event.sessionId));
      }
      if (applied.moved === "exited") {
        yield* forking("A freed slot could not be dispatched", dispatch(traffic.runnerId));
      }
    });

  return {
    driving: Stream.runForEach(presence.fleetTraffic, (traffic) =>
      absorbing("A runner's report could not be applied", applying(traffic)),
    ),

    ingesting: Stream.runForEach(presence.sessionTraffic, (traffic) =>
      absorbing("A session report could not be recorded", ingesting(traffic)),
    ),
  };
});

export class Inbound extends Context.Service<Inbound, Effect.Success<typeof make>>()(
  "hydra/controller/daemon/Inbound",
) {}

export const InboundLayer: Layer.Layer<
  Inbound,
  never,
  SqlClient.SqlClient | RunnerPresence | SessionService | WorkspaceService | Dispatch | Live
> = Layer.effect(Inbound)(make);
