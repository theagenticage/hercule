/**
 * The runner's session supervisor: what this machine is hosting, and the one
 * place a normalized event gets its sequence number on the way out.
 *
 * The table and the sequence are the supervisor's, not a connection's: a
 * session outlives the socket that started it, and the sequence is the
 * controller's idempotency key, so restarting it on a reconnect would make the
 * controller drop events it has never seen (spec 03 section 2.3).
 *
 * There is no outbox yet: an event produced while the socket is down is lost,
 * which is the deferral spec 03 section 2.3 states.
 */
import { rmSync } from "node:fs";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import {
  MAX_MESSAGE_LENGTH,
  type ProviderEvent,
  type RunnerToController,
  type SessionInput,
  type SessionStart,
  type SessionStop,
} from "@hydra/protocol";
import { noAdapterFor, type ProviderAdapter } from "../providers";
import { resolve, type Machine } from "./context";

/**
 * One session this runner holds. The binding is not here: the adapters are the
 * authority on what they are hosting, and a second register of the same fact
 * would be one that can disagree with them (spec 03 section 2.2).
 */
interface Live {
  readonly adapter: ProviderAdapter;
  /** Removed when the session exits; absent for a session with a workspace. */
  readonly scratch: string | undefined;
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
  readonly stop: (frame: SessionStop) => Effect.Effect<void>;
}

const now = (): string => new Date().toISOString();

/**
 * What went wrong, in one line. A defect must reach the controller as an error
 * on the session, or it would hold the session in `starting` for good.
 */
const wentWrong = (cause: Cause.Cause<unknown>): string =>
  (Cause.pretty(cause).split("\n")[0] ?? "").slice(0, MAX_MESSAGE_LENGTH) ||
  "the runner could not answer";

/**
 * The adapters this runner build carries, once, so the state below is the
 * process's rather than a connection's.
 */
