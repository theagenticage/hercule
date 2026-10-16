/**
 * The observation of the edits that shell commands make in one workspace
 * (spec 19 section 4.1). A shell command names no files, and git cannot tell
 * which session changed a file. So the watch looks at the workspace, not at a
 * session, and decides who made a change by who was busy while it happened:
 *
 * - After a session's command finished, git lists what changed since the
 *   previous check.
 * - When exactly one session was busy since the previous check, the changes
 *   are that session's.
 * - When several were, the changes cannot be told apart. They are dropped, and
 *   each of those sessions is warned once.
 *
 * A session is busy from the start to the completion of an item that can
 * write files, unless the agent that runs it is parked on a Request. The watch
 * also decides when to check, remembers what it already sent, and ends once no
 * session is left and nothing is owed. What a check finds is
 * `checkout-edits.ts`'s work.
 */
import type { EditedFile, ProviderEvent, RunnerToController } from "@hercule/protocol";
import { MAX_EDITED_FILES } from "@hercule/protocol";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import { buildSubstrateEnv } from "../workspaces";
import { listChangesSince, type CheckoutState, type InitialState } from "./checkout-edits";

/** What a watch needs from the connection it reports on. */
export interface EditWatchConnection {
  /** Closes when the connection ends. A check runs in this scope and is cut off with it. */
  readonly scope: Scope.Scope;
  readonly machine: { readonly baseEnv: Readonly<Record<string, string | undefined>> };
  /** The error type is left to the transport. A failed write means the connection is closing. */
  readonly send: (frame: RunnerToController) => Effect.Effect<void, unknown>;
}

/** The connection that is up now, and whether its controller reads `filesEdited` frames. */
export interface AttachedConnection {
  readonly connection: EditWatchConnection;
  readonly readsFilesEdited: boolean;
}

/**
 * The observation of the edits that shell commands make in one workspace. It
 * lives while the workspace has sessions, and after that until what is
 * attributed to the last of them has reached a controller.
 */
export interface EditWatch {
  /** Adds a session that was placed in the workspace. It takes no state of its own. */
  readonly addSession: (sessionId: string) => void;
  /**
   * Records whether the event's agent is busy. When the event is a finished
   * command, also warns the session once if its commands cannot be observed,
   * and requests a check without waiting for git.
   */
  readonly observeEvent: (event: ProviderEvent) => Effect.Effect<void>;
  /**
   * Sends the attached connection every attributed file it has not received,
   * and runs a listing that is still wanted. Call it when a connection
   * attaches: frames are never replayed, and a listing cut off with the
   * previous connection has no command left to ask for it again.
   */
  readonly requestReport: () => Effect.Effect<void>;
  /**
   * Marks a session as exited. When it was busy, requests a listing first, so
   * its partial edits are attributed while it is still part of the watch. The
   * watch forgets an exited session once the files attributed to it have
   * reached a controller, and ends when no session is left.
   */
  readonly removeSession: (sessionId: string) => Effect.Effect<void>;
}

/** What the watch knows about one session of the workspace. */
interface WatchedSession {
  /**
   * The items that can write files and have started but not completed, by the
   * agent that runs them: the session's own agent under the empty string, a
   * subagent under its id.
   */
  readonly openItems: Map<string, Set<string>>;
  /** The agent that waits on each open Request, by request id. */
  readonly parkedRequests: Map<string, string>;
  /** The files attributed to this session, by resource id and path. */
  readonly attributed: Map<string, EditedFile>;
  exited: boolean;
  warnedUnobserved: boolean;
  warnedOverlap: boolean;
  warnedListingFailed: boolean;
}

type WarningFlag = "warnedUnobserved" | "warnedOverlap" | "warnedListingFailed";

/**
 * Tells whether an item of this kind can write files while it runs. Only
 * these two do:
 *
 * - `command_execution` runs a shell command.
 * - `file_change` is the edit tool.
 *
 * Every other kind reads, searches, thinks or talks. `tool_call` is the one
 * that could write, as any other tool of a harness can, but it also covers
 * every read-only tool. Counting it would make a reviewer that only reads
 * through tools silence the worker's commands.
 */
