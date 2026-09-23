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
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { RunnerConnectivity, RunnerFacts, RunnerWatermark } from "@hercule/contract";
import {
  GOING_AWAY_CLOSE_CODE,
  RETIRED_CLOSE_CODE,
  RETIRED_CLOSE_REASON,
  type InstallRequest,
  type InstallResult,
  type LoginCode,
  type LoginFailed,
  type LoginResult,
  type LoginStart,
  type LoginUrl,
  type ControllerToRunner,
  type ProbeReport,
  type ProbeRequest,
  type SessionEvent,
  type SessionInput,
  type SessionInputResult,
  type SessionsReport,
  type CredentialRequest,
  type WorkspaceReport,
} from "@hercule/protocol";
import { SYSTEM_ACTOR } from "../actor";
import { hashToken } from "../credentials";
import { announce, nowIso, withTransaction } from "../db";
import { AuditLog } from "../events";
import { runnerRepository, type RunnerHelloRecord } from "./repository";

export type Connection = symbol;

export const mintConnection = (): Connection => Symbol("runner connection");

export type Departure = "offline" | "unreachable";

export const DISPLACED_CLOSE_REASON = "this runner opened another connection";

/** Long enough for a machine to run its probe, short enough to answer a click. */
const RUNNER_FACTS_DEADLINE: Duration.Duration = Duration.seconds(10);

/** Tests hand over a deadline they can wait out. */
export const RunnerFactsDeadline = Context.Reference<Duration.Duration>(
  "hercule/controller/runners/RunnerFactsDeadline",
  { defaultValue: (): Duration.Duration => RUNNER_FACTS_DEADLINE },
);

export type Request = ProbeRequest | InstallRequest | LoginStart | LoginCode | SessionInput;

/**
 * What a machine said about the sessions it is hosting, and which machine said
 * it. The connections carry it no further: what a session event means is the
 * session domain's, and the connections knowing that would put the fleet above
 * it rather than under it. The connection rides along so the session domain
 * can mark it caught up on its own authority, the same way every other write
 * keyed by connection identity here does.
 */
export interface SessionTraffic {
  readonly runnerId: string;
  readonly connection: Connection;
  readonly frame: SessionEvent | SessionsReport;
}

/**
 * What the layer above acts on: a machine reporting something that is not about
 * a session, and the runners domain changing something that frees a machine for
 * work. The connections carry none of it further - what any of it means is
 * decided above this domain, in the controller daemon. One queue, so a
 * machine's reports are handed on in the order they arrived in; what this
 * domain changes itself joins them as it happens.
 */
export type FleetTraffic =
  | {
      readonly _tag: "workspaceReported";
      readonly runnerId: string;
      readonly report: WorkspaceReport;
    }
  | {
      readonly _tag: "credentialRequested";
      readonly runnerId: string;
      readonly request: CredentialRequest;
    }
  | { readonly _tag: "placementsChanged"; readonly runnerId: string };

/** What came back for one of those, correlated by the request's own id. */
export type Answer =
  ProbeReport | InstallResult | LoginUrl | LoginFailed | LoginResult | SessionInputResult;

/**
 * The facts report carries no request id: the protocol has one frame for it and
 * a machine sends one report, so it waits under a key no request id can be. The
 * empty string is that key, because a `RequestId` holds at least one character
 * - a spelled-out word would be one a runner could send a report under.
 */
const FACTS_KEY = "";

/**
 * How many arrivals a driver that has not subscribed yet still sees. One is
 * enough for the boot window; a handful covers a fleet that all dials at once.
 */
const ARRIVALS_REPLAY = 16;

interface FactsReported {
  readonly _tag: "factsReported";
}

const FACTS_REPORTED: FactsReported = { _tag: "factsReported" };

type Reported = Answer | FactsReported;

/** How this service reaches back to a connection that is holding a runner. */
export interface Connected {
  /**
   * Asks the connection to close with a code and a reason. Only the connection
   * can write to its own socket, and a runner holds one, not as many as it
   * opens.
   */
  readonly close: (code: number, reason: string) => void;
  /** Sends the runner a request for its facts. Answered by `reportedFacts`. */
  readonly askForFacts: Effect.Effect<void>;
  /**
   * Writes one frame. A request is answered through `reportedAnswer` under the
   * same id; everything else is told, not asked.
   */
  readonly ask: (frame: ControllerToRunner) => Effect.Effect<void>;
}

