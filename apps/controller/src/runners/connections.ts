/**
 * The controller's live connections to runners, and what they do to runner
 * rows. This is not an operation and not on `RunnerService`: it checks no
 * grant, and every audit entry is stamped `system`.
 *
 * The only state kept here is which connection each runner is reachable
 * through. A runner can connect again before its old connection has finished
 * closing. Without the map, the old connection's final `unreachable` would
 * overwrite the new connection's `online`. The map is lost when the process
 * stops, which `strandedByTheLastRun` corrects before the server starts
 * listening.
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
  type WorkspaceStepResult,
  type WorkspaceStepsReport,
} from "@hercule/protocol";
import { SYSTEM_ACTOR } from "../actor";
import { hashToken } from "../credentials";
import { announce, nowIso, withTransaction } from "../db";
import { AuditLog } from "../events";
import { NotificationService } from "../notifications";
import { runnerRepository, type RunnerHelloRecord } from "./repository";

export type Connection = symbol;

export const mintConnection = (): Connection => Symbol("runner connection");

export type Departure = "offline" | "unreachable";

export const DISPLACED_CLOSE_REASON = "this runner opened another connection";

/** Long enough for a runner to collect its facts, short enough to answer a button click. */
const RUNNER_FACTS_DEADLINE: Duration.Duration = Duration.seconds(10);

/** How long `refreshedFacts` waits for a report. Tests pass a shorter deadline they can wait for. */
export const RunnerFactsDeadline = Context.Reference<Duration.Duration>(
  "hercule/controller/runners/RunnerFactsDeadline",
  { defaultValue: (): Duration.Duration => RUNNER_FACTS_DEADLINE },
);

export type Request = ProbeRequest | InstallRequest | LoginStart | LoginCode | SessionInput;

/**
 * A frame a runner sent about the sessions it hosts, and which runner sent it.
 * The connections do not interpret it: the sessions domain decides what a
 * session event means, and if this domain knew that, the runners domain would
 * sit above sessions instead of below. The connection is included so the
 * consumer can mark it as caught up, keyed by connection like every other
 * write here.
 *
 * A `sessionInputResult` is session traffic as well as an answer: whether an
 * input opened a turn changes the session's status, and a status must be
 * written in the order the runner reported things.
 */
export interface SessionTraffic {
  readonly runnerId: string;
  readonly connection: Connection;
  readonly frame: SessionEvent | SessionsReport | SessionInputResult;
}

/**
 * Events the controller daemon acts on: a runner reporting something that is
 * not about a session, or this domain changing something that may free a
 * runner for work. This domain does not interpret them; the controller daemon
 * does. They share one queue, so a runner's reports are passed on in the order
 * they arrived, and changes made by this domain join the queue as they happen.
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
  | {
      readonly _tag: "workspaceStepReported";
      readonly runnerId: string;
      readonly result: WorkspaceStepResult;
    }
  | {
      readonly _tag: "workspaceStepsReported";
      readonly runnerId: string;
      readonly report: WorkspaceStepsReport;
    }
  | { readonly _tag: "placementsChanged"; readonly runnerId: string };

/** A runner's answer to a `Request`, matched to it by the request's id. */
export type Answer =
  ProbeReport | InstallResult | LoginUrl | LoginFailed | LoginResult | SessionInputResult;

/**
 * The key callers of `refreshedFacts` wait under. The facts report has no
 * request id, so it needs a key that no request id can be. The empty string
 * works, because a `RequestId` has at least one character. A word would not
 * work, because a runner could send an answer with that word as its id.
 */
const FACTS_KEY = "";

/**
 * How many recent arrivals a late subscriber still receives. One is enough for
 * the boot window; a handful covers a fleet that connects all at once.
 */
const ARRIVALS_REPLAY = 16;

interface FactsReported {
  readonly _tag: "factsReported";
}

const FACTS_REPORTED: FactsReported = { _tag: "factsReported" };

type Reported = Answer | FactsReported;

