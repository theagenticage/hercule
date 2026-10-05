/**
 * The runner's session supervisor. It tracks the sessions this machine hosts,
 * and it is the only place that gives an outgoing normalized event its
 * sequence number.
 *
 * The session table and the sequence counter belong to the supervisor, not to
 * a connection. A session outlives the socket that started it, and the
 * controller uses the sequence number to recognise events it already has, so
 * restarting the count on a reconnect would make the controller drop events it
 * has never seen. There is no disk-backed outbox yet to replay events after a
 * reconnect either, so an event produced while the socket is down is lost
 * (spec 03 section 2.3).
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
  lintOutputSchema,
  type ExitReason,
  type ProviderEvent,
  type RunnerToController,
  type SessionInput,
  type SessionInputResult,
  type SessionInterrupt,
  type SessionRespondToApprovalRequest,
  type SessionRespondToQuestion,
  type SessionStart,
  type SessionStop,
  type WorkspaceStepKey,
} from "@hercule/protocol";
import { describeMissingAdapter, type ProviderAdapter } from "../providers";
import { now, describeCause } from "../report";
import type { WorkspaceSteps } from "../workspace-steps";
import { resolveSessionContext, type Machine } from "./context";
import { buildAgentStepOutcome, type StepTurnEnding } from "./step-outcome";

/**
 * The agent step whose turn runs in a session: from the input that carried
 * the step's key until the turn ends or the session exits.
 */
interface RunningStep {
  readonly key: WorkspaceStepKey;
  /**
   * The id of the step's turn, set once the adapter has said which turn the
   * input went to. Until then, the next turn to end is taken as the step's.
   * The controller delivers a step's input only to a session with no open
   * turn, so no other turn can end in between.
   */
  turnId: string | undefined;
  /**
   * The assistant text written since the step's input, by item, in the order
   * each item's first text arrived. The last item of the step's turn is the
   * turn's final message, which is how the controller reads it too.
   */
  readonly texts: Map<string, { readonly turnId: string; text: string }>;
}

/** Checks whether a turn that ended is the step's turn. */
const isStepTurn = (step: RunningStep, turnId: string): boolean =>
  step.turnId === undefined || step.turnId === turnId;

/** Returns the final assistant message of one turn, or an empty string when it wrote none. */
const readFinalText = (step: RunningStep, turnId: string): string =>
  [...step.texts.values()].filter((item) => item.turnId === turnId).at(-1)?.text ?? "";

/**
 * A session this runner holds. The binding is not stored here, because the
 * adapters are the source of truth for what they host (spec 03 section 2.2).
 */
interface Live {
  readonly adapter: ProviderAdapter;
  readonly scratch: string | undefined;
  /** The workspace this session works in. It is read again and reported when the session exits. */
  readonly workspaceId: string | null;
  /** How long this session may sit with no event while a turn is open. */
  readonly inactivityMs: number;
  /** Clock time of the last event of this session while a turn was open. */
  lastEventAt: number;
  /**
   * The fiber that stops the session once `inactivityMs` has passed since
   * `lastEventAt`. Undefined while the session is not watched.
   */
  inactivity: Fiber.Fiber<void> | undefined;
  /** Whether a turn is open. Between turns the harness is idle, so it cannot be stuck. */
  turnOpen: boolean;
  /**
   * Whether the session is parked on an open request. A session waiting for
   * its user is not stuck, however long it waits, so it is not watched. This is
   * a flag rather than a count because a session has at most one open request.
   */
  parked: boolean;
  /**
   * The fiber that stops the session at its spec's absolute deadline. It is
   * interrupted when this entry is torn down. Undefined before the fiber is
   * forked and after it has fired.
   */
  absolute: Fiber.Fiber<void> | undefined;
  /**
   * How long this session may sit between turns before it is stopped with
   * `idle_unload`. Undefined when its spec sets no limit, and then the session
   * is never stopped for being idle.
   */
  readonly idleMs: number | undefined;
  /**
   * The fiber that stops the session once it has sat `idleMs` with no open
   * turn. It is forked when the session starts and when a turn completes, and
   * interrupted by the next input, turn or open request. Undefined whenever
   * no such wait is running.
   */
  idle: Fiber.Fiber<void> | undefined;
  /**
   * Whether the adapter has started this session yet. A stop requested while
   * the session is still `starting` cannot go to the adapter, which does not
   * hold the session yet, so it waits in `pendingStop` instead.
   */
  phase: "starting" | "running";
  /** The reason of the first stop requested while starting. It is applied once the session is running. */
  pendingStop: ExitReason | undefined;
  /** Whether the session runs under an output schema, so an agent step's turn must return a structured result. */
  readonly hasOutputSchema: boolean;
  /** The agent step whose turn runs in this session now, if any. */
  step: RunningStep | undefined;
}

