/**
 * The observation of the edits that shell commands make in one workspace
 * (spec 19 section 4.1). A shell command names no files, and git cannot tell
 * which session changed a file. So the watch looks at the workspace, not at a
 * session, and decides who made a change by the time it happened:
 *
 * - Every command and every edit of a session has a window: from just before
 *   it ran to just after it finished, on the kernel's file clock. A gate in
 *   the harness starts it, with a mark file (`../edit-marks`) or, for a gate
 *   that runs in the runner's process, with `recordToolStart`. The item's
 *   events end it.
 *   `command-windows.ts` holds the rules for both ends.
 * - After a command finished, git lists what changed since the previous
 *   listing (`checkout-edits.ts`), with each changed file's ctime.
 * - A file belongs to the one session whose window holds its ctime
 *   (`edit-attribution.ts`). When windows of several sessions hold it, when
 *   the window of a command that may import content, such as `git merge`,
 *   holds it, or when no window holds it, it is dropped.
 *
 * The watch is best effort. It never blocks a session, and it writes nothing
 * to a session's stream: what it could not observe goes to the runner's log
 * only. A user does not know the watch exists, and only Edit Overlaps use
 * what it finds, so a notice about it in a thread would only confuse.
 *
 * A listing reads the files' ctimes first and the windows after. A command
 * that starts after the ctimes were read has a start later than every one of
 * them, so it cannot hold any of them. Reading in the other order could credit
 * a file to a command that began after the file's last write.
 *
 * One worker fiber does all the work that waits: listing and sending files.
 * Events only record what happened and wake the worker, and the worker reads
 * the connection that is attached when it sends, so a connection that closes
 * or attaches never interrupts a listing.
 */
import type { EditedFile, HarnessEvent, RunnerToController } from "@hercule/protocol";
import { MAX_EDITED_FILES } from "@hercule/protocol";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import type * as Scope from "effect/Scope";
import { takeStartMarks, type FileClock } from "../edit-marks";
import { buildSubstrateEnv } from "../workspaces";
import { listChangesSince, type CheckoutState, type InitialState } from "./checkout-edits";
import { makeCommandWindows } from "./command-windows";
import { attributeChangedFiles } from "./edit-attribution";

