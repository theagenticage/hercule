/**
 * What holding a connection does to a runner row: who is let in, and how the
 * row follows the connection once they are.
 *
 * This is not an operation and it is not on `RunnerService`. No grant reaches
 * it, because the machine behind it is not a user; what it presents is its
 * durable credential, which is why admission takes the token as an argument.
 * Every row it writes is stamped `system`: a runner is never an actor.
 *
 * The one piece of state it keeps is which connection each runner is currently
 * reachable through. A row is a single value and a machine can be dialling
 * again before the connection it lost has finished unwinding, so without it the
 * losing connection's parting `unreachable` would land after the new
 * connection's `online` and show a working machine as dead. Every write here
 * names the connection that asked for it and is dropped when that connection is
 * no longer the runner's, and the connection it replaces is asked to hang up,
 * because a runner holds one connection and not as many as it opens.
 *
 * The map lives only as long as the process. A controller that stopped without
 * draining left rows saying `online` that nothing is connected to, which is
 * what `strandedByTheLastRun` corrects before the listener binds.
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

/** One connection, as something the runner row can be compared against. */
export type Connection = symbol;

/** A fresh identity for a connection about to be held. */
export const newConnection = (): Connection => Symbol("runner connection");

/** How a connection ended: announced, or gone quiet. */
export type Departure = "offline" | "unreachable";

/** What a runner is currently reachable through, and how to let it go. */
interface Reachable {
  readonly connection: Connection;
  /** Asks the connection to hang up, because a newer one has taken its place. */
  readonly displace: () => void;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const runners = yield* runnerRepository;
  const audit = yield* AuditLog;

  const reachable = new Map<string, Reachable>();

  /** Records a state the runner moved to. A move to where it already is is not one. */
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
    /**
     * The runner a presented credential belongs to, or `None` when it belongs
     * to none. Only the hash was ever stored, which is all a lookup needs.
     */
    admits: (credential: string): Effect.Effect<Option.Option<string>, SqlError> =>
      runners.byCredential(hashToken(credential)),

    /**
     * Puts a runner online on this connection, with what its hello said, and
     * lets go of whatever connection it was reachable through before.
     *
     * The map is written after the transaction commits: a `Map` does not roll
     * back, so a hello that failed to write would otherwise leave the runner
     * pointed at a connection that never came online, and silence the departure
     * of the one that had.
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
            // The hello rewrites the version, the capabilities and the facts
            // whether or not the state moved, and a runner that dials again
            // inside the silence window never left `online` - so the row can
            // change here with nothing in the log to announce it.
            yield* announce({ _tag: "record", topic: "runner", id, kind: "updated" });
          }),
        );
        const previous = reachable.get(id);
        reachable.set(id, { connection, displace });
        if (previous !== undefined) previous.displace();
      }),

    /**
     * Records that the runner answered. Which connection heard it does not
     * matter: an answer on a connection that has since been replaced is still
     * that machine saying it is there, and all this writes is when.
     */
    answered: (id: string): Effect.Effect<void, SqlError> =>
      Effect.flatMap(nowIso, (at) => runners.touch(id, at)),

    /**
     * Stores what a runner said about its machine, on the connection it is
     * currently reachable through. A report that arrives on a connection the
     * runner has already replaced is stale by definition, and writing it would
     * put yesterday's machine back over today's.
     */
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
          // A fresh report writes no audit row - what a machine has installed
          // is not an event anyone reads back - so the fleet's watchers are
          // told here rather than by the log.
          yield* announce({ _tag: "record", topic: "runner", id, kind: "updated" });
        }),
      ),

    /**
     * Stores the headroom a runner reported. The reading is refreshed every
     * time; what is recorded is the machine crossing its watermark, because
     * that is the part placement acts on.
     */
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
     * Records that this connection ended. `offline` is an announced departure
     * and `unreachable` is silence; which one it was is the connection's to
     * say, because only it heard the announcement or failed to.
     *
     * The ownership test sits inside the transaction. Acquiring the connection
     * the transaction runs on is a wait, so testing outside it would let the
     * runner's next connection come online in the gap and this one's parting
     * `unreachable` land on top of it.
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
     * Moves every runner the last run left connected to `unreachable`.
     *
     * A row saying `online` means a connection is open, and no connection
     * survives the process that held it. A controller killed rather than
     * drained would otherwise show its whole fleet as ready for work for ever,
     * because the only thing that moves a runner off `online` is the connection
     * that put it there.
     */
    strandedByTheLastRun: Effect.gen(function* () {
      yield* withTransaction(
        sql,
        Effect.gen(function* () {
          const at = yield* nowIso;
          for (const id of yield* runners.connected()) yield* moved(id, "unreachable", at);
        }),
      );
    }),
  };
});

/** What the runner socket does to the fleet. */
export class RunnerPresence extends Context.Service<RunnerPresence, Effect.Success<typeof make>>()(
  "hydra/controller/runners/RunnerPresence",
) {}

export const RunnerPresenceLayer: Layer.Layer<
  RunnerPresence,
  never,
  SqlClient.SqlClient | AuditLog
> = Layer.effect(RunnerPresence)(make);