/** The callbacks this service uses to reach a runner's open connection. */
export interface Connected {
  /**
   * Asks the connection to close with a code and a reason. Only the connection
   * can write to its own socket, and a runner has one current connection,
   * however many times it connects.
   */
  readonly close: (code: number, reason: string) => void;
  /** Sends the runner a request for its facts. Answered by `reportedFacts`. */
  readonly askForFacts: Effect.Effect<void>;
  /**
   * Writes one frame. The answer to a request arrives through
   * `reportedAnswer` with the same id; other frames get no answer.
   */
  readonly ask: (frame: ControllerToRunner) => Effect.Effect<void>;
}

interface Reachable extends Connected {
  readonly connection: Connection;
  /**
   * The callers waiting for an answer, keyed by request id. It is kept per
   * connection, so closing the connection ends every wait on it, and an answer
   * with an id nobody sent wakes nobody. One key can have several callers,
   * because a runner sends one report however many callers asked for it.
   */
  readonly pending: Map<string, Set<Deferred.Deferred<Option.Option<Reported>>>>;
  /**
   * Whether this connection's `sessionsReport` has been applied yet. A new
   * connection starts with `false`: its sessions are unknown until it reports
   * them, and until then the controller cannot account for a session started
   * on it.
   */
  reported: boolean;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const runners = yield* runnerRepository;
  const audit = yield* AuditLog;
  const notifications = yield* NotificationService;

  const reachable = new Map<string, Reachable>();
  // Unbounded, so a runner's hello never waits for a slow subscriber. It
  // replays recent arrivals, because the subscriber starts on a forked fiber
  // while the server is already starting to listen. Without the replay, a
  // runner that connected in that window would not be probed until the hourly
  // tick.
  const arrivals = yield* PubSub.unbounded<string>({ replay: ARRIVALS_REPLAY });
  // A queue rather than a pub/sub, because exactly one consumer reads it, and a
  // queue built with the layer keeps what arrives before that consumer starts.
  // Order is what matters: the sessions domain applies events in the order the
  // runner numbered them.
  const sessions = yield* Queue.unbounded<SessionTraffic>();
  // A second queue rather than a second tag on the first: session frames are
  // applied by one consumer in order, and a workspace report stuck behind a
  // transcript backlog would keep a session waiting for a workspace that is
  // already ready.
  const fleet = yield* Queue.unbounded<FleetTraffic>();

  /**
   * Ends every wait on a connection that will send nothing more, so the
   * callers get `none` now rather than at their own deadline.
   */
  const abandon = (held: Reachable | undefined): void => {
    for (const waiting of held?.pending.values() ?? []) {
      for (const one of waiting) Deferred.doneUnsafe(one, Exit.succeed(Option.none()));
    }
    held?.pending.clear();
  };

  /**
   * Wakes every caller waiting under this key. A report for a key nobody is
   * waiting on is dropped: an id the controller never sent, or a second report
   * for one it did.
   */
  const wakeWaiters = (held: Reachable, key: string, reported: Reported): void => {
    const waiting = held.pending.get(key);
    if (waiting === undefined) return;
    held.pending.delete(key);
    for (const one of waiting) Deferred.doneUnsafe(one, Exit.succeed(Option.some(reported)));
  };

  /**
   * Adds one item to the fleet queue, unless the connection it came from has
   * been replaced: a report from an old connection must not be acted on as if
   * it came from the current one.
   */
  const publish = (id: string, connection: Connection, item: FleetTraffic): Effect.Effect<void> =>
    Effect.suspend(() =>
      reachable.get(id)?.connection === connection
        ? Effect.asVoid(Queue.offer(fleet, item))
        : Effect.void,
    );

  /**
   * Sends a frame and waits for the report under `key`. Returns `none` when
   * the runner has no connection, the connection ended, or nothing came back
   * in time. Callers report all three the same way: the runner did not answer.
   *
   * A timeout ends only this caller's wait: the frame may still be answered,
   * and other callers waiting under the same key still get that answer.
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
        // Remove this caller's entry: nothing else will, and leaving it would
        // grow the map for the life of the connection.
        Effect.sync(() => {
          waiting.delete(mine);
          // Only if this set is still the one under the key. A report wakes
          // callers by removing the key first, so a caller that arrives under
          // the same key meanwhile has created a new set, and this finalizer
          // must not delete it.
          if (waiting.size === 0 && held.pending.get(key) === waiting) held.pending.delete(key);
        }),
      );
    });

  /**
   * Sets the runner's connectivity, and records an audit entry when it
   * changed. Setting the current value writes nothing. Only connectivity is
   * written here: the lifecycle belongs to the user, and a drain outlasts a
   * dropped socket.
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
    /** Returns the id of the runner this credential belongs to. Only the hash is stored, and the lookup needs only that. */
    admits: (credential: string): Effect.Effect<Option.Option<string>, SqlError> =>
      runners.byCredential(hashToken(credential)),