interface Reachable extends Connected {
  readonly connection: Connection;
  /**
   * Who is waiting for what, keyed by the id the request went out under. Held
   * per connection, so the connection ending ends every wait on it and a report
   * under an id nobody issued wakes nothing. A key holds every caller waiting
   * on it, because one machine sends one report however many asked for it.
   */
  readonly pending: Map<string, Set<Deferred.Deferred<Option.Option<Reported>>>>;
  /**
   * Whether this connection's own `sessionsReport` has been applied yet. A
   * fresh connection starts without one: what it holds is unknown until it
   * says so, and until then a session started here is one the controller
   * cannot yet account for.
   */
  reported: boolean;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const runners = yield* runnerRepository;
  const audit = yield* AuditLog;

  const reachable = new Map<string, Reachable>();
  // Unbounded, so a machine's hello is never held up by whoever is listening.
  // It replays, because the driver subscribes on a forked fiber while the
  // listener is already binding: without the replay a machine that dialled in
  // that window would go unswept until the tick, an hour later.
  const arrivals = yield* PubSub.unbounded<string>({ replay: ARRIVALS_REPLAY });
  // A queue rather than a pub/sub, because exactly one consumer reads it and a
  // queue built with the layer holds what arrives before that consumer has
  // attached. Order is the guarantee that matters: the session domain applies
  // events in the sequence the runner numbered them.
  const sessions = yield* Queue.unbounded<SessionTraffic>();
  // A second queue rather than a second tag on the first: what a machine says
  // about its sessions is applied by one consumer in sequence, and holding a
  // workspace report behind a transcript backlog would keep a session waiting
  // for a working area that is already there.
  const fleet = yield* Queue.unbounded<FleetTraffic>();

  /**
   * Nothing more is coming over this connection, so everybody waiting on it is
   * told now rather than at their own deadline.
   */
  const abandon = (held: Reachable | undefined): void => {
    for (const waiting of held?.pending.values() ?? []) {
      for (const one of waiting) Deferred.doneUnsafe(one, Exit.succeed(Option.none()));
    }
    held?.pending.clear();
  };

  /**
   * Wakes everybody waiting under this key. A key nobody is waiting on is
   * dropped: an id the controller never issued, or a second report under one it
   * did.
   */
  const wakeWaiters = (held: Reachable, key: string, reported: Reported): void => {
    const waiting = held.pending.get(key);
    if (waiting === undefined) return;
    held.pending.delete(key);
    for (const one of waiting) Deferred.doneUnsafe(one, Exit.succeed(Option.some(reported)));
  };

  /**
   * Hands one item to whoever is above this domain, unless the connection it
   * came over has been replaced: yesterday's machine must not be acted on as
   * if it were today's.
   */
  const publish = (id: string, connection: Connection, item: FleetTraffic): Effect.Effect<void> =>
    Effect.suspend(() =>
      reachable.get(id)?.connection === connection
        ? Effect.asVoid(Queue.offer(fleet, item))
        : Effect.void,
    );

  /**
   * Sends one thing and waits for what comes back under `key`. `none` when
   * there is no connection, it ended, or nothing came back in time - the caller
   * reports all three the same way: the machine did not say.
   *
   * Giving up is this caller's alone: the frame is still out there, so whoever
   * else is waiting under the same key is still answered when it comes back.
   */
  const askAndAwaitReport = (
    id: string,
    key: string,
    send: (held: Reachable) => Effect.Effect<void>,
    deadline: Duration.Duration,
  ): Effect.Effect<Option.Option<Reported>> =>
    Effect.suspend(() => {
      const held = reachable.get(id);
      if (held === undefined) return Effect.succeed(Option.none<Reported>());
      const mine = Deferred.makeUnsafe<Option.Option<Reported>>();
      const waiting = held.pending.get(key) ?? new Set();
      waiting.add(mine);
      held.pending.set(key, waiting);
      return Effect.ensuring(
        Effect.gen(function* () {
          yield* send(held);
          const answer = yield* Effect.timeoutOption(Deferred.await(mine), deadline);
          return Option.getOrElse(answer, () => Option.none<Reported>());
        }),
        // Nobody else is listening for this one, and leaving it behind would
        // keep the map growing for the life of the connection.
        Effect.sync(() => {
          waiting.delete(mine);
          // Only if this set is still the one under the key: a report wakes
          // callers by removing the key first, so a caller that arrives under
          // the same key while the woken ones unwind has installed a new set,
          // and that one is not this finalizer's to drop.
          if (waiting.size === 0 && held.pending.get(key) === waiting) held.pending.delete(key);
        }),
      );
    });

