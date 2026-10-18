/**
 * The runner's session supervisor. It tracks the sessions this machine hosts,
 * and it is the only place that gives an outgoing normalized event its
 * sequence number.
 *
 * The session table, the sequence counter and the watch over every adapter's
 * events belong to the supervisor, not to a connection. A session outlives the
 * socket that started it, so its harness is watched whether or not a socket is
 * up: its timers fire, its agent step's outcome is saved, and its exit removes
 * its entry. A connection only carries the numbered events to the controller.
 * The controller uses the sequence number to recognise events it already has,
 * so restarting the count on a reconnect would make the controller drop events
 * it has never seen. There is no disk-backed outbox yet to replay events after
 * a reconnect, so an event produced while no connection is attached is still
 * lost on the way to the controller (spec 03 section 2.3).
 */
import { rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
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
  type SubagentId,
  type WorkspaceStepKey,
} from "@hercule/protocol";
import { describeMissingAdapter, type AdapterTurnInput, type ProviderAdapter } from "../providers";
import { now, describeCause } from "../report";
import type { WorkspaceSteps } from "../workspace-steps";
import { resolveSessionContext, type Machine, type Resolved } from "./context";
import { startEditWatch, type EditWatch } from "./edit-watch";
import { convertEditedFiles, readDetailPaths, type SessionCheckout } from "./edited-files";
import { fitEventToFrame } from "./fit-event";
import { buildAgentStepOutcome, type StepTurnEnding } from "./step-outcome";

/**
 * The agent step whose turn runs in a session: from the input that carried
 * the step's key until the turn ends or the session exits.
 */