/** What a connection gives the supervisor while the connection is up. */
export interface Connection {
  readonly machine: Machine;
  /**
   * The workspace steps of this process. The supervisor tells them when an
   * agent step's turn begins and how it ended.
   */
  readonly workspaceSteps: Pick<
    WorkspaceSteps,
    "beginAgentStep" | "finishAgentStep" | "forgetAgentStep"
  >;
  /**
   * The error type is left to the transport. A failed write means the
   * connection is closing, and there is nowhere left to report the failure.
   */
  readonly send: (frame: RunnerToController) => Effect.Effect<void, unknown>;
}

export interface SessionSupervisor {
  /**
   * Numbers every adapter's events and sends them, until the connection ends.
   * Run it in a forked fiber, because it never returns.
   */
  readonly relay: Effect.Effect<void>;
  /** Sends a `sessionsReport` of what the adapters host. The controller reconciles its own state against it. */
  readonly report: Effect.Effect<void>;
  readonly start: (frame: SessionStart) => Effect.Effect<void>;
  readonly input: (frame: SessionInput) => Effect.Effect<void>;
  readonly interrupt: (frame: SessionInterrupt) => Effect.Effect<void>;
  readonly respondToApprovalRequest: (
    frame: SessionRespondToApprovalRequest,
  ) => Effect.Effect<void>;
  readonly respondToQuestion: (frame: SessionRespondToQuestion) => Effect.Effect<void>;
  readonly stop: (frame: SessionStop) => Effect.Effect<void>;
}

/**
 * What `makeSupervising` returns: a way to build a `SessionSupervisor` for
 * each connection, and the shutdown for the whole process. Sessions outlive the
 * socket that started them, and the shutdown stops every session, so neither
 * belongs to one connection's `SessionSupervisor`.
 */
export interface Supervising {
  readonly forConnection: (connection: Connection) => SessionSupervisor;
  /**
   * Stops every session this runner holds, and waits until the relay of
   * whichever connection is up has sent each session's `session.exited`. The
   * wait has a time limit, so a harness that will not exit cannot hold up the
   * caller forever. New starts are blocked first, so no harness is spawned
   * after the runner says goodbye to the controller.
   */
  readonly shutdown: (reason: ExitReason) => Effect.Effect<void>;
}

/**
 * How long a shutdown waits for harnesses to confirm they stopped. Long enough
 * for a normal exit, and short enough that a stuck harness does not delay the
 * goodbye noticeably.
 */
const SHUTDOWN_STOP_BOUND: Duration.Duration = Duration.seconds(5);

/**
 * Creates the session supervisor. Call it once per process: the session table
 * and the sequence counter it holds belong to the process, not to a connection.
 */
