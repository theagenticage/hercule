/**
 * What holding a connection does to a runner row. Not an operation and not on
 * `RunnerService`: no grant reaches it, and every row is stamped `system`.
 *
 * The one state it keeps is which connection each runner is reachable through. A
 * machine can dial again before the connection it lost has finished unwinding,
 * so without it the loser's parting `unreachable` would land on top of the new
 * connection's `online`. The map dies with the process, which is what
 * `strandedByTheLastRun` corrects before the listener binds.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { RunnerFacts, RunnerWatermark } from "@hydra/contract";
import { SYSTEM_ACTOR } from "../actor";
import { hashToken } from "../credentials";
import { announce, nowIso, withTransaction } from "../db";
import { AuditLog } from "../events";
import { runnerRepository, type RunnerHelloRecord } from "./repository";

export type Connection = symbol;

export const newConnection = (): Connection => Symbol("runner connection");

export type Departure = "offline" | "unreachable";

interface Reachable {
  readonly connection: Connection;
  /** Asks the connection to hang up: a runner holds one, not as many as it opens. */
  readonly displace: () => void;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const runners = yield* runnerRepository;
  const audit = yield* AuditLog;

  const reachable = new Map<string, Reachable>();

  /** A move to where the runner already is is not a move, and writes no row. */
  const moved = (id: string, state: Departure | "online", at: string) =>
    Effect.gen(function* () {
      if (!(yield* runners.setState(id, state, at))) return;
      yield* audit.append({
        kind: "runner.stateChanged",
        actor: SYSTEM_ACTOR,
        record: { topic: "runner", id },
        payload: { runnerId: id, state },
        at,
      });
    });

  return {
    /** Only the hash was ever stored, which is all a lookup needs. */
    admits: (credential: string): Effect.Effect<Option.Option<string>, SqlError> =>
      runners.byCredential(hashToken(credential)),

    /**
     * The map is written after the transaction commits, because a `Map` does not
     * roll back: a hello that failed to write would otherwise point the runner
     * at a connection that never came online.
     */
    greeted: (
      id: string,
      connection: Connection,
      displace: () => void,
      hello: RunnerHelloRecord,
    ): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const at = yield* nowIso;
            yield* runners.recordHello(id, hello, at);
            yield* moved(id, "online", at);
            // The hello rewrites version, capabilities and facts whether or not
            // the state moved, so the row can change with nothing in the log.
            yield* announce({ _tag: "record", topic: "runner", id, kind: "updated" });
          }),
        );
        const previous = reachable.get(id);
        reachable.set(id, { connection, displace });
        if (previous !== undefined) previous.displace();
      }),

    /** An answer on a replaced connection is still that machine saying it is there. */
    answered: (id: string): Effect.Effect<void, SqlError> =>
      Effect.flatMap(nowIso, (at) => runners.touch(id, at)),

    /** A report on a replaced connection would put yesterday's machine over today's. */
    reportedFacts: (
      id: string,
      connection: Connection,
      facts: RunnerFacts,
    ): Effect.Effect<void, SqlError> =>
      withTransaction(
        sql,
        Effect.gen(function* () {
          if (reachable.get(id)?.connection !== connection) return;
          yield* runners.recordFacts(id, facts, yield* nowIso);
          // No audit row: what a machine has installed is not an event anyone
          // reads back, so the fleet's watchers are told here instead.
          yield* announce({ _tag: "record", topic: "runner", id, kind: "updated" });
        }),
      ),

    /** Only the crossing is recorded, because that is the part placement acts on. */
    reportedWatermark: (
      id: string,
      connection: Connection,
      watermark: RunnerWatermark,
    ): Effect.Effect<void, SqlError> =>
      withTransaction(
        sql,
        Effect.gen(function* () {
          if (reachable.get(id)?.connection !== connection) return;
          const at = yield* nowIso;
          if (!(yield* runners.recordWatermark(id, watermark, at))) return;
          yield* audit.append({
            kind: "runner.placementsChanged",
            actor: SYSTEM_ACTOR,
            record: { topic: "runner", id },
            payload: { runnerId: id, acceptingPlacements: watermark.acceptingPlacements },
            at,
          });
        }),
      ),

    /**
     * Which departure it was is the connection's to say, because only it heard
     * the announcement or failed to. The ownership test sits inside the
     * transaction because acquiring it is a wait, and the runner's next
     * connection could come online in that gap.
     */
    ended: (
      id: string,
      connection: Connection,
      departure: Departure,
    ): Effect.Effect<void, SqlError> =>
      withTransaction(
        sql,
        Effect.gen(function* () {
          if (reachable.get(id)?.connection !== connection) return;
          reachable.delete(id);
          yield* moved(id, departure, yield* nowIso);
        }),
      ),

    /**
     * No connection survives the process that held it, and the only thing that
     * moves a runner off `online` is the connection that put it there. Without
     * this, a controller killed rather than drained shows a ready fleet for ever.
     */
    strandedByTheLastRun: withTransaction(
      sql,
      Effect.gen(function* () {
        const at = yield* nowIso;
        for (const id of yield* runners.connected()) yield* moved(id, "unreachable", at);
      }),
    ),
  };
});

export class RunnerPresence extends Context.Service<RunnerPresence, Effect.Success<typeof make>>()(
  "hydra/controller/runners/RunnerPresence",
) {}

export const RunnerPresenceLayer: Layer.Layer<
  RunnerPresence,
  never,
  SqlClient.SqlClient | AuditLog
> = Layer.effect(RunnerPresence)(make);
