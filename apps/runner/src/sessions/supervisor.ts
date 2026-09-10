/**
 * The runner's session supervisor: what this machine is hosting, and the one
 * place a normalized event gets its sequence number on the way out.
 *
 * The table and the sequence are the supervisor's, not a connection's: a
 * session outlives the socket that started it, and the sequence is the
 * controller's idempotency key, so restarting it on a reconnect would make the
 * controller drop events it has never seen. There is no outbox yet either, so
 * an event produced while the socket is down is lost (spec 03 section 2.3).
 */
import { rmSync } from "node:fs";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import {
  MAX_MESSAGE_LENGTH,
  type ExitReason,
  type ProviderEvent,
  type RunnerToController,
  type SessionInput,
  type SessionInputResult,
  type SessionInterrupt,
  type SessionStart,
  type SessionStop,
} from "@hydra/protocol";
import { noAdapterFor, type ProviderAdapter } from "../providers";
import { now, wentWrong } from "../report";
import { resolve, type Machine } from "./context";

/**
 * One session this runner holds. The binding is not here: the adapters are the
 * authority on what they are hosting (spec 03 section 2.2).
 */
interface Live {
  readonly adapter: ProviderAdapter;
  readonly scratch: string | undefined;
  /** How long this session may sit with no event while a turn is open. */
  readonly inactivityMs: number;
  /** Clock time of the last event of this session while a turn was open. */
  lastEventAt: number;
  /**
   * One fiber for as long as a turn is open, watching `lastEventAt` against
   * `inactivityMs`; forked on `turn.started`, interrupted on `turn.completed`.
   * Undefined whenever no turn is open, which is also when a stuck harness
   * cannot be told from an idle one.
   */
  inactivity: Fiber.Fiber<void> | undefined;
  /**
   * Ends the session at its spec's absolute deadline; lives and dies with
   * this entry. Undefined only in the moment between the entry being set and
   * this fiber being forked.
   */
  absolute: Fiber.Fiber<void> | undefined;
}

/** What one connection lends the supervisor for as long as it is up. */
export interface Connection {
  readonly machine: Machine;
  /**
   * The error type is the transport's business: a write that failed means the
   * connection is going, and there is nowhere left to report that to.
   */
  readonly send: (frame: RunnerToController) => Effect.Effect<void, unknown>;
}

export interface SessionSupervisor {
  /**
   * Every adapter's events, sequenced and sent, until the connection ends.
   * Forked, because it never returns.
   */
  readonly relay: Effect.Effect<void>;
  /** What the adapters are hosting. Reconciling it is the controller's. */
  readonly report: Effect.Effect<void>;
  readonly start: (frame: SessionStart) => Effect.Effect<void>;
  readonly input: (frame: SessionInput) => Effect.Effect<void>;
  readonly interrupt: (frame: SessionInterrupt) => Effect.Effect<void>;
  readonly stop: (frame: SessionStop) => Effect.Effect<void>;
}

/**
 * The value `supervising` hands back: the per-connection builder, and the
 * process-wide shutdown beside it. A session outlives the socket that started
 * it, and so does the shutdown that ends every one of them - neither belongs
 * to one connection's `SessionSupervisor`.
 */
export interface Supervising {
  (connection: Connection): SessionSupervisor;
  /**
   * Stops every session this runner holds and waits for each to have produced
   * its `session.exited` through whichever connection's relay is up, bounded
   * so a harness that will not die does not hold up the caller for ever.
   * Fences new starts first, so nothing spawns behind the goodbye this call
   * precedes.
   */
  readonly shutdown: (reason: ExitReason) => Effect.Effect<void>;
}

/**
 * The most a shutdown waits on a harness to confirm it stopped: long enough
 * for an ordinary exit, short enough that a stuck one does not delay the
 * goodbye a person would notice.
 */
const SHUTDOWN_STOP_BOUND: Duration.Duration = Duration.seconds(5);

