/**
 * The observation of the edits that shell commands make in one workspace
 * (spec 19 section 4.1). A shell command names no files, and git cannot tell
 * which session changed a file. So the watch looks at the workspace, not at a
 * session, and decides who made a change by who was busy while it happened:
 *
 * - After a session's command finished, git lists what changed since the
 *   previous listing. `checkout-edits.ts` lists the changes.
 * - When exactly one session was busy in the window of that listing, the
 *   changes are that session's.
 * - When several were, the changes cannot be told apart. They are dropped, and
 *   each of those sessions is warned once.
 *
 * A window is the time from the start of one listing to the start of the
 * next. The watch keeps the items that can write files (commands and edits)
 * that were started, completed or cut off in the current window, and each
 * listing takes the window as it was when the listing started. An item still
 * running at that moment also belongs to the next window.
 *
 * One worker fiber does all the work that waits: listing, sending files and
 * sending warnings. Events only record what happened and wake the worker, and
 * the worker reads the connection that is attached when it sends, so a
 * connection that closes or attaches never interrupts a listing.
 */
import type { EditedFile, ProviderEvent, RunnerToController } from "@hercule/protocol";
import { MAX_EDITED_FILES } from "@hercule/protocol";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import type * as Scope from "effect/Scope";
import { buildSubstrateEnv } from "../workspaces";
import { listChangesSince, type CheckoutState, type InitialState } from "./checkout-edits";

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
 * attributed to the last of them has reached a controller.
 */
export interface EditWatch {
  /** Adds a session that was placed in the workspace. It takes no state of its own. */
  readonly addSession: (sessionId: string) => void;
  /**
   * Records what the event says about the items of its agent, and wakes the
   * worker when a command finished or an agent's turn ended with items still
   * open. It does not wait for git.
   */
  readonly observeEvent: (event: ProviderEvent) => Effect.Effect<void>;
  /**
   * Wakes the worker. It sends the attached connection every attributed file
   * and warning it has not received, and runs a listing that is still wanted.
   * Call it when a connection attaches: frames are never replayed.
   */
  readonly requestReport: () => Effect.Effect<void>;
  /**
   * Marks a session as exited. Its running items become items that ended
   * unfinished, and a listing is wanted first, so its partial edits are
   * attributed while it is still part of the watch. The watch forgets an
   * exited session once the files attributed to it have reached a controller,
   * and ends when no session is left.
   */
  readonly removeSession: (sessionId: string) => Effect.Effect<void>;
}

/**
 * What the watch knows about one item that can write files:
 *
 * - `open`: it started and runs.
 * - `parked`: it waits on a Request, so it has not run.
 * - `denied`: its Request was denied or cancelled, so it will not run.
 * - `completed`: it ran to its end, with any status except declined.
 * - `unfinished`: its agent's turn or its session ended while it ran, so it
 *   may have written files.
 */
type ItemState = "open" | "parked" | "denied" | "completed" | "unfinished";

/** An item that can write files, as the watch tracks it in a window. */
interface WatchedItem {
  readonly sessionId: string;
  state: ItemState;
}

type WarningKind = "unobserved" | "overlap" | "listingFailed";

/** What the watch knows about one session of the workspace. */
interface WatchedSession {
  /** The files attributed to this session, by resource id and path. */
  readonly attributed: Map<string, EditedFile>;
  /** The warnings to write to this session's stream, by kind. */
  readonly pendingWarnings: Map<WarningKind, string>;
  /** The kinds of warning already written. Each kind is written once per session. */
  readonly sentWarnings: Set<WarningKind>;
  /** Whether a command of this session finished since the watch last looked at whether commands are observed. */
  ranCommand: boolean;
  exited: boolean;
}

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
 * Tells whether an item in this state may have written files, which makes its
 * session busy. A parked or denied item has not run.
 */
const mayHaveWritten = (state: ItemState): boolean =>
  state === "open" || state === "completed" || state === "unfinished";

/** Tells whether an item in this state has started and not completed, so it belongs to the next window too. */
const isStillOpen = (state: ItemState): boolean =>
  state === "open" || state === "parked" || state === "denied";

/** Builds the key of an item: its session, its agent (empty for the session's own) and its id. */
const buildItemKey = (sessionId: string, agent: string, itemId: string): string =>
  `${sessionId}\0${agent}\0${itemId}`;

