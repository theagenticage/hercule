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
import * as Cause from "effect/Cause";
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
import { resolveSessionContext, type Machine, type Resolved } from "./context";
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

/**
 * Why the runner refuses the input of an agent step the controller has
 * already settled. A turn of a run that has ended could still push or
 * comment, so the input never reaches the harness.
 */
const SETTLED_STEP_REFUSAL =
  "the step ended before its prompt reached the harness, so the prompt was not run";

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
   * turn. It is forked when a turn completes and when the harness refuses
   * input while no turn is open, and interrupted by the next input, turn or
   * open request. Undefined whenever no such wait is running.
   */
  idle: Fiber.Fiber<void> | undefined;
  /**
   * Whether the session's start has handed its input to the harness yet. A
   * stop requested while the session is still `starting` does not go to the
   * adapter: the start applies it, and refuses its input, at the moment it
   * would have handed the input over.
   */
  phase: "starting" | "running";
  /**
   * The reason of the first stop requested for this session, or undefined
   * while none was. While the session is `starting`, the start applies it once
   * the harness is up. While it is `running`, each stop goes straight to the
   * adapter, and the reason is kept so a session on its way out never gets
   * its idle wait back. A stop that arrived before this entry existed is
   * carried over from the start's `ArrivedStart`.
   */
  pendingStop: ExitReason | undefined;
  /**
   * Completed when this entry is removed, which happens only once the adapter
   * no longer holds the session or never started it. A start of the same id
   * that arrives while this session is being stopped waits on it, instead of
   * being refused because the old harness is still on its way out.
   */
  readonly gone: Deferred.Deferred<void>;
  /** Whether the session runs under an output schema, so an agent step's turn must return a structured result. */
  readonly hasOutputSchema: boolean;
  /** The agent step whose turn runs in this session now, if any. */
  step: RunningStep | undefined;
}

/**
 * A start that has arrived on the connection and has not asked the adapter
 * for its harness yet: it may still wait behind earlier frames of its session,
 * check the adapter, or resolve its context. The session has no `live` entry
 * in that time, so a stop that arrives then is kept here.
 *
 * - A stop kept here before the start resolves its context means no harness
 *   is spawned: the start refuses its input and reports the exit itself, with
 *   reason `stopped`. The controller has moved the session to `starting`, and
 *   it ends the session only when a `session.exited` arrives.
 * - A stop that arrives after that check moves to the entry's `pendingStop`
 *   when the entry is added, and the start stops the harness once it is up.
 */