  /**
   * A move to where the runner already is is not a move, and writes no row.
   * Only connectivity is written here: where the runner stands with its owner
   * is the user's, and a drain outlives the socket that was dropped under it.
   */
  const changeConnectivity = (id: string, connectivity: RunnerConnectivity, at: string) =>
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
            yield* changeConnectivity(id, "online", at);
            // The hello rewrites version, capabilities and facts whether or not
            // the state moved, so the row can change with nothing in the log.
            yield* announce({ _tag: "record", topic: "runner", id, kind: "updated" });
          }),
        );
        const previous = reachable.get(id);
        reachable.set(id, { connection, ...connected, pending: new Map(), reported: false });
        if (previous !== undefined) {
          // Nothing more is coming over the connection being displaced, and the
          // entry that would have carried its answer is no longer the one here.
          abandon(previous);
          previous.close(GOING_AWAY_CLOSE_CODE, DISPLACED_CLOSE_REASON);
        }
      }),

    /**
     * Says a machine is in, once the controller's own hello has gone out: the
     * runner drops anything that reaches it before that, so an arrival
     * announced any earlier is one whose first request is thrown away.
     */
    arrived: (id: string): Effect.Effect<void> => PubSub.publish(arrivals, id).pipe(Effect.asVoid),

    /**
     * Every machine that has just said hello. What to do about an arrival is
     * not this service's business, so whoever has an opinion listens here.
     */
    arrivals: Stream.fromPubSub(arrivals),

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
        const deadline = yield* RunnerFactsDeadline;
        // Every call asks: another caller's wait is no evidence a frame is
        // still in flight, and skipping the ask would leave the button inert.
        const answer = yield* askAndAwaitReport(
          id,
          FACTS_KEY,
          (held) => held.askForFacts,
          deadline,
        );
        return Option.isSome(answer);
      }),

    asked: (
      id: string,
      request: Request,
      deadline: Duration.Duration,
    ): Effect.Effect<Option.Option<Answer>> =>
      Effect.map(
        askAndAwaitReport(id, request.requestId, (held) => held.ask(request), deadline),
        // The facts report answers its own key and no request id, so nothing
        // but an answer can come back under this one.
        Option.filter((reported): reported is Answer => reported._tag !== "factsReported"),
      ),

    /**
     * Dropped under an id nobody issued, or on a replaced connection: either
     * would let a machine write a row it was not asked to.
     */
    reportedAnswer: (id: string, connection: Connection, answer: Answer): Effect.Effect<void> =>
      Effect.sync(() => {
        const held = reachable.get(id);
        if (held?.connection !== connection) return;
        wakeWaiters(held, answer.requestId, answer);
      }),

    /**
     * Sends one frame to a runner, with nothing to wait for. False when the
     * machine is holding no connection, which is what a caller reports as a
     * session it could not place.
     */
    /**
     * Whether this machine is holding a connection this moment. For a caller
     * deciding whether to start work that only a connected machine can
     * finish; a caller that simply has a frame to send uses `tell`, which
     * answers the same question by trying.
     */
    holdsConnection: (id: string): Effect.Effect<boolean> => Effect.sync(() => reachable.has(id)),

    tell: (id: string, frame: ControllerToRunner): Effect.Effect<boolean> =>
      Effect.suspend(() => {
        const held = reachable.get(id);
        if (held === undefined) return Effect.succeed(false);
        return Effect.as(held.ask(frame), true);
      }),

    /**
     * Dropped on a replaced connection: yesterday's machine must not write over
     * the session state today's is reporting.
     */
    reportedSession: (
      id: string,
      connection: Connection,
      frame: SessionEvent | SessionsReport,
    ): Effect.Effect<void> =>
      Effect.suspend(() =>
        reachable.get(id)?.connection === connection
          ? Effect.asVoid(Queue.offer(sessions, { runnerId: id, connection, frame }))
          : Effect.void,
      ),

    /** Everything the fleet has said about its sessions, in arrival order. */
    sessionTraffic: Stream.fromQueue(sessions),

    /**
     * What a machine made of a working area. What that means for the workspace
     * row, and for the sessions waiting on it, is decided above this domain.
     */
    reportedWorkspace: (
      id: string,
      connection: Connection,
      report: WorkspaceReport,
    ): Effect.Effect<void> =>
      publish(id, connection, { _tag: "workspaceReported", runnerId: id, report }),

    /**
     * A machine asking for the credential git needs. The answer is a frame back
     * to it, which is why the question is published rather than answered here.
     */
    requestedCredential: (
      id: string,
      connection: Connection,
      request: CredentialRequest,
    ): Effect.Effect<void> =>
      publish(id, connection, { _tag: "credentialRequested", runnerId: id, request }),

    /**
     * This machine may have room for work it had none for a moment ago: its
     * cap was raised or a drain was lifted. Whether anything is waiting for
     * that room is not the fleet's to know.
     */
    placementsChanged: (id: string): Effect.Effect<void> =>
      Effect.asVoid(Queue.offer(fleet, { _tag: "placementsChanged", runnerId: id })),

    /** Everything the fleet reports or changes that another domain acts on. */
    fleetTraffic: Stream.fromQueue(fleet),

    /**
     * Whether this runner's current connection has applied a sessions report
     * yet. False for a runner holding no connection at all, same as any other
     * fact this map has no entry for.
     */
    hasReportedSessions: (id: string): Effect.Effect<boolean> =>
      Effect.sync(() => reachable.get(id)?.reported ?? false),

    /**
     * Marks this connection caught up, once its sessions report has been
     * applied. Dropped on a replaced connection: a report that landed for
     * yesterday's connection says nothing about whether today's has caught up.
     */
    markSessionsReported: (id: string, connection: Connection): Effect.Effect<void> =>
      Effect.sync(() => {
        const held = reachable.get(id);
        if (held?.connection === connection) held.reported = true;
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
        // for rather than the ones they replaced. Still this connection's, in
        // case the runner reconnected in between: the new connection's waiters
        // are waiting on the new machine, and it has not spoken yet.
        const held = recorded ? reachable.get(id) : undefined;
        if (held?.connection === connection) wakeWaiters(held, FACTS_KEY, FACTS_REPORTED);
      }),

    /** Only the crossing is recorded, because that is the part placement acts on. */
    reportedWatermark: (
      id: string,
      connection: Connection,
      watermark: RunnerWatermark,
    ): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        yield* withTransaction(
          sql,
          Effect.gen(function* () {
            if (reachable.get(id)?.connection !== connection) return;
            const at = yield* nowIso;
            const result = yield* runners.recordWatermark(id, watermark, at);
            if (!result.crossed) return;
            yield* audit.append({
              kind: "runner.placementsChanged",
              actor: SYSTEM_ACTOR,
              record: { topic: "runner", id },
              payload: { runnerId: id, acceptingPlacements: result.accepting },
              at,
            });
          }),
        );
        // After the write, so whoever acts on the room this machine has reads
        // the disk it just reported rather than the one it replaced. A report
        // that crossed nothing still says the machine is there with that disk,
        // which is what placement reads.
        yield* publish(id, connection, { _tag: "placementsChanged", runnerId: id });
      }),

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
              yield* changeConnectivity(id, departure, yield* nowIso);
            }),
          ),
          // Nothing is coming over a connection that has gone, whether or not
          // the row could be moved off online, so everybody waiting on this one
          // is told now rather than at their own deadline.
          Effect.sync(() => {
            if (held?.connection !== connection) return;
            abandon(held);
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
        for (const id of yield* runners.connected())
          yield* changeConnectivity(id, "unreachable", at);
      }),
    ),
  };
});

export class RunnerConnections extends Context.Service<
  RunnerConnections,
  Effect.Success<typeof make>
>()("hercule/controller/runners/RunnerConnections") {}

export const RunnerConnectionsLayer: Layer.Layer<
  RunnerConnections,
  never,
  SqlClient.SqlClient | AuditLog
> = Layer.effect(RunnerConnections)(make);