interface RunningStep {
  readonly key: WorkspaceStepKey;
  /**
   * The workspace steps that began the step. They save its outcome and send
   * it when its turn ends, whether or not a connection is up by then.
   */
  readonly workspaceSteps: Pick<WorkspaceSteps, "finishAgentStep">;
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

/** Records Stops received while inputs for one harness are waiting for delivery. */
interface InputCancellation {
  generation: number;
  /** Completes after the latest earlier Stop reaches the adapter. Later inputs wait for it. */
  controlsReady: Deferred.Deferred<void> | undefined;
}

/**
 * A session this runner holds. The binding is not stored here, because the
 * adapters are the source of truth for what they host (spec 03 section 2.2).
 */
interface Live {
  readonly inputCancellation: InputCancellation;
  /** Completes when the adapter has bound the harness, before the first input is delivered. */
  readonly harnessReady: Deferred.Deferred<void>;
  readonly adapter: ProviderAdapter;
  readonly scratch: string | undefined;
  /** The directory the session's attached images are cached in. Removed with the entry. */
  readonly attachmentsDir: string;
  /** The session's marks directory, null when its edits are not observed. Removed with the entry. */
  readonly sessionMarksDir: string | null;
  /** The session's working directory, which relative edited paths are resolved against. */
  readonly cwd: string;
  /** The checkouts of the session's workspace. Edited paths are mapped onto them. */
  readonly checkouts: ReadonlyArray<SessionCheckout>;
  /**
   * The watch of the session's workspace, shared with the other sessions
   * there. Undefined for a session without a workspace.
   */
  readonly editWatch: EditWatch | undefined;
  /**
   * The session skills folder of the session's start, removed when the session
   * exits. Undefined when the start named no skills.
   */
  readonly sessionSkillsFolder: string | undefined;
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
  /**
   * The ids of the turns that are open, of the session's own agent and of its
   * subagents alike. Between turns the harness is idle, so it cannot be stuck.
   * This is a set of turn ids, not a flag, because a subagent can run after
   * the session's own turn has ended, and one agent's `turn.completed` must
   * not close another agent's turn (spec 03 section 6.2).
   */
  readonly openTurns: Set<string>;
  /**
   * The open Requests the agents of the session wait on, by request id, each
   * with the subagent that asked it, or `undefined` when the session's own
   * agent did. A session waiting for its user is not stuck, however long it
   * waits, so it is not watched while any Request is open. Several agents can
   * each wait at once (spec 06 section 13.3).
   *
   * A Request leaves this map on exactly the events that close it at the
   * controller: its `request.resolved`, the end of its own agent's turn, and
   * the session's exit, which removes this whole entry. The runner must never
   * drop one earlier. If the controller still showed that Request as open,
   * the inactivity watch would be running, and a session whose user has not
   * answered yet would be stopped as stuck.
   */
  readonly parkedRequests: Map<string, SubagentId | undefined>;
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
   * turn of any agent. It is forked when the last open turn completes and
   * when the harness refuses input while no turn is open, and interrupted by
   * the next input, turn or open request of any agent. Undefined whenever no
   * such wait is running.
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
 * - A stop kept here means no harness is spawned: the start refuses its input
 *   and reports the exit itself, with reason `stopped`. The controller has
 *   moved the session to `starting`, and it ends the session only when a
 *   `session.exited` arrives. The start checks for such a stop before it
 *   resolves its context, and again once it has added its entry, because
 *   resolving the context can take a long time.
 * - A stop that arrives once the entry exists goes to the entry's
 *   `pendingStop`, and the start stops the harness once it is up.
 */
interface ArrivedStart {
  readonly sessionId: string;
  readonly inputCancellation: InputCancellation;
  /** Lets controls received during context resolution wait for the harness binding. */
  readonly harnessReady: Deferred.Deferred<void>;
  /** The reason of the first stop that arrived for this session since the start arrived. */
  pendingStop: ExitReason | undefined;
  /**
   * The edit watch this start joined while it was prepared. The start owns
   * the session's place in the watch until the session's entry exists, and
   * removes it when the start ends before that. Undefined once the entry owns it.
   */
  editWatch: EditWatch | undefined;
  /**
   * The session skills folder of this start, chosen when the start's work
   * begins. Undefined before then, when the start names no skills, and once
   * the session's entry owns the folder. The start removes the folder when it
   * ends before the entry exists.
   */
  sessionSkillsFolder: string | undefined;
}

/**
 * Checks that no agent of the session has a turn open or waits on its user,
 * which is when the idle wait may run.
 */
const isIdle = (held: Live): boolean => held.openTurns.size === 0 && held.parkedRequests.size === 0;

/**
 * Checks that a turn of some agent of the session is open and no agent waits
 * on its user, which is when the inactivity watch runs. This is not the
 * opposite of `isIdle`: a session with an open turn and an open Request is
 * neither watched nor idle.
 */
const isWatched = (held: Live): boolean =>
  held.openTurns.size > 0 && held.parkedRequests.size === 0;

/** What a connection gives the supervisor while the connection is up. */
export interface Connection {
  readonly scope: Scope.Scope;
  readonly machine: Machine;
  /**
   * The workspace steps of this process. The supervisor tells them when an
   * agent step's turn begins, and the step keeps them to say how it ended.
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
   * Makes this connection the one the session events go out on, until the
   * scope closes. Call it only once the controller has proved its identity:
   * a peer that has not must never receive a session's events.
   *
   * `controllerReadsFilesEdited` is true when the controller's hello listed
   * `FILES_EDITED_CAPABILITY`. Without it, edits made by commands are not
   * reported, because an older controller closes the connection on a frame it
   * cannot read.
   */
  readonly attach: (options: {
    readonly controllerReadsFilesEdited: boolean;
  }) => Effect.Effect<void, never, Scope.Scope>;
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
 * What `makeSupervising` returns: the watch over every adapter's events, a
 * way to build a `SessionSupervisor` for each connection, and the shutdown for
 * the whole process. Sessions outlive the socket that started them, so the
 * watch and the shutdown belong to the process, not to one connection.
 */
export interface Supervising {
  /**
   * Handles every event of every adapter, for as long as it runs: keeps the
   * session table and the timers up to date, saves an agent step's outcome,
   * removes the entry of a session that exited, then numbers the event and
   * sends it on the attached connection, or drops it while none is attached.
   * Fork it once when the process starts, before the first connection: an
   * adapter's events are not replayed, so one published before the watch
   * subscribes is lost to the supervisor too. It never returns.
   */
  readonly watch: Effect.Effect<void>;
  readonly forConnection: (connection: Connection) => SessionSupervisor;
  /**
   * Stops every session this runner holds, and waits until `watch` has sent
   * each session's `session.exited` on the attached connection. The wait has
   * a time limit, so a harness that will not exit cannot hold up the caller
   * forever. New starts are blocked first, so no harness is spawned after the
   * runner says goodbye to the controller.
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

/**
 * The adapter a start goes to, and the context the start resolved on this
 * machine. `editWatch` is the watch the session joined, and is undefined when
 * the session has no workspace or its workspace has no checkouts.
 */
interface PreparedStart {
  readonly adapter: ProviderAdapter;
  readonly resolved: Resolved;
  readonly editWatch: EditWatch | undefined;
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
  // Both the watch and the handling of a controller frame send events, and the
  // controller may never insert an event whose number reached it out of order.
  const sequencing = Semaphore.makeUnsafe(1);
  // Set by `shutdown`. The process is shutting down, so a start the controller
  // sent before it learned of that would spawn a harness nothing ever stops.
  let stopped = false;
  // The connection the session events go out on, set by `attach` once the
  // controller has proved its identity. Undefined while no such connection is
  // up, and then the events are dropped (spec 03 section 2.3).
  let attached: Connection | undefined;
  // Whether the attached controller reads `filesEdited` frames. Set with `attached`.
  let attachedReadsFilesEdited = false;
  // The edit watch of each workspace that has one, by workspace id. A watch
  // stays until its last session has exited and what it owes a controller is
  // sent.
  const editWatches = new Map<string, EditWatch>();
  // The scope the workers of the edit watches run in. `shutdown` closes it.
  const editWatchScope = Scope.makeUnsafe();
  // One permit per workspace, held while a start takes the workspace's state
  // and creates or joins its edit watch. The map keeps one small entry for
  // each workspace this runner has hosted.
  const joinPermits = new Map<string, Semaphore.Semaphore>();
  /** Returns the workspace's join permit, and creates it on first use. */
  const findJoinPermit = (workspaceId: string): Semaphore.Semaphore => {
    let permit = joinPermits.get(workspaceId);
    if (permit === undefined) {
      permit = Semaphore.makeUnsafe(1);
      joinPermits.set(workspaceId, permit);
    }
    return permit;
  };

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