interface ArrivedStart {
  readonly sessionId: string;
  /** The reason of the first stop that arrived for this session since the start arrived. */
  pendingStop: ExitReason | undefined;
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
  /**
   * Records that the start has arrived, at once, and returns the effect that
   * starts or resumes the session and hands its harness the input the frame
   * carries. The effect never fails, and answers that input exactly once.
   *
   * The record is made when this function is called, not when the effect
   * runs, so call it as soon as the frame arrives. A stop that arrives later
   * is then never lost, even while the start still waits its turn: the input
   * is refused and the session is stopped.
   *
   * When an earlier session of the same id is being stopped, the effect first
   * waits until that session is gone from this runner, for at most
   * `STOP_WAIT_BOUND`, and refuses the input if the adapter still holds it
   * by then.
   */
  readonly start: (frame: SessionStart) => Effect.Effect<void>;
  readonly input: (frame: SessionInput) => Effect.Effect<void>;
  readonly interrupt: (frame: SessionInterrupt) => Effect.Effect<void>;
  readonly respondToApprovalRequest: (
    frame: SessionRespondToApprovalRequest,
  ) => Effect.Effect<void>;
  readonly respondToQuestion: (frame: SessionRespondToQuestion) => Effect.Effect<void>;
  /**
   * Records the stop at once, when called, and returns the effect that asks
   * the adapter to stop the session, if it is running. The input a start of
   * the session carries is refused if that start has not handed it over yet:
   *
   * - a start that has not resolved its context yet spawns no harness, and
   *   reports the exit itself;
   * - a start whose harness is starting stops it once it is up.
   *
   * Idempotent: a session this runner neither holds nor is starting is
   * already stopped.
   */
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
 * How long a start waits for an earlier harness of the same session id, which
 * is being stopped, to be gone. Some adapters return from `stopSession` before
 * the harness has exited. After the bound the start is refused, instead of
 * waiting for ever behind a harness that never exits.
 */
const STOP_WAIT_BOUND: Duration.Duration = Duration.seconds(30);

/**
 * Why the input a start carries never reached the harness, and how the
 * session ended, if it did:
 *
 * - `crash`: the session failed to start. The controller keeps a session in
 *   `starting` until it receives an exit, and `crash` is the reason for an
 *   end nobody asked for that leaves nothing to resume.
 * - `runner_restart`: the runner began shutting down while the session was
 *   starting.
 * - `stopped`: a stop arrived before the harness was spawned, so none was.
 * - undefined: the session is left as it was, running or stopping.
 */
interface UndeliveredStart {
  /** The reason the input is refused with. */
  readonly message: string;
  /** The exit to report, or undefined to leave the session as it was. */
  readonly exitReason: "crash" | "runner_restart" | "stopped" | undefined;
}

/** Builds the `UndeliveredStart` of a session that failed to start for the given reason. */
const buildCrashedStart = (message: string): UndeliveredStart => ({
  message,
  exitReason: "crash",
});

/** The adapter a start goes to, and the context the start resolved on this machine. */
interface PreparedStart {
  readonly adapter: ProviderAdapter;
  readonly resolved: Resolved;
}

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
   * Asks the adapter to stop a session. Every stop goes through here. The
   * reason is saved in `pendingStop` first, and then:
   *
   * - a running session is stopped directly;
   * - a starting session is not stopped yet: its start applies the saved
   *   reason before it would hand the harness its input.
   *
   * The first reason wins, as it would if two stops reached the adapter.
   */
  const requestStop = (sessionId: string, held: Live, reason: ExitReason): Effect.Effect<void> => {
    if (held.pendingStop === undefined) held.pendingStop = reason;
    return held.phase === "running" ? held.adapter.stopSession(sessionId, reason) : Effect.void;
  };