const canWriteFiles = (kind: string): boolean =>
  kind === "command_execution" || kind === "file_change";

/**
 * Tells whether `event` reports a command that ran to its end. A failed
 * command can still have changed files. A declined one never ran.
 */
const isFinishedCommand = (event: ProviderEvent): boolean =>
  event._tag === "item.completed" &&
  event.kind === "command_execution" &&
  event.status !== "declined";

const keyOfFile = (file: EditedFile): string => `${file.resourceId}\0${file.path}`;

/** Tells whether an agent of the session is parked on a Request. */
const isParked = (session: WatchedSession, agent: string): boolean =>
  [...session.parkedRequests.values()].includes(agent);

/** Tells whether an agent of the session runs an item that can write files and is not parked. */
const isWorking = (session: WatchedSession): boolean =>
  [...session.openItems].some(([agent, items]) => items.size > 0 && !isParked(session, agent));

/**
 * Returns the watch of a workspace. `initialState` is the state of the
 * workspace's checkouts before any session ran there, which the first check
 * is compared with. The caller adds the first session right after.
 *
 * - `readAttachedConnection` returns the connection that is up now, or
 *   undefined. It is read on every request, so a connection that attaches at
 *   any moment is used.
 * - `warn` sends one warning on the stream of one session, in plain words.
 * - `onEnded` is called once, when the last session is gone and nothing is
 *   owed.
 */