  /** Checks whether the adapter holds a session of this id right now. */
  const isHeldBy = (adapter: ProviderAdapter, sessionId: string): Effect.Effect<boolean> =>
    Effect.map(adapter.listSessions, (bindings) =>
      bindings.some((binding) => binding.sessionId === sessionId),
    );

  /**
   * Removes a directory a session used, and logs a failure instead of
   * failing. Removal can fail while a file is still being written into the
   * directory, such as an image download that outlived its input; the
   * session has ended either way, and its teardown must still finish.
   *
   * The removal is synchronous, because these paths are named by the session
   * id alone: a fresh start of the same session reuses them, and must not
   * find a removal of the old ones still running.
   */
  const removeSessionDirectory = (path: string | undefined): Effect.Effect<void> =>
    path === undefined
      ? Effect.void
      : Effect.try(() => rmSync(path, { recursive: true, force: true })).pipe(
          Effect.catch((error) =>
            Effect.logWarning(`could not remove ${path}: ${String(error.cause)}`),
          ),
        );

  /**
   * Removes a start's session skills folder in the background, and logs a
   * failure. Returns at once, so the caller's teardown stays one step that
   * nothing can run in the middle of. A session skills folder can hold many
   * files, and removing them synchronously would hold up the events of every
   * other session on the runner. No other start uses the folder, because its path
   * is unique to its start, so nothing waits for the removal. A removal cut
   * short by the runner exiting is finished by the wipe at the next boot.
   */
  const removeSessionSkillsFolder = (path: string | undefined): Effect.Effect<void> =>
    path === undefined
      ? Effect.void
      : Effect.asVoid(
          Effect.forkDetach(
            Effect.tryPromise(() => rm(path, { recursive: true, force: true })).pipe(
              Effect.catch((error) =>
                Effect.logWarning(`could not remove ${path}: ${String(error.cause)}`),
              ),
            ),
          ),
        );

  /**
   * Sends a frame on the attached connection, and drops it while none is
   * attached. Ignores any failure, not only a failed write. A frame that fails
   * to encode then loses one event instead of ending the watch, which would
   * silently drop every session's events for the rest of the process.
   */
  const sendFrame = (frame: RunnerToController): Effect.Effect<void> =>
    Effect.ignoreCause(Effect.suspend(() => attached?.send(frame) ?? Effect.void));

  /**
   * Takes a removed session entry out of its edit watch, interrupts every
   * timer fiber of the entry, removes its scratch, image and marks
   * directories, and completes its `gone`. Call it after the entry has left
   * `live`.
   */
  const tearDownSession = (sessionId: string, held: Live): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (held.editWatch !== undefined) held.editWatch.removeSession(sessionId);
      if (held.inactivity !== undefined) yield* Fiber.interrupt(held.inactivity);
      if (held.absolute !== undefined) yield* Fiber.interrupt(held.absolute);
      yield* cancelIdleUnload(held);
      yield* removeSessionDirectory(held.scratch);
      yield* removeSessionDirectory(held.attachmentsDir);
      yield* removeSessionDirectory(held.sessionMarksDir ?? undefined);
      yield* removeSessionSkillsFolder(held.sessionSkillsFolder);
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
      yield* tearDownSession(sessionId, held);
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
   * `idleMs`. It is called whenever the session is left with no open turn
   * of any agent:
   *
   * - when the last open turn completes;
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
   * Reads the workspace after a completed turn or exit and sends the current
   * facts on the attached connection. Inspection runs outside event
   * sequencing, in the connection's scope, so it cannot delay later events.
   * Sends nothing while no connection is attached: the facts are latest-wins
   * state, and nobody would receive them.
   */
  const reportWorkspace = (workspaceId: string): Effect.Effect<void> => {
    const connection = attached;
    if (connection === undefined) return Effect.void;
    return Effect.asVoid(
      Effect.forkIn(
        Effect.ignoreCause(
          Effect.flatMap(connection.machine.workspaces.reportAfterSession(workspaceId), (report) =>
            report === undefined ? Effect.void : sendFrame(report),
          ),
        ),
        connection.scope,
      ),
    );
  };

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
      return step.workspaceSteps.finishAgentStep(step.key, outcome);
    });