/** What a watch needs from the connection it reports on. */
export interface EditWatchConnection {
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
 * attributed to the last of them has reached a controller. No method waits:
 * each records what happened and wakes the worker when a listing is due.
 */
export interface EditWatch {
  /**
   * Adds a session that was placed in the workspace. `sessionMarksDir` is
   * where its gates write their marks, or null when its edits are not
   * observed.
   */
  readonly addSession: (sessionId: string, sessionMarksDir: string | null) => void;
  /**
   * Records what an event shows about the commands and edits of its session:
   * a Request that asks to run one, a Request's end, and an item that
   * started or completed. Logs an item that completed with no known start.
   */
  readonly observeEvent: (event: HarnessEvent) => Effect.Effect<void>;
  /**
   * Takes the start mark of the command or edit that a Request asks to run.
   * Call it right before an allow answer reaches the harness: the command
   * cannot have started before then, so this mark is a start as late as the
   * runner can know it. Does nothing for a Request the watch does not track.
   */
  readonly takeAllowMark: (sessionId: string, requestId: string) => void;
  /**
   * Takes the start mark of the tool call `toolUseId` now, for a gate that
   * runs in the runner's own process (`EditMarks.recordToolStart`), with the
   * text of a shell command. It never waits and never fails.
   */
  readonly recordToolStart: (
    sessionId: string,
    toolUseId: string,
    shellCommand: string | undefined,
  ) => void;
  /** Records that the Request `requestId` asks about an item that already runs (`EditMarks.recordRequestOnRunningItem`). */
  readonly recordRequestOnRunningItem: (sessionId: string, requestId: string) => void;
  /** Records that the tool call `itemId` started a process that can write files, which holds its window open until `recordProcessEnd`. */
  readonly recordProcessStart: (sessionId: string, itemId: string) => void;
  /** Records that the process of the tool call `itemId` ended. */
  readonly recordProcessEnd: (sessionId: string, itemId: string) => void;
  /**
   * Wakes the worker. It sends the attached connection every attributed file
   * it has not received, and runs a listing that is still due.
   * Call it when a connection attaches: frames are never replayed.
   */
  readonly requestReport: () => void;
  /**
   * Records that a session exited. Every window it still has open ends, and
   * a listing follows, so its partial edits are attributed while it is still
   * part of the watch. The watch forgets an exited session once the files
   * attributed to it have reached a controller, and ends when no session is
   * left.
   */
  readonly removeSession: (sessionId: string) => void;
}

/** What the watch knows about one session of the workspace. */
interface ObservedSession {
  /** Where the session's gates write their marks, or null when its edits are not observed. */
  sessionMarksDir: string | null;
  /** The files attributed to this session, by resource id and path. */
  readonly attributed: Map<string, EditedFile>;
  /** The file clock when the session joined. A command whose start is unknown is taken to have started then. */
  readonly joinedAtNs: bigint;
  exited: boolean;
}

const buildFileKey = (file: EditedFile): string => `${file.resourceId}\0${file.path}`;

/**
 * Returns the watch of a workspace, and starts its worker fiber in the scope
 * it is given. `initialState` is the state of the workspace's checkouts
 * before any session ran there, which the first listing is compared with. The
 * caller adds the first session right after.
 *
 * - `clock` is the runner's file clock.
 * - `readAttachedConnection` returns the connection that is up now, or
 *   undefined. The worker reads it each time it sends, so a connection that
 *   attaches at any moment is used.
 * - `onEnded` is called once, when the last session is gone and nothing is
 *   owed. The worker ends with it.
 */
export const startEditWatch = (
  initialState: InitialState,
  options: {
    readonly clock: FileClock;
    readonly readAttachedConnection: () => AttachedConnection | undefined;
    readonly onEnded: () => void;
  },
): Effect.Effect<EditWatch, never, Scope.Scope> => {
  const { clock, readAttachedConnection, onEnded } = options;
  const sessions = new Map<string, ObservedSession>();
  // Reads nothing for a session that exited: its harness is gone, and a mark
  // it left can only open a window that nothing closes.
  const windows = makeCommandWindows({
    takeMark: clock.takeMark,
    takeStartMarks: (sessionId) => {
      const session = sessions.get(sessionId);
      return session === undefined || session.exited || session.sessionMarksDir === null
        ? []
        : takeStartMarks(session.sessionMarksDir);
    },
  });
  const unobservedReason = initialState._tag === "unavailable" ? initialState.reason : undefined;
  // The checkouts as they were at the last successful listing, or at the first state.
  let previousStates: ReadonlyArray<CheckoutState> =
    initialState._tag === "taken" ? initialState.checkouts : [];
  // When the last successful listing started, or when the first state was
  // taken. A file that was deleted or moved since was still in its old place then.
  let previousListingStartedAtNs = initialState._tag === "taken" ? initialState.takenAtNs : 0n;
  // The files sent on one connection. On any other connection none were sent,
  // because a frame lost with its connection is never replayed.
  let reported:
    | {
        readonly connection: EditWatchConnection;
        readonly sent: Map<string, Set<string>>;
      }
    | undefined;
  let ended = false;
  // Open while the worker has something to look at. Many wakes while the
  // worker runs collapse into one more pass.
  const wake = Latch.makeUnsafe(false);

  const wakeWorker = (): void => {
    if (!ended) wake.openUnsafe();
  };

  /**
   * Checks whether files attributed to a session may not have reached a
   * controller: they were not sent on the connection that is up now, and the
   * controller there reads them, or no connection is up.
   */
  const hasUnsentEdits = (sessionId: string, session: ObservedSession): boolean => {
    if (session.attributed.size === 0) return false;
    const attached = readAttachedConnection();
    if (attached === undefined) return true;
    if (!attached.readsFilesEdited) return false;
    const sent =
      reported?.connection === attached.connection ? reported.sent.get(sessionId) : undefined;
    return (sent?.size ?? 0) < session.attributed.size;
  };

  /**
   * Forgets the sessions that exited and are owed nothing, with their
   * windows, and ends the watch when none is left. A session that exited
   * stays while a listing is due, because the files it changed are not
   * attributed yet, and while files attributed to it may not have reached a
   * controller.
   */
  const pruneAndEndIfDone = (): void => {
    if (ended || windows.hasClosedWindows()) return;
    for (const [sessionId, session] of sessions) {
      if (session.exited && !hasUnsentEdits(sessionId, session)) {
        sessions.delete(sessionId);
        windows.forgetSessionWindows(sessionId);
      }
    }
    if (sessions.size > 0) return;
    ended = true;
    onEnded();
  };

  /**
   * Handles a listing that failed. The state and the windows stay, so the next
   * listing covers the same changes with the same windows. The listing stays
   * due, unless no live session is left that a later listing could be for.
   */
  const handleListingFailure = (reason: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      yield* Effect.logDebug(`edit listing dropped: ${reason}`);
      if ([...sessions.values()].every((session) => session.exited)) {
        // Only exited sessions are left. Waiting for a later listing would
        // keep the watch alive for nothing.
        windows.forgetWindowsClosedBefore(Infinity);
        return yield* Effect.logWarning(
          `Dropped the edits that the last commands of exited sessions made: the listing failed (${reason}) and no live session is left to try again`,
        );
      }
      yield* Effect.logWarning(
        `Could not list the edits made by shell commands: ${reason}. The next command that finishes tries again`,
      );
    });