    /** Checks whether a rejected credential belonged to a retired runner, so the error can say so. */
    wasRetired: (credential: string): Effect.Effect<boolean, SqlError> =>
      runners.wasRetired(hashToken(credential)),

    /**
     * Records a runner's hello, marks it online, and makes this connection the
     * runner's current one, closing any previous connection. The map is
     * updated after the transaction commits, because a `Map` does not roll
     * back: a failed write would otherwise leave the map pointing at a
     * connection that never came online.
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
            // The hello rewrites the version, capabilities and facts whether or
            // not the connectivity changed, so the row can change without an
            // audit entry. Announce it either way.
            yield* announce({ _tag: "record", topic: "runner", id, kind: "updated" });
          }),
        );
        const previous = reachable.get(id);
        reachable.set(id, { connection, ...connected, pending: new Map(), reported: false });
        if (previous !== undefined) {
          // The replaced connection will send nothing more, and its map entry
          // is gone, so its waiting callers are released now.
          abandon(previous);
          previous.close(GOING_AWAY_CLOSE_CODE, DISPLACED_CLOSE_REASON);
        }
      }),

    /**
     * Announces that a runner has connected, after the controller's hello was
     * sent. The runner drops every frame that arrives before that hello, so an
     * earlier announcement could get its first request dropped.
     */
    arrived: (id: string): Effect.Effect<void> => PubSub.publish(arrivals, id).pipe(Effect.asVoid),

    /**
     * A stream of the ids of runners that have just connected. This service
     * does not decide what to do about an arrival; subscribers do.
     */
    arrivals: Stream.fromPubSub(arrivals),

    /**
     * Closes the runner's connection, if it has one, with the "retired" close
     * code. Retiring revokes the credential, so this closes the live socket as
     * soon as the retirement is committed.
     */
    hangUp: (id: string): Effect.Effect<void> =>
      Effect.sync(() => {
        reachable.get(id)?.close(RETIRED_CLOSE_CODE, RETIRED_CLOSE_REASON);
      }),