  /**
   * Numbers an event that fits in one frame and sends it. The inactivity
   * clock is updated before the send, so anyone who has seen the frame knows
   * the clock already reflects the event.
   */
  const sendFittedEvent = (event: ProviderEvent): Effect.Effect<void> =>
    Effect.gen(function* () {
      const held = live.get(event.sessionId);
      if (held !== undefined) {
        switch (event._tag) {
          case "turn.started":
            held.openTurns.add(event.turnId);
            // A turn the harness opened on its own, or a subagent's turn,
            // also ends the idle wait, not only an input frame.
            yield* cancelIdleUnload(held);
            break;
          case "turn.completed":
            held.openTurns.delete(event.turnId);
            // A Request cannot outlive its agent's turn. The controller
            // also closes them on this event, and a Request left here
            // would stop every later turn from being watched. Only this
            // agent's Requests close: another agent may still wait on its
            // user, even after the session's own turn has ended.
            for (const [requestId, asker] of held.parkedRequests) {
              if (asker === event.subagentId) held.parkedRequests.delete(requestId);
            }
            if (isIdle(held)) yield* armIdleUnload(held, event.sessionId);
            // A step's turn is a turn of the session's own agent. A
            // subagent's turn ending, even inside the step's turn, does
            // not end the step.
            if (
              event.subagentId === undefined &&
              held.step !== undefined &&
              isStepTurn(held.step, event.turnId)
            ) {
              yield* finishStepTurn(held, held.step, event);
            }
            break;
          case "content.delta": {
            // A step's result is the final message of the session's own
            // agent, so a subagent's text is never collected for it.
            const step = held.step;
            if (
              step === undefined ||
              event.subagentId !== undefined ||
              event.streamKind !== "assistant_text"
            ) {
              break;
            }
            const item = step.texts.get(event.itemId);
            if (item === undefined) {
              step.texts.set(event.itemId, { turnId: event.turnId, text: event.delta });
            } else {
              item.text += event.delta;
            }
            break;
          }
          case "session.exited": {
            // Every exit the watch sees passes through here, whatever
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
            held.parkedRequests.set(event.request.requestId, event.subagentId);
            // A session waiting on its user is in use, however long the
            // user takes to answer.
            yield* cancelIdleUnload(held);
            break;
          case "request.resolved":
            held.parkedRequests.delete(event.requestId);
            break;
          default:
            break;
        }
        // A session is watched exactly while a turn of any agent is open
        // and no agent waits on its user. The watch is brought in line
        // with the open turns and open Requests after every event,
        // instead of being started and stopped in each case above, so a
        // fiber from an earlier state can never be left behind to stop a
        // session that is not stuck.
        if (isWatched(held)) {
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
    });

  /**
   * Returns `event` with the files a finished edit changed attached to its
   * `item.completed` (spec 19 section 4.1). Only an `item.completed` of kind
   * `file_change` with status `completed` changes: its `detail` paths are
   * converted, and the files become `editedFiles`. Every other event is
   * returned as it is. When the conversion leaves paths unchecked, the list
   * is incomplete, which is logged and never shown to the user, because
   * watching edits is best effort.
   *
   * This runs before `fitEventToFrame`, which never drops `editedFiles`.
   */
  const attachEditedFiles = (event: ProviderEvent): Effect.Effect<ProviderEvent> =>
    Effect.gen(function* () {
      if (event._tag !== "item.completed" || event.kind !== "file_change") return event;
      if (event.status !== "completed") return event;
      const session = live.get(event.sessionId);
      if (session === undefined) return event;
      const { files, unchecked } = convertEditedFiles(
        session.cwd,
        session.checkouts,
        readDetailPaths(event.detail),
      );
      if (unchecked > 0) {
        yield* Effect.logWarning(
          `An edit of session ${event.sessionId} named more paths than the runner checks, so its list of edited files is incomplete. Files recorded: ${String(files.length)}. Paths not checked: ${String(unchecked)}. Item ${event.itemId}`,
        );
      }
      return files.length === 0 ? event : { ...event, editedFiles: files };
    });

  /**
   * Numbers an event and sends it. Every event goes out through here. An
   * event too large for one frame is first shrunk by `fitEventToFrame`, and
   * the events that come back are numbered with no other event between
   * them. The bookkeeping in
   * `sendFittedEvent` sees the events as sent, not as the adapter made them.
   */
  const sendSequenced = (event: ProviderEvent): Effect.Effect<void> =>
    sequencing.withPermits(1)(
      Effect.flatMap(attachEditedFiles(event), (attached) =>
        Effect.forEach(fitEventToFrame(attached), sendFittedEvent, { discard: true }),
      ),
    );

  /**
   * Numbers and sends an event, then reports the session's workspace after a
   * start, a completed turn or an exit (`reportWorkspace`). The workspace id
   * is read before the send, because an exit removes the session's entry.
   */
  const forwardEvent = (event: ProviderEvent): Effect.Effect<void> => {
    const workspaceId =
      event._tag === "session.started" ||
      event._tag === "session.exited" ||
      event._tag === "turn.completed"
        ? live.get(event.sessionId)?.workspaceId
        : undefined;
    // The watch sees the event before it is sent. Sending waits for the
    // sequencing lock and for the write, and a listing can end meanwhile and
    // credit the files of this agent's command to another session.
    return Effect.suspend(
      () => live.get(event.sessionId)?.editWatch?.observeEvent(event) ?? Effect.void,
    ).pipe(
      Effect.andThen(sendSequenced(event)),
      Effect.andThen(
        workspaceId === undefined || workspaceId === null
          ? Effect.void
          : reportWorkspace(workspaceId),
      ),
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

  const forConnection = (connection: Connection): SessionSupervisor => {
    /**
     * The starts on this connection that have not added their `live` entry
     * yet. The set belongs to the connection, so a start that the end of the
     * connection interrupted before it ran leaves nothing behind once the
     * connection is gone.
     */
    const arrivedStarts = new Set<ArrivedStart>();

    /**
     * Sends a frame on this connection, ignoring any failure, as `sendFrame`
     * does. An answer to a frame goes back on the connection the frame came
     * from: the controller waits for it there, and its wait ends with that
     * connection.
     */
    const reply = (frame: RunnerToController): Effect.Effect<void> =>
      Effect.ignoreCause(Effect.suspend(() => connection.send(frame)));

    /** Sends the answer to one input: the `sessionInputResult` the controller waits for under `requestId`. */
    const sendInputResult = (
      requestId: string,
      result: Omit<SessionInputResult, "_tag" | "requestId">,
    ): Effect.Effect<void> => reply({ _tag: "sessionInputResult", requestId, ...result });

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
     * Returns the input an adapter delivers: the frame's input, with each
     * image reference replaced by the session's cached copy of the image.
     * Fetches the images that are not cached yet. Fails with a message naming
     * the image when one cannot be fetched or does not match its checksum.
     */
    const buildAdapterInput = (
      held: Live,
      frame: SessionInput | SessionStart,
    ): Effect.Effect<AdapterTurnInput, string> => {
      const { attachments, ...rest } = frame.input;
      if (attachments === undefined || attachments.length === 0) return Effect.succeed(rest);
      return Effect.map(
        connection.machine.attachments.fetch(held.attachmentsDir, attachments),
        (local) => ({ ...rest, attachments: local }),
      );
    };

    /**
     * Hands one input to the harness of a session this runner holds, and
     * answers it: delivered, with the adapter's report of what the input did,
     * or refused, with the reason. Never fails. Both a `sessionInput` and the
     * input a `sessionStart` carries are delivered through here. The caller
     * cancels the idle wait first.
     * Inputs received after a Stop wait for that control to reach the adapter.
     * Earlier inputs keep their original barrier, so Stop can cancel their
     * preparation without waiting behind them.
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
      generation: number,
      cancellation: InputCancellation = held.inputCancellation,
      controlsReady?: Deferred.Deferred<void>,
    ): Effect.Effect<void> => {
      const stepKey = frame.input.step;
      const step: RunningStep | undefined =
        stepKey === undefined
          ? undefined
          : {
              key: stepKey,
              workspaceSteps: connection.workspaceSteps,
              turnId: undefined,
              texts: new Map(),
            };
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
            return isIdle(held) ? armIdleUnload(held, frame.sessionId) : Effect.void;
          }),
        );
      const isCancelled = (): boolean => cancellation.generation !== generation;
      // The images are fetched before the harness is asked, and the input is
      // refused if any of them cannot be: the harness never gets the text
      // without the images the user attached. The fetch can take a while, so
      // an interrupt or a stop of the session that arrives during it is
      // checked for again after it.
      const deliverInput = Effect.suspend(() =>
        isCancelled()
          ? Effect.fail("the input was stopped before delivery")
          : buildAdapterInput(held, frame),
      ).pipe(
        Effect.flatMap((input) => {
          if (isCancelled()) return Effect.fail("the input was stopped before delivery");
          if (held.pendingStop !== undefined) {
            return Effect.fail(`session ${frame.sessionId} is stopping on this runner`);
          }
          return held.adapter.sendInput(frame.sessionId, input);
        }),
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
      return Effect.andThen(
        controlsReady === undefined ? Effect.void : Deferred.await(controlsReady),
        Effect.flatMap(beginStep, (recorded) =>
          recorded ? deliverInput : refuseHeldInput(SETTLED_STEP_REFUSAL),
        ),
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
        // The one exception is a session on its way out. The controller can
        // send a start right after a stop of the same id: it stops a harness
        // the runner still lists for a session it has already ended, and a
        // resume can start that session again.
        //
        // Any earlier entry of the same id belongs to such a session: it is
        // being stopped, or its harness has exited and `watch` has not
        // handled the exit yet. The start waits until that entry is gone.
        // Handled after this start had replaced the entry, the old exit would
        // remove the new entry while its harness is still starting, and
        // nothing would ever stop that harness.
        const earlier = live.get(frame.sessionId);
        const held = yield* isHeldBy(adapter, frame.sessionId);
        if (held && earlier?.pendingStop === undefined) {
          return yield* Effect.fail<UndeliveredStart>({
            message: `session ${frame.sessionId} is already running on this runner`,
            exitReason: undefined,
          });
        }
        if (earlier !== undefined) {
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
        // The wait ran out, and the adapter no longer holds the session, but
        // its exit never came. The adapter broke its promise to publish every
        // exit, so the entry is removed here instead.
        const stale = live.get(frame.sessionId);
        if (stale !== undefined) {
          live.delete(frame.sessionId);
          yield* tearDownSession(frame.sessionId, stale);
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
        // spawned at all. Checking here, before the context is resolved,
        // spares the branch switch and the scratch directory. Resolving the
        // context can wait a long time, for example on other git work in the
        // workspace, so `launchHarness` checks again for a stop that arrives
        // during it.
        if (arrived.pendingStop !== undefined) {
          return yield* Effect.fail<UndeliveredStart>({
            message: `session ${frame.sessionId} was stopped before its input was handed over`,
            exitReason: "stopped",
          });
        }
        if (arrived.sessionSkillsFolder !== undefined) {
          yield* Effect.mapError(
            connection.machine.sessionSkillsFolders.fillFolder(
              arrived.sessionSkillsFolder,
              frame.skills ?? [],
            ),
            buildCrashedStart,
          );
        }
        const resolved = yield* Effect.mapError(
          resolveSessionContext(frame, connection.machine, adapter.binaryName),
          buildCrashedStart,
        );
        const editWatch = yield* joinEditWatch(frame, resolved, arrived);
        return { adapter, resolved, editWatch };
      });

    /**
     * Adds the session to the edit watch of its workspace and returns the
     * watch, starting it when the workspace has none. Returns undefined for a
     * session without a workspace or without checkouts.
     *
     * It runs last in `prepareStart`, the one step that a stop can interrupt,
     * and records the watch on `arrived` so `start` can take the session out
     * again when the start ends before the session's entry exists.
     */
    const joinEditWatch = (
      frame: SessionStart,
      resolved: Resolved,
      arrived: ArrivedStart,
    ): Effect.Effect<EditWatch | undefined> =>
      Effect.gen(function* () {
        const { workspaceId } = frame.spec;
        if (workspaceId === null || resolved.checkouts.length === 0) return undefined;
        // One start at a time per workspace takes the state and installs the
        // watch. Without it, a start could take a state, wait on a slow git
        // while another session created a watch, wrote files and ended it, and
        // then install its older state, which would count that session's
        // files as changes of its own.
        return yield* findJoinPermit(workspaceId).withPermits(1)(
          Effect.gen(function* () {
            const joined = yield* Effect.sync(() => {
              const watch = editWatches.get(workspaceId);
              if (watch === undefined) return undefined;
              watch.addSession(frame.sessionId, resolved.sessionMarksDir);
              arrived.editWatch = watch;
              return watch;
            });
            if (joined !== undefined) return joined;
            // The state is taken where a stop can still interrupt a slow git.
            // The harness does not exist yet, so it cannot have changed
            // anything. No other start can create a watch meanwhile, because
            // each holds this workspace's permit.
            const initialState = yield* resolved.takeInitialState();
            return yield* Effect.uninterruptible(
              Effect.gen(function* () {
                const created: EditWatch = yield* Scope.provide(editWatchScope)(
                  startEditWatch(initialState, {
                    clock: connection.machine.fileClock,
                    readAttachedConnection: () =>
                      attached === undefined
                        ? undefined
                        : { connection: attached, readsFilesEdited: attachedReadsFilesEdited },
                    onEnded: () => {
                      if (editWatches.get(workspaceId) === created) editWatches.delete(workspaceId);
                    },
                  }),
                );
                editWatches.set(workspaceId, created);
                created.addSession(frame.sessionId, resolved.sessionMarksDir);
                arrived.editWatch = created;
                return created;
              }),
            );
          }),
        );
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
      prepared: PreparedStart,
      arrived: ArrivedStart,
    ): Effect.Effect<Live, UndeliveredStart> =>
      Effect.gen(function* () {
        const { adapter, resolved, editWatch } = prepared;
        const { sessionSkillsFolder } = arrived;
        const held: Live = {
          inputCancellation: arrived.inputCancellation,
          harnessReady: arrived.harnessReady,
          adapter,
          scratch: resolved.scratch,
          attachmentsDir: resolved.attachmentsDir,
          sessionMarksDir: resolved.sessionMarksDir,
          cwd: resolved.cwd,
          checkouts: resolved.checkouts,
          editWatch,
          sessionSkillsFolder,
          workspaceId: frame.spec.workspaceId,
          inactivityMs: frame.spec.timeouts.inactivityMs,
          // Not used until the session is watched: `sendSequenced` sets it
          // together with `inactivity`, on the event that starts the watch.
          lastEventAt: 0,
          inactivity: undefined,
          openTurns: new Set(),
          parkedRequests: new Map(),
          absolute: undefined,
          idleMs: frame.spec.timeouts.idleMs,
          idle: undefined,
          phase: "starting",
          // A stop that arrived before this entry existed is checked for
          // below, before the adapter is asked for a harness.
          pendingStop: arrived.pendingStop,
          gone: Deferred.makeUnsafe<void>(),
          hasOutputSchema: frame.spec.outputSchema !== undefined,
          step: undefined,
        };
        // In the same step, with no yield between, so a stop finds either the
        // arrived start or this entry, and is never lost between the two.
        live.set(frame.sessionId, held);
        arrivedStarts.delete(arrived);
        // The entry owns the session's place in the edit watch from here on.
        arrived.editWatch = undefined;
        arrived.sessionSkillsFolder = undefined;
        // Check `stopped` again. A shutdown that began after `prepareStart`
        // checked it would not see this session, because `listSessions` and
        // `resolveSessionContext` both yield to other fibers before this
        // line. There is no point asking the adapter for a harness that is
        // about to be stopped.
        if (stopped) {
          live.delete(frame.sessionId);
          yield* tearDownSession(frame.sessionId, held);
          return yield* Effect.fail<UndeliveredStart>({
            message: "the runner is shutting down",
            exitReason: "runner_restart",
          });
        }
        // A stop that arrived while the context was being resolved, after
        // `prepareStart` last checked, was saved on the arrived start and
        // copied into this entry. No harness is spawned for it, the same as
        // for a stop that arrived earlier (spec 03 section 2.2). The reason is
        // always `stopped`: only the controller's stop marks an arrived start,
        // and nothing else can reach this entry before this line.
        if (held.pendingStop !== undefined) {
          live.delete(frame.sessionId);
          yield* tearDownSession(frame.sessionId, held);
          return yield* Effect.fail<UndeliveredStart>({
            message: `session ${frame.sessionId} was stopped before its input was handed over`,
            exitReason: "stopped",
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
            adapter.startSession(frame.sessionId, frame.spec, {
              ...resolved.ctx,
              ...(sessionSkillsFolder === undefined ? {} : { sessionSkillsFolder }),
              editMarks:
                resolved.sessionMarksDir === null || editWatch === undefined
                  ? null
                  : {
                      sessionMarksDir: resolved.sessionMarksDir,
                      recordToolStart: (toolUseId, shellCommand) =>
                        editWatch.recordToolStart(frame.sessionId, toolUseId, shellCommand),
                      recordProcessStart: (itemId) =>
                        editWatch.recordProcessStart(frame.sessionId, itemId),
                      recordProcessEnd: (itemId) =>
                        editWatch.recordProcessEnd(frame.sessionId, itemId),
                      recordRequestOnRunningItem: (requestId) =>
                        editWatch.recordRequestOnRunningItem(frame.sessionId, requestId),
                    },
            }),
            buildCrashedStart,
          ),
          () =>
            Effect.gen(function* () {
              // Compare by identity: if a later start has replaced the
              // entry, it is not this start's to remove.
              if (live.get(frame.sessionId) !== held) return;
              live.delete(frame.sessionId);
              yield* tearDownSession(frame.sessionId, held);
            }),
        );
        yield* Deferred.succeed(held.harnessReady, undefined);
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
     * (spec 06 section 4.2). An input with images is the exception: it waits
     * for its images to be fetched between the move to `running` and the
     * call to the adapter, and a stop that arrives during that wait goes to
     * the adapter and refuses the input.
     */
    const handOverStartInput = (
      held: Live,
      frame: SessionStart,
      generation: number,
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
          return sendInputAndAnswer(held, frame, generation);
        }),
      );

    return {
      attach: ({ controllerReadsFilesEdited }) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            attached = connection;
            attachedReadsFilesEdited = controllerReadsFilesEdited;
            // `filesEdited` is never replayed, so what a watch sent on the old
            // connection may be lost. Every watch checks again at once instead
            // of waiting for its next command, which may never come.
            for (const watch of editWatches.values()) watch.requestReport();
          }),
          () =>
            Effect.sync(() => {
              if (attached === connection) attached = undefined;
            }),
        ),

      // Ask the adapters each time the controller asks, instead of building
      // the list when the connection was made.
      report: Effect.flatMap(
        Effect.forEach(adapters, (adapter) => adapter.listSessions),
        (held) => reply({ _tag: "sessionsReport", sessions: held.flat() }),
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
      //
      // Before any of these, an input with images waits for them to be
      // fetched from the controller: `ATTACHMENT_DOWNLOAD_TIMEOUT`, two
      // minutes for all the images of the input together.
      start: (frame: SessionStart): Effect.Effect<void> => {
        const arrived: ArrivedStart = {
          sessionId: frame.sessionId,
          pendingStop: undefined,
          harnessReady: Deferred.makeUnsafe<void>(),
          inputCancellation: { generation: 0, controlsReady: undefined },
          editWatch: undefined,
          sessionSkillsFolder: undefined,
        };
        // Added now, not when the work begins, so a stop that arrives while
        // the start waits behind earlier frames of the session finds it.
        arrivedStarts.add(arrived);
        return Effect.uninterruptibleMask((restore) =>
          Effect.suspend(() => {
            // Chosen here, as the first step of the work, so the cleanup
            // below knows the folder before anything is written into it.
            if ((frame.skills ?? []).length > 0) {
              arrived.sessionSkillsFolder = connection.machine.sessionSkillsFolders.buildFolderPath(
                frame.sessionId,
              );
            }
            return restore(prepareStart(frame, arrived));
          }).pipe(
            Effect.flatMap((prepared) => launchHarness(frame, prepared, arrived)),
            Effect.flatMap((held) => handOverStartInput(held, frame, 0)),
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
        ).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              // A start that ended before the session's entry existed leaves
              // its place in the edit watch behind.
              arrived.editWatch?.removeSession(frame.sessionId);
              yield* removeSessionSkillsFolder(arrived.sessionSkillsFolder);
              yield* Deferred.succeed(arrived.harnessReady, undefined);
              arrivedStarts.delete(arrived);
            }),
          ),
        );
      },

      /**
       * Delivers input to the session, or reports that it could not. The runner
       * never queues input; queuing is the controller's job
       * (spec 06 section 5). The controller waits for the answer under the
       * Queued Input row's id, `requestId`.
       */
      input: (frame: SessionInput): Effect.Effect<void> => {
        const cancellation =
          [...arrivedStarts].filter((start) => start.sessionId === frame.sessionId).at(-1)
            ?.inputCancellation ?? live.get(frame.sessionId)?.inputCancellation;
        const generation = cancellation?.generation ?? 0;
        const controlsReady = cancellation?.controlsReady;
        // Read the table when the effect runs, not when it is built: the
        // connection builds it as the frame arrives, and runs it only after
        // the session's earlier frames, such as its start, are done.
        return Effect.suspend(() => {
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
            Effect.andThen(
              cancelIdleUnload(held),
              sendInputAndAnswer(held, frame, generation, cancellation, controlsReady),
            ),
          );
        });
      },

      /**
       * Records Stop when the frame arrives, then passes the interrupt to the
       * adapter once its harness is bound and earlier controls have completed.
       * Later inputs wait for this control; earlier inputs do not. The adapter
       * stops the subagents below the named subagent itself, because
       * only the adapter knows them. Idempotent: a session this runner does not
       * hold has no turn to end.
       */
      interrupt: (frame: SessionInterrupt): Effect.Effect<void> => {
        const targets = new Set<InputCancellation>();
        const held = live.get(frame.sessionId);
        if (held !== undefined) targets.add(held.inputCancellation);
        for (const start of arrivedStarts) {
          if (start.sessionId === frame.sessionId) targets.add(start.inputCancellation);
        }
        const controlsReady = Deferred.makeUnsafe<void>();
        const previousControls = new Set<Deferred.Deferred<void>>();
        for (const target of targets) {
          if (target.controlsReady !== undefined) previousControls.add(target.controlsReady);
          target.controlsReady = controlsReady;
        }
        if (frame.subagentId === undefined) {
          for (const target of targets) target.generation += 1;
        }
        const target =
          live.get(frame.sessionId) ??
          [...arrivedStarts].find((start) => start.sessionId === frame.sessionId);
        if (target === undefined)
          return Deferred.succeed(controlsReady, undefined).pipe(Effect.asVoid);
        return Effect.gen(function* () {
          yield* Deferred.await(target.harnessReady);
          for (const previous of previousControls) yield* Deferred.await(previous);
          const held = live.get(frame.sessionId);
          if (held?.harnessReady === target.harnessReady)
            yield* held.adapter.interrupt(frame.sessionId, frame.subagentId);
        }).pipe(Effect.ensuring(Deferred.succeed(controlsReady, undefined)));
      },

      /**
       * Passes the user's decision on an open approval to the adapter.
       * Idempotent: the adapter ignores a request it does not hold, because it
       * was already answered or never opened here. The outcome arrives as an
       * event on the session's stream, not as a reply to this frame.
       */
      respondToApprovalRequest: (frame: SessionRespondToApprovalRequest): Effect.Effect<void> =>
        Effect.suspend(() => {
          const held = live.get(frame.sessionId);
          if (held === undefined) return Effect.void;
          const answer = held.adapter.respondToApprovalRequest(
            frame.sessionId,
            frame.requestId,
            frame.decision,
          );
          // The command may start as soon as the harness receives an allow,
          // so its start mark is taken before the answer is sent.
          const isAllow = frame.decision === "allow" || frame.decision === "allow_always";
          if (isAllow) held.editWatch?.takeAllowMark(frame.sessionId, frame.requestId);
          return answer;
        }),

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
    Effect.ensuring(stopSessions(reason), Scope.close(editWatchScope, Exit.void));

  /** Stops every live session and waits, up to a bound, for each to exit. */
  const stopSessions = (reason: ExitReason): Effect.Effect<void> =>
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

  return {
    watch: Stream.runForEach(
      Stream.mergeAll(
        adapters.map((adapter) => adapter.events),
        { concurrency: "unbounded" },
      ),
      forwardEvent,
    ),
    forConnection,
    shutdown,
  };
};