const buildFileKey = (file: EditedFile): string => `${file.resourceId}\0${file.path}`;

/**
 * Returns the watch of a workspace, and starts its worker fiber in the scope
 * it is given. `initialState` is the state of the workspace's checkouts
 * before any session ran there, which the first listing is compared with. The
 * caller adds the first session right after.
 *
 * - `readAttachedConnection` returns the connection that is up now, or
 *   undefined. The worker reads it each time it sends, so a connection that
 *   attaches at any moment is used.
 * - `warn` writes one warning on the stream of one session, in plain words,
 *   and returns whether it was written. A warning that was not written stays
 *   pending for the next time the worker runs.
 * - `onEnded` is called once, when the last session is gone and nothing is
 *   owed. The worker ends with it.
 */
export const startEditWatch = (
  initialState: InitialState,
  options: {
    readonly readAttachedConnection: () => AttachedConnection | undefined;
    readonly warn: (sessionId: string, message: string) => Effect.Effect<boolean>;
    readonly onEnded: () => void;
  },
): Effect.Effect<EditWatch, never, Scope.Scope> => {
  const { readAttachedConnection, warn, onEnded } = options;
  const sessions = new Map<string, WatchedSession>();
  const unobservedReason = initialState._tag === "unavailable" ? initialState.reason : undefined;
  // The checkouts as they were at the last successful listing, or at the first state.
  let previousStates: ReadonlyArray<CheckoutState> =
    initialState._tag === "taken" ? initialState.checkouts : [];
  // The current window: its items by item key.
  let itemsInWindow = new Map<string, WatchedItem>();
  // The item each open Request is about, by request id. A `request.resolved`
  // event names only the Request.
  const itemKeyByRequestId = new Map<string, string>();
  // The files sent on one connection. On any other connection none were sent,
  // because a frame lost with its connection is never replayed.
  let reported:
    | {
        readonly connection: EditWatchConnection;
        readonly sent: Map<string, Set<string>>;
      }
    | undefined;
  // Whether a command finished or an item was cut off, and the listing that
  // follows has not run to its end.
  let listingWanted = false;
  let ended = false;
  // Open while the worker has something to look at. Many wakes while the
  // worker runs collapse into one more pass.
  const wake = Latch.makeUnsafe(false);

  const wakeWorker = (): void => {
    if (!ended) wake.openUnsafe();
  };

  /**
   * Returns the current window and starts the next one, which holds the items
   * of the current one that are still open. Open items are copied, so the
   * returned window keeps them as they were when the listing started.
   */
  const startNextWindow = (): ReadonlyMap<string, WatchedItem> => {
    const window = itemsInWindow;
    itemsInWindow = new Map(
      [...window]
        .filter(([, item]) => isStillOpen(item.state))
        .map(([key, item]) => [key, { ...item }]),
    );
    for (const [requestId, itemKey] of itemKeyByRequestId) {
      if (!itemsInWindow.has(itemKey)) itemKeyByRequestId.delete(requestId);
    }
    return window;
  };

  /**
   * Puts the items of a window whose listing failed back into the current
   * window, so the next listing, which covers the same changes, counts them.
   * Open items are in the current window already.
   */
  const returnWindow = (window: ReadonlyMap<string, WatchedItem>): void => {
    for (const [key, item] of window) {
      if (!isStillOpen(item.state) && !itemsInWindow.has(key)) itemsInWindow.set(key, item);
    }
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
   * when none is left. A session that exited stays while a listing is wanted,
   * because the files it changed are not attributed yet.
   */
  const pruneAndEndIfDone = (): void => {
    if (ended || listingWanted) return;
    for (const [sessionId, session] of sessions) {
      if (session.exited && !isOwed(sessionId, session)) sessions.delete(sessionId);
    }
    if (sessions.size > 0) return;
    ended = true;
    onEnded();
  };

  /**
   * Queues a warning for each of the sessions, unless that kind was already
   * written to it. A session that exited but is still part of the watch is
   * queued too.
   */
  const queueWarning = (sessionIds: Iterable<string>, kind: WarningKind, message: string): void => {
    for (const sessionId of sessionIds) {
      const session = sessions.get(sessionId);
      if (session !== undefined && !session.sentWarnings.has(kind)) {
        session.pendingWarnings.set(kind, message);
      }
    }
  };

  /**
   * Lists the changes since the previous listing and attributes them to the
   * session that was busy in `window`. When the listing fails or times out,
   * the state stays and the window is returned, so the next listing covers
   * the same changes with the same sessions. The listing stays wanted, unless
   * no session is left that a later listing could be for.
   */
  const listAndAttribute = (
    window: ReadonlyMap<string, WatchedItem>,
    connection: EditWatchConnection,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const listed = yield* Effect.result(
        listChangesSince(previousStates, buildSubstrateEnv(connection.machine.baseEnv)),
      );
      if (listed._tag === "Failure") {
        yield* Effect.logDebug(`edit check dropped: ${listed.failure}`);
        const live = [...sessions].filter(([, session]) => !session.exited).map(([id]) => id);
        if (live.length === 0) {
          // Only exited sessions are left, and nobody can be warned. Waiting
          // for a later listing would keep the watch alive for nothing.
          listingWanted = false;
          return yield* Effect.logWarning(
            `Dropped the edits that the last commands of exited sessions made: the listing failed (${listed.failure}) and no live session is left to try again`,
          );
        }
        listingWanted = true;
        returnWindow(window);
        queueWarning(
          live,
          "listingFailed",
          `Edits made by shell commands could not be listed just now: ${listed.failure}. The next command that finishes tries again, and the changes made meanwhile are not lost.`,
        );
        return;
      }
      const { files, states } = listed.success;
      previousStates = states;
      const busy = new Set(
        [...window.values()]
          .filter((item) => mayHaveWritten(item.state))
          .map((item) => item.sessionId),
      );
      if (busy.size === 1) {
        const session = sessions.get([...busy][0]!);
        for (const file of files) session?.attributed.set(buildFileKey(file), file);
      }
      // Nothing was dropped when nothing changed, so nobody is warned.
      if (busy.size > 1 && files.length > 0) {
        queueWarning(
          busy,
          "overlap",
          "Edits made by shell commands while another session in the workspace worked at the same time are not observed, because git cannot tell which session made them. Edits made with the edit tools still are.",
        );
      }
      if (busy.size === 0 && files.length > 0) {
        yield* Effect.logInfo(
          `Dropped ${String(files.length)} changed files: no session was busy while they changed`,
        );
      }
      yield* Effect.logDebug(
        `edit check: ${String(files.length)} changed files, ${String(busy.size)} sessions busy`,
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
   * Writes the pending warnings of every session, and queues the warning of a
   * session whose commands cannot be observed (the workspace is the main one,
   * no state could be taken, or the controller does not read `filesEdited`).
   * A warning counts as written only when `warn` says so. When one is not
   * written, the connection is closing, so nothing more is written, and the
   * rest stays pending.
   */
  const sendPendingWarnings = (attached: AttachedConnection): Effect.Effect<void> =>
    Effect.gen(function* () {
      const reason =
        unobservedReason ??
        (attached.readsFilesEdited ? undefined : "the controller does not read them");
      for (const [sessionId, session] of [...sessions]) {
        if (session.ranCommand) {
          session.ranCommand = false;
          if (reason !== undefined) {
            queueWarning(
              [sessionId],
              "unobserved",
              `Edits made by shell commands are not observed for this session: ${reason}. Edits made with the edit tools still are.`,
            );
          }
        }
        for (const [kind, message] of [...session.pendingWarnings]) {
          if (!(yield* warn(sessionId, message))) return;
          session.pendingWarnings.delete(kind);
          session.sentWarnings.add(kind);
        }
      }
    });

  /**
   * Does one round of the worker: runs the wanted listing, then sends the
   * files and warnings that the connection attached now has not received, then
   * forgets what is done. The connection is read again after the listing,
   * because a listing can outlive the connection it started on.
   */
  const runOnePass = Effect.gen(function* () {
    const beforeListing = readAttachedConnection();
    if (beforeListing !== undefined && listingWanted) {
      if (beforeListing.readsFilesEdited) {
        listingWanted = false;
        yield* listAndAttribute(startNextWindow(), beforeListing.connection);
      } else {
        // A controller without the capability is owed nothing, so a listing
        // that waited for a connection is dropped.
        listingWanted = false;
        startNextWindow();
      }
    }
    const afterListing = readAttachedConnection();
    if (afterListing !== undefined) {
      if (afterListing.readsFilesEdited) yield* sendUnsentEdits(afterListing.connection);
      yield* sendPendingWarnings(afterListing);
    }
    pruneAndEndIfDone();
  });

  const runWorker = Effect.gen(function* () {
    while (!ended) {
      yield* wake.await;
      wake.closeUnsafe();
      yield* runOnePass;
    }
  });

  /** Records the state of an item that can write files. */
  const setItemState = (key: string, sessionId: string, state: ItemState): void => {
    itemsInWindow.set(key, { sessionId, state });
  };

  /**
   * Ends the items of one session that are still running, or of one agent of
   * it, so they count as items that may have written files. Items that wait on
   * a Request or were denied never ran, and are dropped. Wants a listing when
   * any item ended unfinished, because its writes have not been listed.
   */
  const endItems = (sessionId: string, agent: string | undefined): void => {
    const prefix = agent === undefined ? `${sessionId}\0` : `${sessionId}\0${agent}\0`;
    let cutOff = false;
    for (const [key, item] of itemsInWindow) {
      if (!key.startsWith(prefix)) continue;
      if (item.state === "open") {
        item.state = "unfinished";
        cutOff = true;
      } else if (item.state === "parked" || item.state === "denied") {
        itemsInWindow.delete(key);
      }
    }
    if (cutOff) listingWanted = true;
    wakeWorker();
  };

  return Effect.gen(function* () {
    yield* Effect.forkScoped(runWorker);
    const watch: EditWatch = {
      addSession: (sessionId) => {
        // A session that starts again under the same id keeps what was attributed to it.
        const existing = sessions.get(sessionId);
        if (existing !== undefined) {
          existing.exited = false;
          return;
        }
        sessions.set(sessionId, {
          attributed: new Map(),
          pendingWarnings: new Map(),
          sentWarnings: new Set(),
          ranCommand: false,
          exited: false,
        });
      },

      observeEvent: (event) =>
        Effect.sync(() => {
          const session = sessions.get(event.sessionId);
          if (session === undefined || session.exited) return;
          const agent = "subagentId" in event ? (event.subagentId ?? "") : "";
          switch (event._tag) {
            case "item.started":
              if (unobservedReason === undefined && canWriteFiles(event.kind)) {
                setItemState(
                  buildItemKey(event.sessionId, agent, event.itemId),
                  event.sessionId,
                  "open",
                );
              }
              return;
            case "request.opened": {
              const key = buildItemKey(event.sessionId, agent, event.request.itemId);
              const item = itemsInWindow.get(key);
              if (item?.state !== "open") return;
              item.state = "parked";
              itemKeyByRequestId.set(event.request.requestId, key);
              return;
            }
            case "request.resolved": {
              const key = itemKeyByRequestId.get(event.requestId);
              if (key === undefined) return;
              itemKeyByRequestId.delete(event.requestId);
              const item = itemsInWindow.get(key);
              if (item?.state !== "parked") return;
              // A denied command never runs. An allowed one may run now.
              const isDenied =
                "decision" in event && (event.decision === "deny" || event.decision === "cancel");
              item.state = isDenied ? "denied" : "open";
              return;
            }
            case "item.completed": {
              if (!canWriteFiles(event.kind)) return;
              const key = buildItemKey(event.sessionId, agent, event.itemId);
              // A declined item never ran. Only that item is forgotten, so
              // what else the session did in the window stays.
              if (event.status === "declined") {
                itemsInWindow.delete(key);
                return;
              }
              // Anything else that completes ran, even without a start.
              if (unobservedReason === undefined) {
                setItemState(key, event.sessionId, "completed");
              }
              if (event.kind !== "command_execution") return;
              session.ranCommand = true;
              if (unobservedReason === undefined) listingWanted = true;
              wakeWorker();
              return;
            }
            case "turn.completed":
              // Only this agent's items end with its turn. A subagent can
              // outlive the turn of the session's own agent, and the other
              // way around. Not every harness completes the items of an
              // interrupted turn, and one that does (Claude Code) may do it
              // after the turn ended, so what is still open may have written.
              endItems(event.sessionId, agent);
              return;
            default:
              return;
          }
        }),

      requestReport: () => Effect.sync(wakeWorker),

      removeSession: (sessionId) =>
        Effect.sync(() => {
          const session = sessions.get(sessionId);
          if (session === undefined) return;
          session.exited = true;
          // The session stops mid-command when items are open, and git has not
          // seen what it wrote so far. The session stays until that listing is done.
          endItems(sessionId, undefined);
        }),
    };
    return watch;
  });
};
