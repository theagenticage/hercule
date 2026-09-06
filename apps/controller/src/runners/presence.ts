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
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { RunnerConnectivity, RunnerFacts, RunnerWatermark } from "@hydra/contract";
import { GOING_AWAY_CLOSE_CODE, RETIRED_CLOSE_CODE, RETIRED_CLOSE_REASON } from "@hydra/protocol";
import { SYSTEM_ACTOR } from "../actor";
import { hashToken } from "../credentials";
import { announce, nowIso, withTransaction } from "../db";
import { AuditLog } from "../events";
import { runnerRepository, type RunnerHelloRecord } from "./repository";

export type Connection = symbol;

export const newConnection = (): Connection => Symbol("runner connection");

export type Departure = "offline" | "unreachable";

export const DISPLACED_CLOSE_REASON = "this runner opened another connection";

/** Long enough for a machine to run its probe, short enough to answer a click. */
const RUNNER_FACTS_DEADLINE: Duration.Duration = Duration.seconds(10);

/** Tests hand over a deadline they can wait out. */
export const RunnerFactsDeadline = Context.Reference<Duration.Duration>(
  "hydra/controller/runners/RunnerFactsDeadline",
  { defaultValue: (): Duration.Duration => RUNNER_FACTS_DEADLINE },
);

/** How presence reaches back to a connection that is holding a runner. */
export interface Connected {
  /**
   * Asks the connection to close with a code and a reason. Only the connection
   * can write to its own socket, and a runner holds one, not as many as it
   * opens.
   */
  readonly close: (code: number, reason: string) => void;
  /** Sends the runner a request for its facts. Answered by `reportedFacts`. */
  readonly askForFacts: Effect.Effect<void>;
}

interface Reachable extends Connected {
  readonly connection: Connection;
  /**
   * Who is waiting for this connection's next facts report, and whether one
   * arrived. Held here rather than per runner id so that two callers waiting at
   * once share one request and one answer, and so that the connection ending
   * ends the wait with it.
   */
  awaitingFacts: Deferred.Deferred<boolean> | undefined;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const runners = yield* runnerRepository;
  const audit = yield* AuditLog;

  const reachable = new Map<string, Reachable>();

  /**
   * Ends a wait for facts, if the connection is holding one. Only the three
   * things that really end a wait call this - the report arriving, the
   * connection going, and the runner dialling again - so a caller that gave up
   * leaves the wait in place for whoever is still listening.
   */
  const endWait = (held: Reachable | undefined, reported: boolean): void => {
    if (held?.awaitingFacts === undefined) return;
    Deferred.doneUnsafe(held.awaitingFacts, Exit.succeed(reported));
    held.awaitingFacts = undefined;
  };

  /**
   * A move to where the runner already is is not a move, and writes no row.
   * Only connectivity is written here: where the runner stands with its owner
   * is the user's, and a drain outlives the socket that was dropped under it.
   */
  const moved = (id: string, connectivity: RunnerConnectivity, at: string) =>
    Effect.gen(function* () {
      if (!(yield* runners.setConnectivity(id, connectivity, at))) return;
      yield* audit.append({
        kind: "runner.stateChanged",
        actor: SYSTEM_ACTOR,
        record: { topic: "runner", id },
        payload: { runnerId: id, state: connectivity },
        at,
      });
    });

  return {
    /** Only the hash was ever stored, which is all a lookup needs. */
    admits: (credential: string): Effect.Effect<Option.Option<string>, SqlError> =>
      runners.byCredential(hashToken(credential)),

    /** Asked only about a credential already refused, to say why it was. */
    wasRetired: (credential: string): Effect.Effect<boolean, SqlError> =>
      runners.wasRetired(hashToken(credential)),

    /**
     * The map is written after the transaction commits, because a `Map` does not
     * roll back: a hello that failed to write would otherwise point the runner
     * at a connection that never came online.
     */
    greeted: (
      id: string,
      connection: Connection,
      connected: Connected,
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
        reachable.set(id, { connection, ...connected, awaitingFacts: undefined });
        if (previous !== undefined) {
          // Nothing more is coming over the connection being displaced, and the
          // entry that would have carried its answer is no longer the one here.
          endWait(previous, false);
          previous.close(GOING_AWAY_CLOSE_CODE, DISPLACED_CLOSE_REASON);
        }
      }),

    /**
     * Ends the connection a runner is holding, if it is holding one. Retiring
     * revokes the credential, so a live socket outlives the row's meaning by
     * exactly as long as it takes to say so.
     */
    hangUp: (id: string): Effect.Effect<void> =>
      Effect.sync(() => {
        reachable.get(id)?.close(RETIRED_CLOSE_CODE, RETIRED_CLOSE_REASON);
      }),

    /**
     * Asks the runner to report its facts now and waits for the report, which
     * lands through `reportedFacts`. False when the runner is holding no
     * connection, when it ended first, or when nothing came back in time.
     */
    refreshedFacts: (id: string): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const held = reachable.get(id);
        if (held === undefined) return false;
        // A caller arriving while another is already waiting joins that wait:
        // one report answers both, and one report is all a machine sends.
        const mine = held.awaitingFacts ?? Deferred.makeUnsafe<boolean>();
        held.awaitingFacts = mine;
        const deadline = yield* RunnerFactsDeadline;
        // Every call asks: a wait left behind by a caller that gave up is not
        // evidence that a frame is still in flight, and skipping the ask would
        // leave the button inert until the runner reconnects.
        yield* held.askForFacts;
        // Giving up is this caller's, not the request's: the frame is still out
        // there, and whoever is still listening is answered when it comes back.
        const answer = yield* Effect.timeoutOption(Deferred.await(mine), deadline);
        return Option.isSome(answer) && answer.value;
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
      Effect.gen(function* () {
        const recorded = yield* withTransaction(
          sql,
          Effect.gen(function* () {
            if (reachable.get(id)?.connection !== connection) return false;
            yield* runners.recordFacts(id, facts, yield* nowIso);
            // No audit row: what a machine has installed is not an event anyone
            // reads back, so the fleet's watchers are told here instead.
            yield* announce({ _tag: "record", topic: "runner", id, kind: "updated" });
            return true;
          }),
        );
        // After the commit, so a caller woken by this reads the facts it waited
        // for rather than the ones they replaced.
        endWait(recorded ? reachable.get(id) : undefined, true);
      }),

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
      Effect.suspend(() => {
        const held = reachable.get(id);
        return Effect.ensuring(
          withTransaction(
            sql,
            Effect.gen(function* () {
              if (held?.connection !== connection) return;
              reachable.delete(id);
              yield* moved(id, departure, yield* nowIso);
            }),
          ),
          // Nothing is coming over a connection that has gone, whether or not
          // the row could be moved off online, so a caller waiting on this
          // runner's facts is told now rather than at its deadline.
          Effect.sync(() => {
            if (held?.connection === connection) endWait(held, false);
          }),
        );
      }),

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