/** Taken once, so the state below is the process's rather than a connection's. */
export const supervising = (adapters: ReadonlyArray<ProviderAdapter>): Supervising => {
  const live = new Map<string, Live>();
  let lastSeq = 0;
  /**
   * One entry per session `shutdown` is waiting on, resolved once its
   * `session.exited` has gone out on `sending` - not merely reached `release`,
   * which runs first and would let the wait return before the frame crossed
   * the socket.
   */
  const stopping = new Map<string, Deferred.Deferred<void>>();
  // Assigning a number and writing it are one step, on whichever fiber gets
  // here first: the relay and a frame being answered both emit, and a sequence
  // that reached the wire out of order is one the controller may never insert.
  const sequencing = Semaphore.makeUnsafe(1);
  // Set once, by `shutdown`: the process is going, so a start the controller
  // sent before it heard about that is one nothing would ever stop.
  let stopped = false;

  const builder = (connection: Connection): SessionSupervisor => {
    const discard = (scratch: string | undefined): void => {
      if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
    };

    /**
     * On any cause, not only a failed write: a frame that will not encode is
     * one event lost rather than the whole relay, which would drop every
     * session's traffic for the life of the connection with nobody watching.
     */
    const sending = (frame: RunnerToController): Effect.Effect<void> =>
      Effect.ignoreCause(Effect.suspend(() => connection.send(frame)));

    /** Interrupts both timer fibers of one entry and discards its scratch. */
    const teardown = (held: Live): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (held.inactivity !== undefined) yield* Fiber.interrupt(held.inactivity);
        if (held.absolute !== undefined) yield* Fiber.interrupt(held.absolute);
        discard(held.scratch);
      });

    /**
     * Forgets an exited session, on the adapter's authority rather than the
     * event's: a session id started again while its old exit was still in
     * flight is a different session, and the old run must not sweep it away.
     */
    const release = (sessionId: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const held = live.get(sessionId);
        if (held === undefined) return;
        const still = yield* held.adapter.listSessions;
        if (still.some((binding) => binding.sessionId === sessionId)) return;
        // By identity, taken again after the wait above: a fresh start for
        // this id may have already replaced the entry while this call was
        // asking the adapter, and the adapter has not registered it yet
        // either - `still` says nothing about that start, only about the one
        // this exit belongs to.
        if (live.get(sessionId) !== held) return;
        live.delete(sessionId);
        yield* teardown(held);
      });

    /**
     * One fiber for the life of a turn. It sleeps to `lastEventAt +
     * inactivityMs` and rechecks rather than trusting why it woke: an event
     * arriving mid-sleep only moves `lastEventAt` (no interrupt, no fork), so
     * the fiber already asleep has to notice the deadline moved on its own.
     */
    const watchingInactivity = (held: Live, sessionId: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        while (true) {
          const remaining = held.lastEventAt + held.inactivityMs - (yield* Clock.currentTimeMillis);
          if (remaining > 0) {
            yield* Effect.sleep(Duration.millis(remaining));
            continue;
          }
          held.inactivity = undefined;
          // By identity: this entry may be someone else's, or gone, by the
          // time the deadline is reached.
          if (live.get(sessionId) === held) {
            yield* held.adapter.stopSession(sessionId, "inactivity_timeout");
          }
          return;
        }
      });

    /**
     * Every event leaves through here, in the order it was sequenced. Arming
     * or moving the inactivity clock happens first, so a caller that has seen
     * the frame this event produced has also seen what it did to the clock.
     */
    const forward = (event: ProviderEvent): Effect.Effect<void> =>
      sequencing.withPermits(1)(
        Effect.gen(function* () {
          const held = live.get(event.sessionId);
          if (held !== undefined) {
            switch (event._tag) {
              case "turn.started":
                held.lastEventAt = yield* Clock.currentTimeMillis;
                held.inactivity = yield* Effect.forkDetach(
                  watchingInactivity(held, event.sessionId),
                );
                break;
              case "turn.completed": {
                const fiber = held.inactivity;
                held.inactivity = undefined;
                if (fiber !== undefined) yield* Fiber.interrupt(fiber);
                break;
              }
              default:
                // Only matters while a turn is open: one between turns says
                // nothing about a turn getting stuck, and there is no fiber
                // to move.
                if (held.inactivity !== undefined)
                  held.lastEventAt = yield* Clock.currentTimeMillis;
            }
          }
          lastSeq += 1;
          const frame: RunnerToController = { _tag: "sessionEvent", seq: lastSeq, event };
          if (event._tag === "session.exited") yield* release(event.sessionId);
          yield* sending(frame);
          // After the send, not before: a `shutdown` waiting on this deferred
          // must see the frame already on the wire when it wakes.
          if (event._tag === "session.exited") {
            const waiting = stopping.get(event.sessionId);
            if (waiting !== undefined) {
              stopping.delete(event.sessionId);
              yield* Deferred.succeed(waiting, undefined);
            }
          }
        }),
      );

    /** What went wrong, in the session's own stream, where a reader of the thread sees it. */
    const failed = (sessionId: string, message: string): Effect.Effect<void> =>
      forward({
        _tag: "runtime.error",
        eventId: crypto.randomUUID(),
        sessionId,
        at: now(),
        class: "unknown",
        // Cut to what the protocol carries: an over-long message would be a
        // frame that does not encode, and the event would be dropped.
        message: message.slice(0, MAX_MESSAGE_LENGTH),
      });

    /**
     * A session that never started still has to end: the controller holds it in
     * `starting` until an exit says otherwise, and `crash` is the reason for an
     * end nobody asked for that leaves nothing to resume.
     */
    const died = (sessionId: string, message: string): Effect.Effect<void> =>
      Effect.flatMap(failed(sessionId, message), () =>
        forward({
          _tag: "session.exited",
          eventId: crypto.randomUUID(),
          sessionId,
          at: now(),
          reason: "crash",
        }),
      );

    /**
     * One start, from the paths it resolves to the harness it asks for. The
     * entry is held before the harness is asked for and removed on any cause,
     * uninterruptibly: a session that exits while it is still starting must
     * find its own entry, and one that never came up must leave none behind.
     */
    const starting = (frame: SessionStart, adapter: ProviderAdapter): Effect.Effect<void> =>
      resolve(frame, connection.machine, adapter.binaryName).pipe(
        Effect.flatMap((resolved) =>
          Effect.asVoid(
            Effect.uninterruptible(
              Effect.gen(function* () {
                const held: Live = {
                  adapter,
                  scratch: resolved.scratch,
                  inactivityMs: frame.spec.timeouts.inactivityMs,
                  // Meaningless until turn.started sets it alongside `inactivity`.
                  lastEventAt: 0,
                  inactivity: undefined,
                  absolute: undefined,
                };
                live.set(frame.sessionId, held);
                // Armed here, not on `session.started`: a spec's absolute
                // deadline is this runner's own promise to end the session,
                // not something the harness has to confirm first.
                held.absolute = yield* Effect.forkDetach(
                  Effect.andThen(
                    Effect.sleep(Duration.millis(frame.spec.timeouts.absoluteMs)),
                    Effect.suspend(() => {
                      if (live.get(frame.sessionId) !== held) return Effect.void;
                      held.absolute = undefined;
                      return adapter.stopSession(frame.sessionId, "absolute_timeout");
                    }),
                  ),
                );
                // A shutdown between `start`'s own fence and this entry
                // existing would never see this session: nobody would ask the
                // adapter for a harness that is about to be told to stop.
                if (stopped) {
                  live.delete(frame.sessionId);
                  yield* teardown(held);
                  return yield* forward({
                    _tag: "session.exited",
                    eventId: crypto.randomUUID(),
                    sessionId: frame.sessionId,
                    at: now(),
                    reason: "runner_restart",
                  });
                }
                const binding = yield* Effect.tapCause(
                  adapter.startSession(frame.sessionId, frame.spec, resolved.ctx),
                  () =>
                    Effect.gen(function* () {
                      // By identity: a start after this one owns what is there
                      // now, and this one has nothing left to take away.
                      if (live.get(frame.sessionId) !== held) return;
                      live.delete(frame.sessionId);
                      yield* teardown(held);
                    }),
                );
                // A shutdown that ran while the harness was still coming up
                // asked nobody to stop it: it held no entry yet to find.
                if (stopped) yield* adapter.stopSession(frame.sessionId, "runner_restart");
                return binding;
              }),
            ),
          ),
        ),
        Effect.catch((message) => died(frame.sessionId, message)),
        Effect.catchCause((cause) => died(frame.sessionId, wentWrong(cause, MAX_MESSAGE_LENGTH))),
      );

    return {
      relay: Stream.runForEach(
        Stream.mergeAll(
          adapters.map((adapter) => adapter.events),
          { concurrency: "unbounded" },
        ),
        forward,
      ),

      // Asked of the adapters when the controller asks, not built when the
      // connection was made.
      report: Effect.flatMap(
        Effect.forEach(adapters, (adapter) => adapter.listSessions),
        (held) => sending({ _tag: "sessionsReport", sessions: held.flat() }),
      ),

      start: (frame: SessionStart): Effect.Effect<void> =>
        Effect.gen(function* () {
          // A start the controller had already put on the wire when a
          // shutdown began: spawning a harness now is one nothing will ever
          // stop, so it is dropped rather than run.
          if (stopped) return;
          const adapter = adapters.find((one) => one.providerId === frame.providerId);
          if (adapter === undefined) {
            return yield* died(frame.sessionId, noAdapterFor(frame.providerId));
          }
          // The adapter is asked, never this table: a start for a session it
          // still holds is one the controller re-issued after a reconnect,
          // which spec 03 section 2.3 makes a no-op rather than an error.
          const held = yield* adapter.listSessions;
          if (held.some((binding) => binding.sessionId === frame.sessionId)) return;
          // An exit published while the socket was down reached no relay, so
          // an entry here can outlive its session. Stale, not worth keeping.
          const stale = live.get(frame.sessionId);
          if (stale !== undefined) {
            live.delete(frame.sessionId);
            yield* teardown(stale);
          }
          return yield* starting(frame, adapter);
        }),

      /**
       * Delivered or reported lost, never queued: queued input is the
       * controller's (spec 06 section 5). The answer carries what the adapter
       * said the input did, because that is the only authority on it, and the
       * controller is waiting on this frame under the row's own id.
       */
      input: (frame: SessionInput): Effect.Effect<void> => {
        const answer = (result: Omit<SessionInputResult, "_tag" | "requestId">) =>
          sending({ _tag: "sessionInputResult", requestId: frame.requestId, ...result });
        // Both: the caller waiting on the answer needs the reason, and the
        // session's own stream is where a reader of the thread sees it.
        const refuse = (message: string): Effect.Effect<void> =>
          Effect.flatMap(failed(frame.sessionId, message), () =>
            answer({ ok: false, message: message.slice(0, MAX_MESSAGE_LENGTH) }),
          );
        const held = live.get(frame.sessionId);
        if (held === undefined) {
          return refuse(`session ${frame.sessionId} is not running on this runner`);
        }
        return held.adapter.sendInput(frame.sessionId, frame.input).pipe(
          Effect.flatMap((sent) => answer({ ok: true, delivery: sent.delivery })),
          Effect.catch(refuse),
          Effect.catchCause((cause) => refuse(wentWrong(cause, MAX_MESSAGE_LENGTH))),
        );
      },

      /** Idempotent: a session this runner does not hold has no turn to end. */
      interrupt: (frame: SessionInterrupt): Effect.Effect<void> =>
        live.get(frame.sessionId)?.adapter.interrupt(frame.sessionId) ?? Effect.void,

      /** Idempotent: a session this runner does not hold is already stopped. */
      stop: (frame: SessionStop): Effect.Effect<void> =>
        live.get(frame.sessionId)?.adapter.stopSession(frame.sessionId, "stopped") ?? Effect.void,
    };
  };

  const shutdown = (reason: ExitReason): Effect.Effect<void> =>
    Effect.gen(function* () {
      stopped = true;
      const ids = [...live.keys()];
      if (ids.length === 0) return;
      const waits = ids.map((id) => {
        const deferred = Deferred.makeUnsafe<void>();
        stopping.set(id, deferred);
        return deferred;
      });
      yield* Effect.forEach(
        ids,
        (id) => live.get(id)?.adapter.stopSession(id, reason) ?? Effect.void,
        { concurrency: "unbounded", discard: true },
      );
      yield* Effect.race(
        Effect.forEach(waits, Deferred.await, { concurrency: "unbounded", discard: true }),
        Effect.sleep(SHUTDOWN_STOP_BOUND),
      );
      // Whatever the race decided: a resolved one is already gone from here,
      // and one that never came is not worth waiting on again, by this call
      // or the next.
      for (const id of ids) stopping.delete(id);
    });

  return Object.assign(builder, { shutdown });
};