    /**
     * Asks the runner to report its facts now and waits for the report, which
     * arrives through `reportedFacts`. Returns `false` when the runner has no
     * connection, the connection ended first, or nothing came back in time.
     */
    refreshedFacts: (id: string): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const deadline = yield* RunnerFactsDeadline;
        // Every call sends a request: another caller's wait does not prove a
        // request is still in flight, and skipping it could make the button
        // do nothing.
        const answer = yield* askAndAwaitReport(
          id,
          FACTS_KEY,
          (held) => held.askForFacts,
          deadline,
        );
        return Option.isSome(answer);
      }),

    /**
     * Sends a request to the runner and waits for its answer, up to
     * `deadline`. Returns `none` when the runner has no connection, the
     * connection ended, or no answer came in time.
     */
    asked: (
      id: string,
      request: Request,
      deadline: Duration.Duration,
    ): Effect.Effect<Option.Option<Answer>> =>
      Effect.map(
        askAndAwaitReport(id, request.requestId, (held) => held.ask(request), deadline),
        // The facts report uses its own key, never a request id, so only an
        // answer can arrive under this key.
        Option.filter((reported): reported is Answer => reported._tag !== "factsReported"),
      ),

    /**
     * Passes a runner's answer to the callers waiting for it. An answer with
     * an id nobody sent, or from a replaced connection, is dropped: either
     * would let a runner write something it was not asked for.
     */
    reportedAnswer: (id: string, connection: Connection, answer: Answer): Effect.Effect<void> =>
      Effect.sync(() => {
        const held = reachable.get(id);
        if (held?.connection !== connection) return;
        wakeWaiters(held, answer.requestId, answer);
      }),

    /**
     * Checks whether this runner has an open connection right now. For a
     * caller deciding whether to start work only a connected runner can
     * finish. A caller that just has a frame to send uses `tell`, which finds
     * out by trying.
     */
    holdsConnection: (id: string): Effect.Effect<boolean> => Effect.sync(() => reachable.has(id)),

    /**
     * Sends one frame to a runner, without waiting for an answer. Returns
     * `false` when the runner has no connection, which a caller reports as a
     * session it could not place.
     */
    tell: (id: string, frame: ControllerToRunner): Effect.Effect<boolean> =>
      Effect.suspend(() => {
        const held = reachable.get(id);
        if (held === undefined) return Effect.succeed(false);
        return Effect.as(held.ask(frame), true);
      }),

    /**
     * Adds a runner's session frame to the session queue. A frame from a
     * replaced connection is dropped: an old connection must not overwrite the
     * session state the current one reports.
     */
    reportedSession: (
      id: string,
      connection: Connection,
      frame: SessionEvent | SessionsReport | SessionInputResult,
    ): Effect.Effect<void> =>
      Effect.suspend(() =>
        reachable.get(id)?.connection === connection
          ? Effect.asVoid(Queue.offer(sessions, { runnerId: id, connection, frame }))
          : Effect.void,
      ),

    /** A stream of every session frame runners sent, in arrival order. */
    sessionTraffic: Stream.fromQueue(sessions),

    /**
     * Publishes a runner's workspace report. The controller daemon decides
     * what it means for the workspace row and for the sessions waiting on it.
     */
    reportedWorkspace: (
      id: string,
      connection: Connection,
      report: WorkspaceReport,
    ): Effect.Effect<void> =>
      publish(id, connection, { _tag: "workspaceReported", runnerId: id, report }),

    /**
     * Publishes a runner's request for the credential git needs. The answer
     * is a frame back to the runner, which the controller daemon sends, so the
     * request is published rather than answered here.
     */
    requestedCredential: (
      id: string,
      connection: Connection,
      request: CredentialRequest,
    ): Effect.Effect<void> =>
      publish(id, connection, { _tag: "credentialRequested", runnerId: id, request }),

    /**
     * Publishes how one of a runner's workspace steps ended. The runs domain
     * records it, through the controller daemon.
     */
    reportedWorkspaceStep: (
      id: string,
      connection: Connection,
      result: WorkspaceStepResult,
    ): Effect.Effect<void> =>
      publish(id, connection, { _tag: "workspaceStepReported", runnerId: id, result }),

    /**
     * Publishes the workspace steps a runner says it is running, sent when it
     * connects. The controller daemon stops each one whose record has ended.
     */
    reportedWorkspaceSteps: (
      id: string,
      connection: Connection,
      report: WorkspaceStepsReport,
    ): Effect.Effect<void> =>
      publish(id, connection, { _tag: "workspaceStepsReported", runnerId: id, report }),

    /**
     * Publishes that this runner may now have room for work, for example
     * because its cap was raised, it was undrained, it is no longer reserved,
     * or its watermark was lowered below its free disk. This domain does not know whether any session or run is
     * waiting for that room.
     */
    placementsChanged: (id: string): Effect.Effect<void> =>
      Effect.asVoid(Queue.offer(fleet, { _tag: "placementsChanged", runnerId: id })),

    /** A stream of every fleet event another domain acts on. */
    fleetTraffic: Stream.fromQueue(fleet),

    /**
     * Checks whether this runner's current connection has had a sessions
     * report applied yet. Returns `false` for a runner with no connection.
     */
    hasReportedSessions: (id: string): Effect.Effect<boolean> =>
      Effect.sync(() => reachable.get(id)?.reported ?? false),

    /**
     * Marks this connection as caught up, once its sessions report has been
     * applied. Ignored for a replaced connection: a report from an old
     * connection says nothing about whether the current one has caught up.
     */
    markSessionsReported: (id: string, connection: Connection): Effect.Effect<void> =>
      Effect.sync(() => {
        const held = reachable.get(id);
        if (held?.connection === connection) held.reported = true;
      }),

    /**
     * Records a pong as the runner's last-seen time. A pong on a replaced
     * connection still counts, because it still shows the runner is up.
     */
    answered: (id: string): Effect.Effect<void, SqlError> =>
      Effect.flatMap(nowIso, (at) => runners.touch(id, at)),

    /**
     * Stores a runner's facts report and wakes the callers of
     * `refreshedFacts`. A report from a replaced connection is ignored, so an
     * old connection cannot overwrite the current one's facts.
     */
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
            // No audit entry: what a runner has installed is not an event anyone
            // reads back, so clients watching the fleet are notified instead.
            yield* announce({ _tag: "record", topic: "runner", id, kind: "updated" });
            return true;
          }),
        );
        // After the commit, so a woken caller reads the new facts rather than
        // the old ones. The connection is checked again in case the runner
        // reconnected in between: callers on the new connection are waiting
        // for its own report, which has not arrived yet.
        const held = recorded ? reachable.get(id) : undefined;
        if (held?.connection === connection) wakeWaiters(held, FACTS_KEY, FACTS_REPORTED);
      }),

    /**
     * Stores a runner's watermark report. An audit entry is written only when
     * the runner starts or stops accepting placements, because that is what
     * placement acts on.
     */
    reportedWatermark: (
      id: string,
      connection: Connection,
      watermark: RunnerWatermark,
    ): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        const freed = yield* withTransaction(
          sql,
          Effect.gen(function* () {
            if (reachable.get(id)?.connection !== connection) return false;
            const at = yield* nowIso;
            const result = yield* runners.recordWatermark(id, watermark, at);
            if (!result.crossed) return false;
            yield* audit.append({
              kind: "runner.placementsChanged",
              actor: SYSTEM_ACTOR,
              record: { topic: "runner", id },
              payload: { runnerId: id, acceptingPlacements: result.accepting },
              at,
            });
            return result.accepting;
          }),
        );
        // Placement reads the disk space only to compare it with the
        // watermark. So only a report that brings the runner back above the
        // watermark gives it room for work. Publishing every routine report
        // would wake every run waiting for a runner once a minute per runner.
        // Published after the write, so whoever acts on it reads the new disk
        // space rather than the old value.
        if (freed) yield* publish(id, connection, { _tag: "placementsChanged", runnerId: id });
      }),

    /**
     * Records that a connection ended: removes it from the map and sets the
     * runner `offline` or `unreachable`. The connection passes the departure,
     * because only it knows whether a `goodbye` arrived. The ownership check is
     * inside the transaction, because starting a transaction can wait, and the
     * runner's next connection could come online in that gap.
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
          // The connection has closed, whether or not the row could be moved
          // off online, so everyone waiting on it is released now rather than
          // at their own deadline.
          Effect.sync(() => {
            if (held?.connection !== connection) return;
            abandon(held);
          }),
        );
      }),

    /**
     * Raises one `core.runner-unreachable` notification for each runner that
     * is unreachable and was last seen at or before `cutoff`, unless one was
     * already raised about it since it was last seen. A runner that drops and
     * comes back within the grace the caller's cutoff allows raises nothing;
     * one that stays away raises one notification however long it stays away,
     * and one more the next time it is lost after it came back.
     */
    notifyUnreachableRunners: (cutoff: string): Effect.Effect<void, SqlError> =>
      withTransaction(
        sql,
        Effect.gen(function* () {
          for (const runner of yield* runners.listUnreachableSeenBefore(cutoff)) {
            const subject = { kind: "runner", id: runner.id } as const;
            if (
              yield* notifications.hasCoreNotificationSince(
                "core.runner-unreachable",
                subject,
                runner.lastSeenAt,
              )
            ) {
              continue;
            }
            yield* notifications.createCoreNotification({
              kind: "core.runner-unreachable",
              title: `Runner ${runner.name} is unreachable`,
              body: "Its connection dropped without a goodbye, and it has not reconnected. Work placed on it waits until it does.",
              subject: [subject],
            });
          }
        }),
      ),

    /**
     * Marks every runner still `online` as `unreachable`, at boot. No
     * connection survives the process that held it, and only a connection
     * moves its runner off `online`. Without this, a controller that was
     * killed rather than shut down would show the fleet as online forever.
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
  SqlClient.SqlClient | AuditLog | NotificationService
> = Layer.effect(RunnerConnections)(make);