export const supervising = (adapters: ReadonlyArray<ProviderAdapter>) => {
  const live = new Map<string, Live>();
  let lastSeq = 0;
  // Assigning a number and writing it are one step, on whichever fiber gets
  // here first: the relay and a frame being answered both emit, and a sequence
  // that reached the wire out of order is one the controller may never insert.
  const sequencing = Semaphore.makeUnsafe(1);

  return (connection: Connection): SessionSupervisor => {
    const discard = (scratch: string | undefined): void => {
      if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
    };

    /**
     * On any cause, not only a failed write: the connection is going if the
     * write failed and there is nowhere left to report that to, and a frame
     * that will not encode is one event lost rather than the whole relay - a
     * dead relay drops every session's traffic for the life of the connection,
     * and nobody joins it to find out.
     */
    const sending = (frame: RunnerToController): Effect.Effect<void> =>
      Effect.ignoreCause(Effect.suspend(() => connection.send(frame)));

    /**
     * Forgets an exited session, on the adapter's authority rather than on the
     * event's. A session id started again while its old exit was still on its
     * way through here is a different session, holding the same scratch
     * directory, and the old run's exit must not take it from it.
     */
    const release = (sessionId: string): Effect.Effect<void> =>
      Effect.suspend(() => {
        const held = live.get(sessionId);
        if (held === undefined) return Effect.void;
        return Effect.map(held.adapter.listSessions, (still) => {
          if (still.some((binding) => binding.sessionId === sessionId)) return;
          live.delete(sessionId);
          discard(held.scratch);
        });
      });

    /** Every event leaves through here, in the order it was sequenced. */
    const forward = (event: ProviderEvent): Effect.Effect<void> =>
      sequencing.withPermits(1)(
        Effect.suspend(() => {
          lastSeq += 1;
          const frame: RunnerToController = { _tag: "sessionEvent", seq: lastSeq, event };
          return event._tag === "session.exited"
            ? Effect.flatMap(release(event.sessionId), () => sending(frame))
            : sending(frame);
        }),
      );

    /** What went wrong, in the session's own stream: the controller waits on nothing else. */
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

    /** One start, from the paths it resolves to the harness it asks for. */
    const starting = (frame: SessionStart, adapter: ProviderAdapter): Effect.Effect<void> =>
      resolve(frame, connection.machine, adapter.binaryName).pipe(
        Effect.flatMap((resolved) =>
          Effect.asVoid(
            // Uninterruptible around both, so the entry is never set without
            // the cleanup that removes it: an interrupt between the two would
            // leave a session nothing holds and a directory nothing sweeps.
            Effect.uninterruptible(
              Effect.suspend(() => {
                const held: Live = { adapter, scratch: resolved.scratch };
                // Held before the harness is asked for, not after: a session
                // that exits while it is still starting must find its own entry
                // to remove, or it and its directory outlive the session.
                live.set(frame.sessionId, held);
                return Effect.tapCause(
                  // On any cause, not just the declared one: a harness that
                  // threw where nothing said it could must not leave the entry
                  // behind, or every later start for it looks like a duplicate.
                  adapter.startSession(frame.sessionId, frame.spec, resolved.ctx),
                  () =>
                    Effect.sync(() => {
                      // By identity: a start after this one owns what is there
                      // now, and this one has nothing left to take away.
                      if (live.get(frame.sessionId) !== held) return;
                      live.delete(frame.sessionId);
                      // A harness that never came up leaves nothing on disk.
                      discard(resolved.scratch);
                    }),
                );
              }),
            ),
          ),
        ),
        Effect.catch((message) => died(frame.sessionId, message)),
        Effect.catchCause((cause) => died(frame.sessionId, wentWrong(cause))),
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
      // connection was made: they are the authority on what they are hosting.
      report: Effect.flatMap(
        Effect.forEach(adapters, (adapter) => adapter.listSessions),
        (held) => sending({ _tag: "sessionsReport", sessions: held.flat() }),
      ),

      start: (frame: SessionStart): Effect.Effect<void> =>
        Effect.gen(function* () {
          const holding = live.get(frame.sessionId);
          if (holding !== undefined) {
            // Idempotent, because the controller re-issues a command it cannot
            // account for (spec 03 section 2.3) - and starting a session twice
            // would take the running one's working directory away from it. The
            // adapter is asked rather than believed: an exit published while the
            // socket was down reached no relay, so an entry can outlive its
            // session, and a start that is really a fresh one must not be
            // mistaken for that.
            const held = yield* holding.adapter.listSessions;
            if (held.some((binding) => binding.sessionId === frame.sessionId)) return;
            live.delete(frame.sessionId);
            discard(holding.scratch);
          }
          const adapter = adapters.find((one) => one.providerId === frame.providerId);
          if (adapter === undefined) {
            return yield* died(frame.sessionId, noAdapterFor(frame.providerId));
          }
          return yield* starting(frame, adapter);
        }),

      /**
       * Input is delivered unconditionally or reported lost; it is never
       * queued here, because queued input is controller-owned domain state
       * (spec 06 section 5).
       */
      input: (frame: SessionInput): Effect.Effect<void> => {
        const held = live.get(frame.sessionId);
        if (held === undefined) {
          return failed(
            frame.sessionId,
            `session ${frame.sessionId} is not running on this runner`,
          );
        }
        return held.adapter.sendInput(frame.sessionId, frame.input).pipe(
          Effect.asVoid,
          Effect.catch((message) => failed(frame.sessionId, message)),
          Effect.catchCause((cause) => failed(frame.sessionId, wentWrong(cause))),
        );
      },

      /** Idempotent, like every command that crosses a reconnect: a session this
       * runner does not hold is already stopped, and its exit was already sent. */
      stop: (frame: SessionStop): Effect.Effect<void> =>
        live.get(frame.sessionId)?.adapter.stopSession(frame.sessionId) ?? Effect.void,
    };
  };
};