  /**
   * Lists the changes since the previous listing and attributes each file to
   * the session whose window holds its ctime. The ctimes are read first and
   * the windows after, which is the order the module header explains. When
   * the listing fails or times out, nothing is forgotten.
   */
  const listAndAttribute = (connection: EditWatchConnection): Effect.Effect<void> =>
    Effect.gen(function* () {
      const listingNumber = windows.startListing();
      // Taken before git runs: a file git sees as deleted or moved was still
      // in its old place at the previous listing's mark, and the next listing
      // compares with this one.
      const startedAtNs = clock.takeMark();
      const listed = yield* Effect.result(
        listChangesSince(previousStates, buildSubstrateEnv(connection.machine.baseEnv)),
      );
      if (listed._tag === "Failure") return yield* handleListingFailure(listed.failure);
      // Taken after git and the ctimes, before the windows are read: a file
      // deleted by now went before this mark.
      const scannedAtNs = clock.takeMark();
      const { files, states } = listed.success;
      const { credited, ambiguous, unattributed, unknownOrigin } = attributeChangedFiles(
        files,
        windows.buildCommandWindows(sessions),
        { previousListingStartedAtNs, scannedAtNs },
      );
      // A window exists only for a session the watch keeps: removing a
      // session forgets its windows.
      for (const { file, sessionId } of credited) {
        sessions.get(sessionId)!.attributed.set(buildFileKey(file.file), file.file);
      }
      if (ambiguous.length > 0) {
        yield* Effect.logInfo(
          `Dropped ${String(ambiguous.length)} changed files: commands of several sessions were running while they changed`,
        );
      }
      if (unknownOrigin.length > 0) {
        yield* Effect.logInfo(
          `Dropped ${String(unknownOrigin.length)} changed files: a git command that may bring in other content was running while they changed`,
        );
      }
      if (unattributed.length > 0) {
        yield* Effect.logInfo(
          `Dropped ${String(unattributed.length)} changed files: no session's command was running while they changed`,
        );
      }
      yield* Effect.logDebug(
        `edit listing: ${String(files.length)} changed files, ${String(credited.length)} credited, ${String(ambiguous.length)} ambiguous, ${String(unknownOrigin.length)} of unknown origin`,
      );
      previousStates = states;
      previousListingStartedAtNs = startedAtNs;
      windows.forgetWindowsClosedBefore(listingNumber);
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
   * Does one round of the worker: runs the listing that is due, then sends
   * the files that the connection attached now has not received, then
   * forgets what is done. The connection is read again after the
   * listing, because a listing can outlive the connection it started on.
   */
  const runOnePass = Effect.gen(function* () {
    const beforeListing = readAttachedConnection();
    if (beforeListing !== undefined && windows.hasClosedWindows()) {
      if (beforeListing.readsFilesEdited) {
        yield* listAndAttribute(beforeListing.connection);
      } else {
        // A controller without the capability is owed nothing, so a listing
        // that waited for a connection is dropped.
        windows.forgetWindowsClosedBefore(Infinity);
        yield* Effect.logInfo(
          "Dropped the edits made by shell commands: the controller does not read them",
        );
      }
    }
    const afterListing = readAttachedConnection();
    if (afterListing?.readsFilesEdited === true) yield* sendUnsentEdits(afterListing.connection);
    pruneAndEndIfDone();
  });

  const runWorker = Effect.gen(function* () {
    while (!ended) {
      yield* wake.await;
      wake.closeUnsafe();
      yield* runOnePass;
    }
  });

  /** Checks whether the watch records windows for the session: it is part of the watch, has not exited, and the workspace is observed. */
  const isObserved = (sessionId: string): boolean => {
    const session = sessions.get(sessionId);
    return session !== undefined && !session.exited && unobservedReason === undefined;
  };

  return Effect.gen(function* () {
    if (unobservedReason !== undefined) {
      yield* Effect.logInfo(
        `Edits made by shell commands are not observed in this workspace: ${unobservedReason}`,
      );
    }
    yield* Effect.forkScoped(runWorker);
    const watch: EditWatch = {
      addSession: (sessionId, sessionMarksDir) => {
        // A session that starts again under the same id keeps what was
        // attributed to it, and gets the marks directory of its new start.
        const existing = sessions.get(sessionId);
        if (existing !== undefined) {
          existing.exited = false;
          existing.sessionMarksDir = sessionMarksDir;
          return;
        }
        sessions.set(sessionId, {
          sessionMarksDir,
          attributed: new Map(),
          joinedAtNs: clock.takeMark(),
          exited: false,
        });
      },

      observeEvent: (event) =>
        Effect.gen(function* () {
          if (!isObserved(event.sessionId)) return;
          if (windows.recordEvent(event).startWasUnknown) {
            yield* Effect.logWarning(
              `The start of a command or edit of session ${event.sessionId} is unknown, because the harness's start hook did not record it. It is taken to have started when the session joined the workspace`,
            );
          }
          // A listing is due once a window closed.
          if (event._tag === "item.completed" && windows.hasClosedWindows()) wakeWorker();
        }),

      takeAllowMark: (sessionId, requestId) => {
        if (isObserved(sessionId)) windows.recordAllow(sessionId, requestId);
      },

      recordToolStart: (sessionId, toolUseId, shellCommand) => {
        if (isObserved(sessionId)) {
          windows.recordStartMark(sessionId, {
            toolUseId,
            startNs: clock.takeMark(),
            shellCommand,
          });
        }
      },
      recordRequestOnRunningItem: (sessionId, requestId) => {
        if (isObserved(sessionId)) windows.recordRequestOnRunningItem(sessionId, requestId);
      },

      recordProcessStart: (sessionId, itemId) => {
        if (isObserved(sessionId)) windows.recordProcessStarted(sessionId, itemId);
      },

      recordProcessEnd: (sessionId, itemId) => {
        if (!isObserved(sessionId)) return;
        windows.recordProcessEnded(sessionId, itemId);
        wakeWorker();
      },

      requestReport: wakeWorker,

      removeSession: (sessionId) => {
        const session = sessions.get(sessionId);
        if (session === undefined) return;
        // The session stops mid-command when windows are open, and git has
        // not seen what it wrote so far. The session stays until that
        // listing is done.
        if (isObserved(sessionId)) windows.closeSessionWindows(sessionId);
        // Set before the worker wakes, so the pass it runs can forget the session.
        session.exited = true;
        wakeWorker();
      },
    };
    return watch;
  });
};