export const startEditWatch = (
  initialState: InitialState,
  options: {
    readonly readAttachedConnection: () => AttachedConnection | undefined;
    readonly warn: (sessionId: string, message: string) => Effect.Effect<void>;
    readonly onEnded: () => void;
  },
): EditWatch => {
  const { readAttachedConnection, warn, onEnded } = options;
  const sessions = new Map<string, WatchedSession>();
  const unobservedReason = initialState._tag === "unavailable" ? initialState.reason : undefined;
  // The checkouts as they were at the last successful listing.
  let previousStates: ReadonlyArray<CheckoutState> =
    initialState._tag === "taken" ? initialState.checkouts : [];
  // The sessions that were busy at some point since the previous listing started.
  let busySince = new Set<string>();
  // While a listing runs: the sessions busy at its start, and those that became
  // busy since. They are the ones to count at the next listing. Undefined
  // while no listing runs.
  let nextBusy: Set<string> | undefined;
  // The files sent on one connection. On any other connection none were sent,
  // because a frame lost with its connection is never replayed.
  let reported:
    | {
        readonly connection: EditWatchConnection;
        readonly sent: Map<string, Set<string>>;
      }
    | undefined;
  // Whether a check is running, and whether a request came while it ran, so
  // one more check follows it.
  let checkInFlight = false;
  let checkAgain = false;
  // Whether a command finished and its listing has not run to its end on a
  // connection that stayed up.
  let listingWanted = false;
  let ended = false;

  const markBusy = (sessionId: string): void => {
    busySince.add(sessionId);
    nextBusy?.add(sessionId);
  };

  /**
   * Tells whether files attributed to a session may not have reached a
   * controller: they were not sent on the connection that is up now, and the
   * controller there reads them, or no connection is up.
   */
  const isOwed = (sessionId: string, session: WatchedSession): boolean => {
    if (session.attributed.size === 0) return false;
    const attached = readAttachedConnection();
    if (attached === undefined) return true;
    if (!attached.readsFilesEdited) return false;
    const sent =
      reported?.connection === attached.connection ? reported.sent.get(sessionId) : undefined;
    return (sent?.size ?? 0) < session.attributed.size;
  };

  /**
   * Forgets the sessions that exited and are owed nothing, and ends the watch
   * when none is left. A session that exited stays while a listing is wanted
   * or a check runs, because the files it changed are not attributed yet.
   */
  const pruneAndEndIfDone = (): void => {
    if (ended || checkInFlight || listingWanted) return;
    for (const [sessionId, session] of sessions) {
      if (!session.exited || isOwed(sessionId, session)) continue;
      sessions.delete(sessionId);
      busySince.delete(sessionId);
      nextBusy?.delete(sessionId);
    }
    if (sessions.size > 0) return;
    ended = true;
    onEnded();
  };

  /**
   * Sends one session a warning, once per `flag`. A warning goes out on the
   * stream of the session, and the runner does not replay events that no
   * connection received, so nothing is sent while none is attached. The flag
   * is set again if the connection went away while the warning was sent, so
   * the next connection gets it.
   */
  const warnOnce = (
    sessionId: string,
    session: WatchedSession,
    flag: WarningFlag,
    message: string,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const before = readAttachedConnection()?.connection;
      if (before === undefined || session[flag]) return;
      session[flag] = true;
      yield* warn(sessionId, message);
      if (readAttachedConnection()?.connection !== before) session[flag] = false;
    });

  /**
   * Warns each session once that its commands were not told apart from
   * another session's. A session that already exited but is still part of the
   * watch is warned too, because its files were dropped as well.
   */
  const warnOverlappingSessions = (sessionIds: ReadonlyArray<string>): Effect.Effect<void> =>
    Effect.forEach(
      sessionIds,
      (sessionId) => {
        const session = sessions.get(sessionId);
        return session === undefined
          ? Effect.void
          : warnOnce(
              sessionId,
              session,
              "warnedOverlap",
              "Edits made by shell commands while another session in the workspace worked at the same time are not observed, because git cannot tell which session made them. Edits made with the edit tools still are.",
            );
      },
      { discard: true },
    );

  /** Warns each session that has not exited, once, that a listing failed. */
  const warnListingFailed = (reason: string): Effect.Effect<void> =>
    Effect.forEach(
      [...sessions].filter(([, session]) => !session.exited),
      ([sessionId, session]) =>
        warnOnce(
          sessionId,
          session,
          "warnedListingFailed",
          `Edits made by shell commands could not be listed just now: ${reason}. The next command that finishes tries again, and the changes made meanwhile are not lost.`,
        ),
      { discard: true },
    );

  /**
   * Starts a listing when one is wanted, and returns whether it did. In the
   * same synchronous step it takes the sessions that are busy now as the
   * start of the next window. A command that starts and completes while git
   * runs can write after git looked, so the window of the next listing has to
   * open here, not when git is done.
   */
  const startListing = (): Effect.Effect<boolean> =>
    Effect.sync(() => {
      if (!listingWanted) return false;
      listingWanted = false;
      nextBusy = new Set(
        [...sessions].filter(([, session]) => isWorking(session)).map(([sessionId]) => sessionId),
      );
      return true;
    });

  /**
   * Lists what changed since the previous listing and attributes it. When
   * a listing fails or times out, the state stays, so the next listing covers
   * the same changes, and the sessions busy since then still count.
   *
   * The sessions that were busy are read after git finished, so a session
   * that became busy while git ran counts too.
   */
  const listAndAttribute = (connection: EditWatchConnection): Effect.Effect<void> =>
    Effect.gen(function* () {
      const listed = yield* Effect.result(
        listChangesSince(previousStates, buildSubstrateEnv(connection.machine.baseEnv)),
      );
      if (listed._tag === "Failure") {
        yield* Effect.sync(() => {
          for (const sessionId of nextBusy ?? []) busySince.add(sessionId);
          nextBusy = undefined;
        });
        yield* Effect.logDebug(`edit check dropped: ${listed.failure}`);
        return yield* warnListingFailed(listed.failure);
      }
      const { files, states } = listed.success;
      const busy = yield* Effect.sync(() => {
        previousStates = states;
        const busy = [...busySince];
        busySince = nextBusy ?? new Set();
        nextBusy = undefined;
        if (busy.length === 1) {
          const session = sessions.get(busy[0]!);
          for (const file of files) session?.attributed.set(keyOfFile(file), file);
        }
        return busy;
      });
      // Nothing was dropped when nothing changed, so nobody is warned.
      if (busy.length > 1 && files.length > 0) yield* warnOverlappingSessions(busy);
      if (busy.length === 0 && files.length > 0) {
        yield* Effect.logInfo(
          `Dropped ${String(files.length)} changed files: no session was busy while they changed`,
        );
      }
      yield* Effect.logDebug(
        `edit check: ${String(files.length)} changed files, ${String(busy.length)} sessions busy`,
      );
    });

  /**
   * Sends every session the files attributed to it that `connection` has not
   * received, `MAX_EDITED_FILES` at a time. A file counts as sent only once
   * its frame was written. When a write fails, the connection is closing, so
   * nothing more is sent, and the files stay owed to the next connection.
   */
  const sendUnsentEdits = (connection: EditWatchConnection): Effect.Effect<void> =>
    Effect.gen(function* () {
      // On a connection the watch has not reported on, nothing was sent yet.
      if (reported?.connection !== connection) reported = { connection, sent: new Map() };
      const connectionSent = reported.sent;
      for (const [sessionId, session] of [...sessions]) {
        const sent = connectionSent.get(sessionId) ?? new Set<string>();
        connectionSent.set(sessionId, sent);
        const unsent = [...session.attributed].filter(([key]) => !sent.has(key));
        for (let start = 0; start < unsent.length; start += MAX_EDITED_FILES) {
          const batch = unsent.slice(start, start + MAX_EDITED_FILES);
          const written = yield* Effect.exit(
            connection.send({
              _tag: "filesEdited",
              sessionId,
              editedFiles: batch.map(([, file]) => file),
            }),
          );
          if (written._tag === "Failure") return;
          for (const [key] of batch) sent.add(key);
        }
      }
    });

  /**
   * Runs the wanted listing, then sends what the connection has not
   * received, and repeats while requests come in meanwhile.
   *
   * Whether to run again or to stop is decided in one synchronous step, so a
   * request that comes in between cannot be lost. `attempt.finished` is set
   * in that step, so the fiber's exit observer can tell a check that ended by
   * itself from one that was cut off.
   */
  const runChecks = (
    connection: EditWatchConnection,
    attempt: { finished: boolean },
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      let again = true;
      while (again) {
        if (yield* startListing()) yield* listAndAttribute(connection);
        yield* sendUnsentEdits(connection);
        again = yield* Effect.sync(() => {
          if (checkAgain) {
            checkAgain = false;
            return true;
          }
          attempt.finished = true;
          checkInFlight = false;
          pruneAndEndIfDone();
          return false;
        });
      }
    });

  /**
   * Resets the state of a check that was cut off, by its connection closing
   * or by a failure. A cut-off listing is wanted again on the next
   * connection, and the sessions that were busy during it still count.
   */
  const abandonCheck = (): void => {
    checkInFlight = false;
    checkAgain = false;
    if (nextBusy !== undefined) {
      for (const sessionId of nextBusy) busySince.add(sessionId);
      nextBusy = undefined;
      listingWanted = true;
    }
    pruneAndEndIfDone();
  };

  /**
   * Forks a check into the scope of `connection`. The fiber's exit is
   * observed from outside, because a fiber forked into a scope that is
   * already closing is interrupted before it runs a single step, and nothing
   * inside it could reset the state.
   */
  const startCheck = (connection: EditWatchConnection): Effect.Effect<void> => {
    checkInFlight = true;
    const attempt = { finished: false };
    return Effect.flatMap(
      Effect.forkIn(runChecks(connection, attempt), connection.scope),
      (fiber) =>
        Effect.sync(() => {
          fiber.addObserver(() => {
            if (!attempt.finished) abandonCheck();
          });
        }),
    );
  };

  /**
   * Asks for a check without delaying the caller. Without a connection, the
   * wanted listing stays for the next one.
   */
  const requestCheck = (): Effect.Effect<void> =>
    Effect.suspend(() => {
      // Nothing is ever attributed in a workspace that is not observed.
      if (unobservedReason !== undefined) return Effect.void;
      const attached = readAttachedConnection();
      if (attached === undefined) return Effect.void;
      if (!attached.readsFilesEdited) {
        // A controller without the capability is owed nothing, so a listing
        // that waited for a connection is dropped.
        listingWanted = false;
        pruneAndEndIfDone();
        return Effect.void;
      }
      if (checkInFlight) {
        checkAgain = true;
        return Effect.void;
      }
      return startCheck(attached.connection);
    });

  /**
   * Sends one warning when edits made by shell commands cannot be observed:
   * the workspace is the main one, no state could be taken, or the controller
   * does not read `filesEdited`. Does nothing for a workspace that is
   * observed.
   */
  const warnWhenUnobserved = (sessionId: string, session: WatchedSession): Effect.Effect<void> =>
    Effect.suspend(() => {
      const attached = readAttachedConnection();
      if (attached === undefined) return Effect.void;
      const reason =
        unobservedReason ??
        (attached.readsFilesEdited ? undefined : "the controller does not read them");
      if (reason === undefined) return Effect.void;
      return warnOnce(
        sessionId,
        session,
        "warnedUnobserved",
        `Edits made by shell commands are not observed for this session: ${reason}. Edits made with the edit tools still are.`,
      );
    });

  return {
    addSession: (sessionId) => {
      // A session that starts again under the same id keeps what was attributed to it.
      const existing = sessions.get(sessionId);
      if (existing !== undefined) {
        existing.exited = false;
        return;
      }
      sessions.set(sessionId, {
        openItems: new Map(),
        parkedRequests: new Map(),
        attributed: new Map(),
        exited: false,
        warnedUnobserved: false,
        warnedOverlap: false,
        warnedListingFailed: false,
      });
    },

    observeEvent: (event) =>
      Effect.suspend(() => {
        const session = sessions.get(event.sessionId);
        if (session === undefined) return Effect.void;
        const agent = "subagentId" in event ? (event.subagentId ?? "") : "";
        switch (event._tag) {
          case "turn.completed":
            // Only this agent's items end with its turn. A subagent can
            // outlive the turn of the session's own agent, and the other way
            // around. Not every harness completes the items of an
            // interrupted turn, and one that does (Claude Code) may do it
            // after the turn ended. Without this, such an item would keep
            // the session busy for good.
            session.openItems.delete(agent);
            for (const [requestId, asker] of session.parkedRequests) {
              if (asker === agent) session.parkedRequests.delete(requestId);
            }
            return Effect.void;
          case "request.opened":
            session.parkedRequests.set(event.request.requestId, agent);
            // A parked agent waits on its user and writes nothing. If it was
            // all that made the session busy, the session is not busy now.
            if (!isWorking(session)) {
              busySince.delete(event.sessionId);
              nextBusy?.delete(event.sessionId);
            }
            return Effect.void;
          case "request.resolved": {
            session.parkedRequests.delete(event.requestId);
            // A denied command never runs, so its agent is not busy again.
            const isDenied =
              "decision" in event && (event.decision === "deny" || event.decision === "cancel");
            if (!isDenied && isWorking(session)) markBusy(event.sessionId);
            return Effect.void;
          }
          case "item.started":
            if (!canWriteFiles(event.kind)) return Effect.void;
            session.openItems.set(
              agent,
              (session.openItems.get(agent) ?? new Set()).add(event.itemId),
            );
            if (!isParked(session, agent)) markBusy(event.sessionId);
            return Effect.void;
          case "item.completed":
            if (!canWriteFiles(event.kind)) return Effect.void;
            session.openItems.get(agent)?.delete(event.itemId);
            // A command that was declined never ran, so it was not busy.
            // Anything else that completes was busy, even without a start.
            if (event.status === "declined") return Effect.void;
            markBusy(event.sessionId);
            if (!isFinishedCommand(event)) return Effect.void;
            if (unobservedReason === undefined) listingWanted = true;
            return Effect.andThen(warnWhenUnobserved(event.sessionId, session), requestCheck());
          default:
            return Effect.void;
        }
      }),

    requestReport: () => requestCheck(),

    removeSession: (sessionId) =>
      Effect.suspend(() => {
        const session = sessions.get(sessionId);
        if (session === undefined) return Effect.void;
        const wasBusy = [...session.openItems.values()].some((items) => items.size > 0);
        session.exited = true;
        session.openItems.clear();
        session.parkedRequests.clear();
        if (wasBusy && unobservedReason === undefined) {
          // The session stops mid-command, and git has not seen what it wrote
          // so far. The session stays until that listing is done.
          listingWanted = true;
          return requestCheck();
        }
        pruneAndEndIfDone();
        return Effect.void;
      }),
  };
};