export const makeSupervising = (adapters: ReadonlyArray<ProviderAdapter>): Supervising => {
  const live = new Map<string, Live>();
  let lastSeq = 0;
  /**
   * One deferred per session that `shutdown` is waiting on. It is resolved
   * once `sendSequenced` has sent the session's `session.exited`, not when
   * `releaseSession` runs: `releaseSession` runs before the send, so resolving
   * there would let the wait end before the frame was on the socket.
   */
  const stopping = new Map<string, Deferred.Deferred<void>>();
  // Assigning a sequence number and sending the frame happen under one lock.
  // Both the relay and the handling of a controller frame send events, and the
  // controller may never insert an event whose number reached it out of order.
  const sequencing = Semaphore.makeUnsafe(1);
  // Set by `shutdown`. The process is shutting down, so a start the controller
  // sent before it learned of that would spawn a harness nothing ever stops.
  let stopped = false;

  /**
   * Asks the adapter to stop a session. Every stop goes through here:
   *
   * - a running session is stopped directly;
   * - a starting session is not held by the adapter yet, so the reason is
   *   saved in `pendingStop`, and `startSession` applies it once the harness
   *   is up.
   *
   * The first reason wins, as it would if two stops reached the adapter.
   */
  const requestStop = (sessionId: string, held: Live, reason: ExitReason): Effect.Effect<void> => {
    if (held.phase === "running") return held.adapter.stopSession(sessionId, reason);
    if (held.pendingStop === undefined) held.pendingStop = reason;
    return Effect.void;
  };

  const forConnection = (connection: Connection): SessionSupervisor => {
    const discardScratch = (scratch: string | undefined): void => {
      if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
    };

    /**
     * Sends a frame and ignores any failure, not only a failed write. A frame
     * that fails to encode then loses one event instead of ending the relay,
     * which would silently drop every session's events for the rest of the
     * connection.
     */
    const sendFrame = (frame: RunnerToController): Effect.Effect<void> =>
      Effect.ignoreCause(Effect.suspend(() => connection.send(frame)));

    /** Interrupts every timer fiber of a session entry and removes its scratch directory. */
    const tearDownSession = (held: Live): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (held.inactivity !== undefined) yield* Fiber.interrupt(held.inactivity);
        if (held.absolute !== undefined) yield* Fiber.interrupt(held.absolute);
        yield* cancelIdleUnload(held);
        discardScratch(held.scratch);
      });

    /**
     * Removes an exited session's entry, but only when the adapter no longer
     * holds the session. The exit event alone is not enough: if the same
     * session id was started again while the old exit was on its way, the
     * entry belongs to the new session and must stay.
     */
    const releaseSession = (sessionId: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const held = live.get(sessionId);
        if (held === undefined) return;
        const bindings = yield* held.adapter.listSessions;
        if (bindings.some((binding) => binding.sessionId === sessionId)) return;
        // Compare by identity again after the wait above. A new start for this
        // id may have replaced the entry while this call waited on the
        // adapter, before the adapter registered the new session, so `bindings`
        // only describes the session this exit belongs to.
        if (live.get(sessionId) !== held) return;
        live.delete(sessionId);
        yield* tearDownSession(held);
      });

    /**
     * Stops the session with `inactivity_timeout` once `inactivityMs` passes
     * with no event. It runs in one fiber while the session is watched. It
     * sleeps until `lastEventAt + inactivityMs` and then checks again, because
     * an event during the sleep only moves `lastEventAt` and does not wake the
     * fiber.
     */
    const watchInactivity = (held: Live, sessionId: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        while (true) {
          const remaining = held.lastEventAt + held.inactivityMs - (yield* Clock.currentTimeMillis);
          if (remaining > 0) {
            yield* Effect.sleep(Duration.millis(remaining));
            continue;
          }
          held.inactivity = undefined;
          // Compare by identity: by the time the deadline passes, the entry
          // for this id may have been removed or replaced by a new start.
          if (live.get(sessionId) === held) {
            yield* requestStop(sessionId, held, "inactivity_timeout");
          }
          return;
        }
      });

    /**
     * Starts the wait that stops an idle session with `idle_unload` after
     * `idleMs`. It is called whenever the session is left with no open turn:
     *
     * - when the session starts, because a session resumed to take queued
     *   input may start before the input reaches it, and may never get it;
     * - when a turn completes;
     * - when the harness refuses input to a session with no open turn.
     *
     * Does nothing when the spec sets no `idleMs`, when a wait is already
     * running, or when the entry was torn down, since a wait armed on a torn
     * down entry would never be interrupted.
     */
    const armIdleUnload = (held: Live, sessionId: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const idleMs = held.idleMs;
        if (idleMs === undefined || held.idle !== undefined) return;
        if (live.get(sessionId) !== held) return;
        held.idle = yield* Effect.forkDetach(
          Effect.andThen(
            Effect.sleep(Duration.millis(idleMs)),
            Effect.suspend(() => {
              held.idle = undefined;
              // Compare by identity: by the time the wait ends, the entry for
              // this id may have been removed or replaced by a new start.
              if (live.get(sessionId) !== held) return Effect.void;
              return requestStop(sessionId, held, "idle_unload");
            }),
          ),
        );
      });

    /**
     * Interrupts the idle wait of a session, if one is running. New input or a
     * new turn means the session is in use again, so it must not be unloaded.
     */
    const cancelIdleUnload = (held: Live): Effect.Effect<void> =>
      Effect.suspend(() => {
        const fiber = held.idle;
        if (fiber === undefined) return Effect.void;
        held.idle = undefined;
        return Fiber.interrupt(fiber);
      });

    /**
     * Reads a primary workspace's branches again and sends the result to the
     * controller. A session in a primary workspace may switch branches, and
     * this report is how the controller learns about it.
     */
    const reportWorkspace = (workspaceId: string): Effect.Effect<void> =>
      Effect.ignoreCause(
        Effect.flatMap(
          Effect.promise(() => connection.machine.workspaces.reportAfterSession(workspaceId)),
          (report) => (report === undefined ? Effect.void : sendFrame(report)),
        ),
      );

    /**
     * Ends the session's agent step with the outcome of the event that ended
     * its turn: saves the outcome, then sends it. The caller sends that event
     * afterwards, so the controller has the step's result before it sees the
     * session exit, and so never has to guess the step's end from the exit.
     */
    const finishStepTurn = (held: Live, step: RunningStep, ending: StepTurnEnding) =>
      Effect.suspend(() => {
        held.step = undefined;
        const text = ending._tag === "turn.completed" ? readFinalText(step, ending.turnId) : "";
        const outcome = buildAgentStepOutcome(ending, {
          hasOutputSchema: held.hasOutputSchema,
          text,
        });
        return connection.workspaceSteps.finishAgentStep(step.key, outcome);
      });

    /**
     * Numbers an event and sends it. Every event goes out through here, in
     * sequence order. The inactivity clock is updated before the send, so
     * anyone who has seen the frame knows the clock already reflects the
     * event.
     */
    const sendSequenced = (event: ProviderEvent): Effect.Effect<void> =>
      sequencing.withPermits(1)(
        Effect.gen(function* () {
          const held = live.get(event.sessionId);
          if (held !== undefined) {
            switch (event._tag) {
              case "session.started":
                if (!held.turnOpen && !held.parked) yield* armIdleUnload(held, event.sessionId);
                break;
              case "turn.started":
                held.turnOpen = true;
                // A turn the harness opened on its own also ends the idle
                // wait, not only an input frame.
                yield* cancelIdleUnload(held);
                break;
              case "turn.completed":
                held.turnOpen = false;
                // A request cannot outlive its turn. The controller also clears
                // it on this event, and a `parked` flag left set here would
                // stop every later turn from being watched.
                held.parked = false;
                yield* armIdleUnload(held, event.sessionId);
                if (held.step !== undefined && isStepTurn(held.step, event.turnId)) {
                  yield* finishStepTurn(held, held.step, event);
                }
                break;
              case "content.delta": {
                const step = held.step;
                if (step === undefined || event.streamKind !== "assistant_text") break;
                const item = step.texts.get(event.itemId);
                if (item === undefined) {
                  step.texts.set(event.itemId, { turnId: event.turnId, text: event.delta });
                } else {
                  item.text += event.delta;
                }
                break;
              }
              case "session.exited": {
                // Every exit the relay sees passes through here, whatever
                // ended the session: the harness itself, a stop by the
                // controller, a timeout or the runner's shutdown.
                const step = held.step;
                if (step === undefined) break;
                // The exit of an earlier run under the same id must not end
                // the step of the run that replaced it. Only the adapter can
                // tell the two apart, as in `releaseSession`.
                const bindings = yield* held.adapter.listSessions;
                if (bindings.some((binding) => binding.sessionId === event.sessionId)) break;
                yield* finishStepTurn(held, step, event);
                break;
              }
              case "request.opened":
                held.parked = true;
                // A session waiting on its user is in use, however long the
                // user takes to answer.
                yield* cancelIdleUnload(held);
                break;
              case "request.resolved":
                held.parked = false;
                break;
              default:
                break;
            }
            // A session is watched exactly while a turn is open and it is not
            // waiting on its user. The watch is brought in line with the two
            // flags after every event, instead of being started and stopped in
            // each case above, so a fiber from an earlier state can never be
            // left behind to stop a session that is not stuck.
            if (held.turnOpen && !held.parked) {
              held.lastEventAt = yield* Clock.currentTimeMillis;
              if (held.inactivity === undefined) {
                held.inactivity = yield* Effect.forkDetach(watchInactivity(held, event.sessionId));
              }
            } else if (held.inactivity !== undefined) {
              const fiber = held.inactivity;
              held.inactivity = undefined;
              yield* Fiber.interrupt(fiber);
            }
          }
          lastSeq += 1;
          const frame: RunnerToController = { _tag: "sessionEvent", seq: lastSeq, event };
          if (event._tag === "session.exited") yield* releaseSession(event.sessionId);
          yield* sendFrame(frame);
          // Resolve after the send, not before: when `shutdown` wakes up, the
          // frame must already be on the wire.
          if (event._tag === "session.exited") {
            const waiting = stopping.get(event.sessionId);
            if (waiting !== undefined) {
              stopping.delete(event.sessionId);
              yield* Deferred.succeed(waiting, undefined);
            }
          }
        }),
      );

    /**
     * Sends an event. After a `session.exited` of a session with a workspace,
     * it also reports the workspace. The report runs outside the sequence lock,
     * because reading a checkout calls git and every other session's events
     * would wait behind it. The workspace id is read before the exit is sent,
     * because sending the exit removes the entry.
     */
    const forwardEvent = (event: ProviderEvent): Effect.Effect<void> => {
      const workspaceId =
        event._tag === "session.exited" ? live.get(event.sessionId)?.workspaceId : undefined;
      return Effect.flatMap(sendSequenced(event), () =>
        workspaceId === undefined || workspaceId === null
          ? Effect.void
          : reportWorkspace(workspaceId),
      );
    };

    /** Sends a `runtime.error` on the session's own stream, where the user reading the thread sees it. */
    const reportFailure = (sessionId: string, message: string): Effect.Effect<void> =>
      forwardEvent({
        _tag: "runtime.error",
        eventId: crypto.randomUUID(),
        sessionId,
        at: now(),
        class: "unknown",
        // Truncate to the protocol's limit: a longer message would fail to
        // encode, and the event would be dropped.
        message: message.slice(0, MAX_MESSAGE_LENGTH),
      });

    /**
     * Reports a session that failed to start: sends the error, then a
     * `session.exited` with reason `crash`. The controller keeps the session in
     * `starting` until it receives an exit, and `crash` is the reason for an
     * end nobody asked for that leaves nothing to resume.
     */
    const reportDeath = (sessionId: string, message: string): Effect.Effect<void> =>
      Effect.flatMap(reportFailure(sessionId, message), () =>
        forwardEvent({
          _tag: "session.exited",
          eventId: crypto.randomUUID(),
          sessionId,
          at: now(),
          reason: "crash",
        }),
      );

    /**
     * Starts a session: resolves its context on this machine, then asks the
     * adapter for the harness. Never fails; a failure is reported as the
     * session's exit.
     *
     * The entry is added before the adapter is asked, and removed on any
     * failure, in one uninterruptible block. A session that exits while it is
     * still starting must find its entry, and a session that never came up
     * must leave no entry behind.
     */
    const startSession = (frame: SessionStart, adapter: ProviderAdapter): Effect.Effect<void> => {
      // The controller linted this schema before it sent the frame, and the
      // harness would hold every turn of the session to it. A schema outside
      // the subset means the controller and the runner disagree about which
      // schemas are allowed. Such a session must not start at all, because its
      // results could not be trusted.
      const issues =
        frame.spec.outputSchema === undefined ? [] : lintOutputSchema(frame.spec.outputSchema);
      if (issues.length > 0) {
        return reportDeath(
          frame.sessionId,
          `the output schema is outside the subset every harness accepts: ${issues.join("; ")}`,
        );
      }
      return resolveSessionContext(frame, connection.machine, adapter.binaryName).pipe(
        Effect.flatMap((resolved) =>
          Effect.asVoid(
            Effect.uninterruptible(
              Effect.gen(function* () {
                const held: Live = {
                  adapter,
                  scratch: resolved.scratch,
                  workspaceId: frame.spec.workspaceId,
                  inactivityMs: frame.spec.timeouts.inactivityMs,
                  // Not used until the session is watched: `sendSequenced`
                  // sets it together with `inactivity`, on the event that
                  // starts the watch.
                  lastEventAt: 0,
                  inactivity: undefined,
                  turnOpen: false,
                  parked: false,
                  absolute: undefined,
                  idleMs: frame.spec.timeouts.idleMs,
                  idle: undefined,
                  phase: "starting",
                  pendingStop: undefined,
                  hasOutputSchema: frame.spec.outputSchema !== undefined,
                  step: undefined,
                };
                live.set(frame.sessionId, held);
                // Check `stopped` again. A shutdown that began after `start`
                // checked it would not see this session, because
                // `listSessions` and `resolveSessionContext` both yield to
                // other fibers before this line. There is no point asking the
                // adapter for a harness that is about to be stopped.
                if (stopped) {
                  live.delete(frame.sessionId);
                  yield* tearDownSession(held);
                  return yield* forwardEvent({
                    _tag: "session.exited",
                    eventId: crypto.randomUUID(),
                    sessionId: frame.sessionId,
                    at: now(),
                    reason: "runner_restart",
                  });
                }
                // Start the absolute timer here, not on `session.started`:
                // the runner itself promises to end the session at the
                // deadline, whether or not the harness confirms it started.
                held.absolute = yield* Effect.forkDetach(
                  Effect.andThen(
                    Effect.sleep(Duration.millis(frame.spec.timeouts.absoluteMs)),
                    Effect.suspend(() => {
                      if (live.get(frame.sessionId) !== held) return Effect.void;
                      held.absolute = undefined;
                      return requestStop(frame.sessionId, held, "absolute_timeout");
                    }),
                  ),
                );
                const binding = yield* Effect.tapCause(
                  adapter.startSession(frame.sessionId, frame.spec, resolved.ctx),
                  () =>
                    Effect.gen(function* () {
                      // Compare by identity: if a later start has replaced
                      // the entry, it is not this start's to remove.
                      if (live.get(frame.sessionId) !== held) return;
                      live.delete(frame.sessionId);
                      yield* tearDownSession(held);
                    }),
                );
                // Compare by identity, as both timers do: if a later start
                // has replaced the entry, this start must not mark it running
                // or apply its own pending stop to it.
                if (live.get(frame.sessionId) === held) {
                  held.phase = "running";
                  // Apply a stop that was requested while the harness was
                  // still starting, by a shutdown, a timer or the controller.
                  if (held.pendingStop !== undefined) {
                    yield* requestStop(frame.sessionId, held, held.pendingStop);
                  }
                }
                return binding;
              }),
            ),
          ),
        ),
        Effect.catch((message) => reportDeath(frame.sessionId, message)),
        Effect.catchCause((cause) =>
          reportDeath(frame.sessionId, describeCause(cause, MAX_MESSAGE_LENGTH)),
        ),
      );
    };

    return {
      relay: Stream.runForEach(
        Stream.mergeAll(
          adapters.map((adapter) => adapter.events),
          { concurrency: "unbounded" },
        ),
        forwardEvent,
      ),

      // Ask the adapters each time the controller asks, instead of building
      // the list when the connection was made.
      report: Effect.flatMap(
        Effect.forEach(adapters, (adapter) => adapter.listSessions),
        (held) => sendFrame({ _tag: "sessionsReport", sessions: held.flat() }),
      ),

      start: (frame: SessionStart): Effect.Effect<void> =>
        Effect.gen(function* () {
          // The controller may have sent this start before it learned of the
          // shutdown. A harness spawned now would never be stopped, so the
          // start is dropped.
          if (stopped) return;
          const adapter = adapters.find((one) => one.providerId === frame.providerId);
          if (adapter === undefined) {
            return yield* reportDeath(frame.sessionId, describeMissingAdapter(frame.providerId));
          }
          // Ask the adapter, not the `live` table. A start for a session the
          // adapter still holds was sent again by the controller after a
          // reconnect, and is a no-op rather than an error
          // (spec 03 section 2.3).
          const held = yield* adapter.listSessions;
          if (held.some((binding) => binding.sessionId === frame.sessionId)) return;
          // An exit published while the socket was down reached no relay, so
          // the `live` entry can outlive its session. Remove such a stale
          // entry before starting again.
          const stale = live.get(frame.sessionId);
          if (stale !== undefined) {
            live.delete(frame.sessionId);
            yield* tearDownSession(stale);
          }
          return yield* startSession(frame, adapter);
        }),

      /**
       * Delivers input to the session, or reports that it could not. The runner
       * never queues input; queuing is the controller's job
       * (spec 06 section 5). The `sessionInputResult` carries the adapter's report of what the
       * input did, because only the adapter knows. The controller waits for it
       * under the Queued Input row's id, `requestId`.
       *
       * An input that carries a step key also begins that agent step. How the
       * turn the input went to ends becomes the step's result, which is saved
       * and sent before the event that ended the turn.
       *
       * A step input this runner has seen before never reaches the harness.
       * The controller sends a step's input again when it lost the answer to
       * the first one, and a second turn could push or comment a second time.
       * Such an input is answered `ok` with delivery `steered`: the controller
       * records the input as delivered and changes nothing else, because the
       * step's turn already opened, or the step is already over. Before that
       * answer, `beginAgentStep` sends whatever the step itself is owed, such
       * as its saved result.
       */
      input: (frame: SessionInput): Effect.Effect<void> => {
        const sendInputResult = (result: Omit<SessionInputResult, "_tag" | "requestId">) =>
          sendFrame({ _tag: "sessionInputResult", requestId: frame.requestId, ...result });
        // Report the failure in both places: the controller waiting on the
        // result needs the reason, and the user reading the thread sees the
        // session's stream.
        const refuseInput = (message: string): Effect.Effect<void> =>
          Effect.flatMap(reportFailure(frame.sessionId, message), () =>
            sendInputResult({ ok: false, message: message.slice(0, MAX_MESSAGE_LENGTH) }),
          );
        const held = live.get(frame.sessionId);
        if (held === undefined) {
          return refuseInput(`session ${frame.sessionId} is not running on this runner`);
        }
        const stepKey = frame.input.step;
        const step: RunningStep | undefined =
          stepKey === undefined ? undefined : { key: stepKey, turnId: undefined, texts: new Map() };
        // Recorded before the input reaches the harness, so the turn cannot
        // end before its step is known. The session's running step is set
        // only once the workspace steps have begun the step: a step input
        // sent again must leave the step whose turn runs in place.
        const beginStep: Effect.Effect<"begun" | "repeated"> =
          step === undefined
            ? Effect.succeed("begun")
            : Effect.tap(
                connection.workspaceSteps.beginAgentStep(
                  step.key,
                  held.workspaceId,
                  Effect.map(
                    held.adapter.listSessions,
                    (bindings) =>
                      live.get(frame.sessionId) === held &&
                      held.step === step &&
                      bindings.some((binding) => binding.sessionId === frame.sessionId),
                  ),
                ),
                (begun) =>
                  Effect.sync(() => {
                    if (begun === "begun") held.step = step;
                  }),
              );
        // Input the harness refused opens no turn, so a session that was idle
        // before it is still idle and gets its wait back. A refused step input
        // sends no step result: the controller delivers the input again.
        const refuseHeldInput = (message: string): Effect.Effect<void> =>
          Effect.andThen(
            refuseInput(message),
            Effect.suspend(() => {
              if (step !== undefined && held.step === step) {
                held.step = undefined;
                connection.workspaceSteps.forgetAgentStep(step.key);
              }
              return held.turnOpen || held.parked
                ? Effect.void
                : armIdleUnload(held, frame.sessionId);
            }),
          );
        // Cancel the idle wait before the input reaches the harness. The turn
        // this input opens may start only after the wait would have ended.
        const deliverInput = Effect.andThen(
          cancelIdleUnload(held),
          held.adapter.sendInput(frame.sessionId, frame.input),
        ).pipe(
          Effect.tap((sent) =>
            Effect.sync(() => {
              // Unless the turn has already ended and finished the step.
              if (step !== undefined && held.step === step) step.turnId = sent.turnId;
            }),
          ),
          Effect.flatMap((sent) => sendInputResult({ ok: true, delivery: sent.delivery })),
          Effect.catch(refuseHeldInput),
          Effect.catchCause((cause) => refuseHeldInput(describeCause(cause, MAX_MESSAGE_LENGTH))),
        );
        // A repeated step input opens no turn, so the idle wait is left as it is.
        return Effect.flatMap(beginStep, (begun) =>
          begun === "repeated" ? sendInputResult({ ok: true, delivery: "steered" }) : deliverInput,
        );
      },

      /** Idempotent: a session this runner does not hold has no turn to end. */
      interrupt: (frame: SessionInterrupt): Effect.Effect<void> =>
        live.get(frame.sessionId)?.adapter.interrupt(frame.sessionId) ?? Effect.void,

      /**
       * Passes the user's decision on an open approval to the adapter.
       * Idempotent: the adapter ignores a request it does not hold, because it
       * was already answered or never opened here. The outcome arrives as an
       * event on the session's stream, not as a reply to this frame.
       */
      respondToApprovalRequest: (frame: SessionRespondToApprovalRequest): Effect.Effect<void> =>
        live
          .get(frame.sessionId)
          ?.adapter.respondToApprovalRequest(frame.sessionId, frame.requestId, frame.decision) ??
        Effect.void,

      /**
       * Passes the user's answers to an open question to the adapter, with the
       * same idempotence and the same report as `respondToApprovalRequest`.
       */
      respondToQuestion: (frame: SessionRespondToQuestion): Effect.Effect<void> =>
        live
          .get(frame.sessionId)
          ?.adapter.respondToQuestion(frame.sessionId, frame.requestId, frame.answers) ??
        Effect.void,

      /** Idempotent: a session this runner does not hold is already stopped. */
      stop: (frame: SessionStop): Effect.Effect<void> => {
        const held = live.get(frame.sessionId);
        return held === undefined ? Effect.void : requestStop(frame.sessionId, held, "stopped");
      },
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
        (id) => {
          const held = live.get(id);
          return held === undefined ? Effect.void : requestStop(id, held, reason);
        },
        { concurrency: "unbounded", discard: true },
      );
      yield* Effect.race(
        Effect.forEach(waits, Deferred.await, { concurrency: "unbounded", discard: true }),
        Effect.sleep(SHUTDOWN_STOP_BOUND),
      );
      // Clear the entries however the race ended. A resolved entry is already
      // gone, and an exit that never came is not worth waiting for again, by
      // this call or a later one.
      for (const id of ids) stopping.delete(id);
    });

  return { forConnection, shutdown };
};