  const forConnection = (connection: Connection): SessionSupervisor => {
    /**
     * The starts on this connection that have not added their `live` entry
     * yet. The set belongs to the connection, so a start that the end of the
     * connection interrupted before it ran leaves nothing behind once the
     * connection is gone.
     */
    const arrivedStarts = new Set<ArrivedStart>();

    /** Checks whether the adapter holds a session of this id right now. */
    const isHeldBy = (adapter: ProviderAdapter, sessionId: string): Effect.Effect<boolean> =>
      Effect.map(adapter.listSessions, (bindings) =>
        bindings.some((binding) => binding.sessionId === sessionId),
      );

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

    /**
     * Interrupts every timer fiber of a removed session entry, removes its
     * scratch directory, and completes its `gone`. Call it after the entry
     * has left `live`.
     */
    const tearDownSession = (held: Live): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (held.inactivity !== undefined) yield* Fiber.interrupt(held.inactivity);
        if (held.absolute !== undefined) yield* Fiber.interrupt(held.absolute);
        yield* cancelIdleUnload(held);
        discardScratch(held.scratch);
        yield* Deferred.succeed(held.gone, undefined);
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
        if (yield* isHeldBy(held.adapter, sessionId)) return;
        // Compare by identity again after the wait above. A new start for this
        // id may have replaced the entry while this call waited on the
        // adapter, before the adapter registered the new session, so the
        // answer only describes the session this exit belongs to.
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
     * - when a turn completes;
     * - when the harness refuses input to a session with no open turn,
     *   including the input its start carried.
     *
     * It is not called when the session starts. Every start carries an input,
     * and the turn that input opens must not race a wait that started before
     * it.
     *
     * Does nothing:
     *
     * - when the spec sets no `idleMs`;
     * - when a wait is already running;
     * - when a stop was requested, because the session is on its way out
     *   already, for example when the harness refused an input because it is
     *   stopping;
     * - when the entry was torn down, since a wait armed on a torn down entry
     *   would never be interrupted.
     */
    const armIdleUnload = (held: Live, sessionId: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const idleMs = held.idleMs;
        if (idleMs === undefined || held.idle !== undefined) return;
        if (held.pendingStop !== undefined) return;
        if (live.get(sessionId) !== held) return;
        held.idle = yield* Effect.forkDetach(
          Effect.andThen(
            Effect.sleep(Duration.millis(idleMs)),
            Effect.suspend(() => {
              held.idle = undefined;
              // Compare by identity: by the time the wait ends, the entry for
              // this id may have been removed or replaced by a new start. A
              // session already being stopped is not stopped a second time.
              if (live.get(sessionId) !== held || held.pendingStop !== undefined) {
                return Effect.void;
              }
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
                if (yield* isHeldBy(held.adapter, event.sessionId)) break;
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

    /** Sends a `session.exited` for a session that ended without the adapter reporting it. */
    const reportExit = (sessionId: string, reason: ExitReason): Effect.Effect<void> =>
      forwardEvent({
        _tag: "session.exited",
        eventId: crypto.randomUUID(),
        sessionId,
        at: now(),
        reason,
      });

    /** Sends the answer to one input: the `sessionInputResult` the controller waits for under `requestId`. */
    const sendInputResult = (
      requestId: string,
      result: Omit<SessionInputResult, "_tag" | "requestId">,
    ): Effect.Effect<void> => sendFrame({ _tag: "sessionInputResult", requestId, ...result });

    /**
     * Answers an input as refused, and reports the reason on the session's
     * stream too. The controller waiting on the result needs the reason, and
     * the user reading the thread sees the session's stream.
     */
    const refuseInput = (
      frame: SessionInput | SessionStart,
      message: string,
    ): Effect.Effect<void> =>
      Effect.andThen(
        reportFailure(frame.sessionId, message),
        sendInputResult(frame.requestId, {
          ok: false,
          message: message.slice(0, MAX_MESSAGE_LENGTH),
        }),
      );

    /**
     * Hands one input to the harness of a session this runner holds, and
     * answers it: delivered, with the adapter's report of what the input did,
     * or refused, with the reason. Never fails. Both a `sessionInput` and the
     * input a `sessionStart` carries are delivered through here. The caller
     * cancels the idle wait first.
     *
     * An input that carries a step key also begins that agent step. How the
     * turn the input went to ends becomes the step's result, which is saved
     * and sent before the event that ended the turn. The input of a step the
     * controller has already settled is refused, and never reaches the
     * harness. A refused step input forgets its step and sends no step
     * result: what happens to the input next is the controller's call, and a
     * later request for the step's result is answered with `interrupted`.
     *
     * The caller runs this uninterruptibly. Interrupted between recording the
     * step and the harness's answer, the step would stay recorded with no
     * turn, and a request for its result would wait for a turn end that never
     * comes.
     */
    const sendInputAndAnswer = (
      held: Live,
      frame: SessionInput | SessionStart,
    ): Effect.Effect<void> => {
      const stepKey = frame.input.step;
      const step: RunningStep | undefined =
        stepKey === undefined ? undefined : { key: stepKey, turnId: undefined, texts: new Map() };
      // Recorded before the input reaches the harness, so the turn cannot end
      // before its step is known. Returns false for a step that was already
      // settled, whose input must not reach the harness.
      const beginStep: Effect.Effect<boolean> =
        step === undefined
          ? Effect.succeed(true)
          : Effect.tap(
              connection.workspaceSteps.beginAgentStep(
                step.key,
                held.workspaceId,
                Effect.map(
                  isHeldBy(held.adapter, frame.sessionId),
                  (isHeld) => isHeld && live.get(frame.sessionId) === held && held.step === step,
                ),
              ),
              (recorded) =>
                Effect.sync(() => {
                  if (recorded) held.step = step;
                }),
            );
      // Input the harness refused opens no turn, so a session that was idle
      // before it is still idle and gets its wait back.
      const refuseHeldInput = (message: string): Effect.Effect<void> =>
        Effect.andThen(
          refuseInput(frame, message),
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
      const deliverInput = held.adapter.sendInput(frame.sessionId, frame.input).pipe(
        Effect.tap((sent) =>
          Effect.sync(() => {
            // Unless the turn has already ended and finished the step.
            if (step !== undefined && held.step === step) step.turnId = sent.turnId;
          }),
        ),
        Effect.flatMap((sent) =>
          sendInputResult(frame.requestId, { ok: true, delivery: sent.delivery }),
        ),
        Effect.catch(refuseHeldInput),
        Effect.catchCause((cause) => refuseHeldInput(describeCause(cause, MAX_MESSAGE_LENGTH))),
      );
      return Effect.flatMap(beginStep, (recorded) =>
        recorded ? deliverInput : refuseHeldInput(SETTLED_STEP_REFUSAL),
      );
    };

    /**
     * Answers the input of a start that never reached the harness, then
     * reports how the session ended, if it did. The answer goes first, so the
     * controller has it before the exit closes the session.
     *
     * Only a crash is reported on the session's stream, because only a crash
     * leaves the user something to fix. A duplicate start, for example,
     * leaves the running session as it was, and a message about it would
     * only add noise to the thread.
     */
    const answerUndeliveredStart = (
      frame: SessionStart,
      undelivered: UndeliveredStart,
    ): Effect.Effect<void> =>
      Effect.andThen(
        sendInputResult(frame.requestId, {
          ok: false,
          message: undelivered.message.slice(0, MAX_MESSAGE_LENGTH),
        }),
        Effect.suspend(() => {
          switch (undelivered.exitReason) {
            case "crash":
              return Effect.andThen(
                reportFailure(frame.sessionId, undelivered.message),
                reportExit(frame.sessionId, "crash"),
              );
            case "runner_restart":
              return reportExit(frame.sessionId, "runner_restart");
            case "stopped":
              return reportExit(frame.sessionId, "stopped");
            case undefined:
              return Effect.void;
          }
        }),
      );

    /**
     * Checks that a session can start here and resolves its context on this
     * machine, before anything is spawned. Returns the adapter and the
     * context. Fails with an `UndeliveredStart` when the session must not
     * start, or cannot.
     */
    const prepareStart = (
      frame: SessionStart,
      arrived: ArrivedStart,
    ): Effect.Effect<PreparedStart, UndeliveredStart> =>
      Effect.gen(function* () {
        // The controller may have sent this start before it learned of the
        // shutdown. A harness spawned now would never be stopped.
        if (stopped) {
          return yield* Effect.fail<UndeliveredStart>({
            message: "the runner is shutting down",
            exitReason: undefined,
          });
        }
        const adapter = adapters.find((one) => one.providerId === frame.providerId);
        if (adapter === undefined) {
          return yield* Effect.fail(buildCrashedStart(describeMissingAdapter(frame.providerId)));
        }
        // Ask the adapter, not the `live` table. In practice the controller
        // never sends a second start for a session that has started, but a
        // start for a session the adapter still holds is a no-op for the
        // session whatever its cause (spec 03 section 2.3). Its input is
        // refused, never delivered, so the harness is never handed the same
        // input twice.
        //
        // The one exception is a session that is being stopped. The
        // controller can send a start right after a stop of the same id: it
        // stops a harness the runner still lists for a session it has already
        // ended, and a resume can start that session again. That start waits
        // until the old entry is gone.
        //
        // It waits even when the adapter no longer lists the old session,
        // because the old exit may not have been handled yet. Handled after
        // this start had replaced the entry, that exit would remove the new
        // entry while its harness is still starting, and nothing would ever
        // stop that harness.
        const earlier = live.get(frame.sessionId);
        const held = yield* isHeldBy(adapter, frame.sessionId);
        if (held && earlier?.pendingStop === undefined) {
          return yield* Effect.fail<UndeliveredStart>({
            message: `session ${frame.sessionId} is already running on this runner`,
            exitReason: undefined,
          });
        }
        if (earlier?.pendingStop !== undefined) {
          yield* Effect.timeoutOption(Deferred.await(earlier.gone), STOP_WAIT_BOUND);
          if (yield* isHeldBy(adapter, frame.sessionId)) {
            yield* Effect.logWarning(
              "A start waited for the earlier harness of its session to stop, and it is still running",
            ).pipe(Effect.annotateLogs({ sessionId: frame.sessionId }));
            return yield* Effect.fail<UndeliveredStart>({
              message: `session ${frame.sessionId} is still stopping on this runner`,
              exitReason: undefined,
            });
          }
        }
        // An exit published while the socket was down reached no relay, so
        // the `live` entry can outlive its session. Remove such a stale
        // entry before starting again. A stale entry of a session that was
        // being stopped is removed only after the wait above ran out.
        const stale = live.get(frame.sessionId);
        if (stale !== undefined) {
          live.delete(frame.sessionId);
          yield* tearDownSession(stale);
        }
        // The controller linted this schema before it sent the frame, and the
        // harness would hold every turn of the session to it. A schema outside
        // the subset means the controller and the runner disagree about which
        // schemas are allowed. Such a session must not start at all, because
        // its results could not be trusted.
        const issues =
          frame.spec.outputSchema === undefined ? [] : lintOutputSchema(frame.spec.outputSchema);
        if (issues.length > 0) {
          return yield* Effect.fail(
            buildCrashedStart(
              `the output schema is outside the subset every harness accepts: ${issues.join("; ")}`,
            ),
          );
        }
        // A stop that reached this start before now means no harness is
        // spawned at all. Checked last before the context is resolved, which
        // is the first step that changes anything on this machine.
        if (arrived.pendingStop !== undefined) {
          return yield* Effect.fail<UndeliveredStart>({
            message: `session ${frame.sessionId} was stopped before its input was handed over`,
            exitReason: "stopped",
          });
        }
        const resolved = yield* Effect.mapError(
          resolveSessionContext(frame, connection.machine, adapter.binaryName),
          buildCrashedStart,
        );
        return { adapter, resolved };
      });

    /**
     * Asks the adapter for the harness of a prepared start. Returns the
     * session's entry, still `starting`, once the harness is up. Fails with an
     * `UndeliveredStart` when the harness could not be started, or must not
     * be.
     *
     * The entry is added before the adapter is asked, and removed on any
     * failure. A session that exits while it is still starting must find its
     * entry, and a session that never came up must leave no entry behind.
     * The caller runs this uninterruptibly, so neither step can be cut off
     * halfway.
     */
    const launchHarness = (
      frame: SessionStart,
      { adapter, resolved }: PreparedStart,
      arrived: ArrivedStart,
    ): Effect.Effect<Live, UndeliveredStart> =>
      Effect.gen(function* () {
        const held: Live = {
          adapter,
          scratch: resolved.scratch,
          workspaceId: frame.spec.workspaceId,
          inactivityMs: frame.spec.timeouts.inactivityMs,
          // Not used until the session is watched: `sendSequenced` sets it
          // together with `inactivity`, on the event that starts the watch.
          lastEventAt: 0,
          inactivity: undefined,
          turnOpen: false,
          parked: false,
          absolute: undefined,
          idleMs: frame.spec.timeouts.idleMs,
          idle: undefined,
          phase: "starting",
          // A stop that arrived before this entry existed is applied by the
          // same path as one that arrives while the harness starts.
          pendingStop: arrived.pendingStop,
          gone: Deferred.makeUnsafe<void>(),
          hasOutputSchema: frame.spec.outputSchema !== undefined,
          step: undefined,
        };
        // In the same step, with no yield between, so a stop finds either the
        // arrived start or this entry, and is never lost between the two.
        live.set(frame.sessionId, held);
        arrivedStarts.delete(arrived);
        // Check `stopped` again. A shutdown that began after `prepareStart`
        // checked it would not see this session, because `listSessions` and
        // `resolveSessionContext` both yield to other fibers before this
        // line. There is no point asking the adapter for a harness that is
        // about to be stopped.
        if (stopped) {
          live.delete(frame.sessionId);
          yield* tearDownSession(held);
          return yield* Effect.fail<UndeliveredStart>({
            message: "the runner is shutting down",
            exitReason: "runner_restart",
          });
        }
        // Start the absolute timer here, not on `session.started`: the
        // runner itself promises to end the session at the deadline,
        // whether or not the harness confirms it started.
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
        yield* Effect.tapCause(
          Effect.mapError(
            adapter.startSession(frame.sessionId, frame.spec, resolved.ctx),
            buildCrashedStart,
          ),
          () =>
            Effect.gen(function* () {
              // Compare by identity: if a later start has replaced the
              // entry, it is not this start's to remove.
              if (live.get(frame.sessionId) !== held) return;
              live.delete(frame.sessionId);
              yield* tearDownSession(held);
            }),
        );
        return held;
      });

    /**
     * Hands the input a start carries to its harness, which `launchHarness`
     * has just started, and answers it. Fails with an `UndeliveredStart` when
     * a later start has replaced the session's entry, or when a stop was
     * requested before this point.
     *
     * The checks, the move to `running` and the call to the adapter happen in
     * one step, with nothing between them that waits. So a stop requested
     * before that step is saved in `pendingStop` and found here, and a stop
     * requested after it goes to the adapter, where it races the input
     * (spec 06 section 4.2).
     */
    const handOverStartInput = (
      held: Live,
      frame: SessionStart,
    ): Effect.Effect<void, UndeliveredStart> =>
      // The idle wait cannot be running yet, because the session has had no
      // turn. It is cancelled anyway, before the checks, so the checks stay
      // the last step before the input reaches the harness.
      Effect.andThen(
        cancelIdleUnload(held),
        Effect.suspend(() => {
          // Compare by identity, as both timers do: if a later start has
          // replaced the entry, this start must not mark it running, apply
          // its own pending stop to it, or hand its harness this input.
          if (live.get(frame.sessionId) !== held) {
            return Effect.fail<UndeliveredStart>({
              message: `session ${frame.sessionId} was started again before its input was handed over`,
              exitReason: undefined,
            });
          }
          held.phase = "running";
          // Apply a stop that was requested before this point, by a
          // shutdown, a timer or the controller. The input would open a turn
          // in a session that is on its way out.
          const stopReason = held.pendingStop;
          if (stopReason !== undefined) {
            return Effect.andThen(
              requestStop(frame.sessionId, held, stopReason),
              Effect.fail<UndeliveredStart>({
                message: `session ${frame.sessionId} was stopped before its input was handed over`,
                exitReason: undefined,
              }),
            );
          }
          return sendInputAndAnswer(held, frame);
        }),
      );

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

      // Every path answers the input the frame carries exactly once: a
      // launched session gets it through `handOverStartInput`, and every other path
      // ends in `answerUndeliveredStart`. Nothing arms the idle unload after
      // a delivered input: the turn it opens is reported by the adapter, and
      // that turn's `turn.completed` arms the wait.
      //
      // Only the preparation can be interrupted, for example when the socket
      // drops. From the moment the harness is asked for until its input is
      // answered, the start runs to the end: a harness that was started but
      // never handed its input would have no turn and no idle wait, and
      // nothing would ever stop it. That also keeps the input running to
      // its answer once it has begun an agent step, as
      // `sendInputAndAnswer` requires.
      //
      // So tearing down a dropped connection, which interrupts every frame
      // still being handled and waits for each, waits for this part too. The
      // connection handles each session's frames apart from the others', so
      // only this session's later frames wait behind it, never a ping or
      // another session. The wait is bounded by the deadline each adapter
      // puts on its requests to the harness:
      //
      // - Codex: `RPC_DEADLINE`, 30 seconds per app-server request. A start
      //   makes two (the handshake and opening the thread). Its input makes
      //   one or two more (a steer, then a new turn), and each of those is
      //   retried up to three times while Codex reports it is overloaded.
      // - pi: `RPC_DEADLINE`, 5 seconds per command.
      // - Claude Code: `CONTROL_DEADLINE`, 5 seconds, for a change of model
      //   before the input. Its start and the input itself do not wait on
      //   the harness.
      start: (frame: SessionStart): Effect.Effect<void> => {
        const arrived: ArrivedStart = { sessionId: frame.sessionId, pendingStop: undefined };
        arrivedStarts.add(arrived);
        return Effect.uninterruptibleMask((restore) =>
          restore(prepareStart(frame, arrived)).pipe(
            Effect.flatMap((prepared) => launchHarness(frame, prepared, arrived)),
            Effect.flatMap((held) => handOverStartInput(held, frame)),
            Effect.catch((undelivered) => answerUndeliveredStart(frame, undelivered)),
            Effect.catchCause((cause) =>
              // An interrupted preparation started nothing, and the
              // connection that would carry an answer is going away.
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause)
                : answerUndeliveredStart(
                    frame,
                    buildCrashedStart(describeCause(cause, MAX_MESSAGE_LENGTH)),
                  ),
            ),
          ),
        ).pipe(Effect.ensuring(Effect.sync(() => arrivedStarts.delete(arrived))));
      },

      /**
       * Delivers input to the session, or reports that it could not. The runner
       * never queues input; queuing is the controller's job
       * (spec 06 section 5). The controller waits for the answer under the
       * Queued Input row's id, `requestId`.
       */
      input: (frame: SessionInput): Effect.Effect<void> =>
        // Read the table when the effect runs, not when it is built: the
        // connection builds it as the frame arrives, and runs it only after
        // the session's earlier frames, such as its start, are done.
        Effect.suspend(() => {
          const held = live.get(frame.sessionId);
          if (held === undefined) {
            return refuseInput(frame, `session ${frame.sessionId} is not running on this runner`);
          }
          // The session is on its way out, so the input would open a turn
          // nothing finishes.
          if (held.pendingStop !== undefined) {
            return refuseInput(frame, `session ${frame.sessionId} is stopping on this runner`);
          }
          // Cancel the idle wait before the input reaches the harness. The
          // turn this input opens may start only after the wait would have
          // ended.
          //
          // Uninterruptible, as `sendInputAndAnswer` requires. A closing
          // socket interrupts the frame's work, and the close waits for this
          // block instead, as it waits for a start's input. The deadlines
          // each adapter puts on its requests to the harness bound that wait;
          // the comment on `start` lists them.
          return Effect.uninterruptible(
            Effect.andThen(cancelIdleUnload(held), sendInputAndAnswer(held, frame)),
          );
        }),

      /** Idempotent: a session this runner does not hold has no turn to end. */
      interrupt: (frame: SessionInterrupt): Effect.Effect<void> =>
        Effect.suspend(
          () => live.get(frame.sessionId)?.adapter.interrupt(frame.sessionId) ?? Effect.void,
        ),

      /**
       * Passes the user's decision on an open approval to the adapter.
       * Idempotent: the adapter ignores a request it does not hold, because it
       * was already answered or never opened here. The outcome arrives as an
       * event on the session's stream, not as a reply to this frame.
       */
      respondToApprovalRequest: (frame: SessionRespondToApprovalRequest): Effect.Effect<void> =>
        Effect.suspend(
          () =>
            live
              .get(frame.sessionId)
              ?.adapter.respondToApprovalRequest(
                frame.sessionId,
                frame.requestId,
                frame.decision,
              ) ?? Effect.void,
        ),

      /**
       * Passes the user's answers to an open question to the adapter, with the
       * same idempotence and the same report as `respondToApprovalRequest`.
       */
      respondToQuestion: (frame: SessionRespondToQuestion): Effect.Effect<void> =>
        Effect.suspend(
          () =>
            live
              .get(frame.sessionId)
              ?.adapter.respondToQuestion(frame.sessionId, frame.requestId, frame.answers) ??
            Effect.void,
        ),

      stop: (frame: SessionStop): Effect.Effect<void> => {
        for (const arrived of arrivedStarts) {
          if (arrived.sessionId === frame.sessionId && arrived.pendingStop === undefined) {
            arrived.pendingStop = "stopped";
          }
        }
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
