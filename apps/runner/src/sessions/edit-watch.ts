/**
 * The observation of the edits that shell commands make in one workspace
 * (spec 19 section 4.1). Git cannot tell which session changed a file, so the
 * watch looks at the workspace, not at a session, and decides who made a
 * change by who was busy while it happened. It also decides when to check,
 * remembers what it already sent, and ends once no session is left and
 * nothing is owed. What a check finds is `checkout-edits.ts`'s work.
 */
import type { ProviderEvent, RunnerToController } from "@hercule/protocol";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import { buildSubstrateEnv } from "../workspaces";
import { listChangesSince, type InitialState } from "./checkout-edits";
import { convertEditedFiles, type SessionCheckout } from "./edited-files";

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
   * Tracks which sessions are busy from the events of the session that
   * produced `event`. When a command finished (completed or failed, not
   * declined), also warns the session once if its commands are not observed,
   * and asks for a check without waiting for git.
   */
  readonly observeEvent: (event: ProviderEvent) => Effect.Effect<void>;
  /**
   * Sends the connection that just attached every file attributed to a
   * session that it has not received, and runs the check that is still
   * pending. Frames are never replayed, and no command may come to ask for a
   * check. Does not warn, and does nothing once the watch has ended.
   */
  readonly requestReport: () => Effect.Effect<void>;
  /**
   * Tells the watch that a session exited. The watch keeps the session until
   * the files attributed to it have reached a controller, and ends when its
   * last session is gone.
   */
  readonly removeSession: (sessionId: string) => void;
}

/** What the watch knows about one session of the workspace. */
interface Member {
  /** The items of this session that can write files and have started but not completed. */
  readonly openItems: Set<string>;
  /** The absolute paths of the files attributed to this session. */
  readonly attributed: Set<string>;
  exited: boolean;
  warnedNotObserved: boolean;
  warnedSimultaneous: boolean;
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
 * Tells whether `event` reports a command that ran to its end. A failed
 * command can still have changed files. A declined one never ran.
 */
const isFinishedCommand = (event: ProviderEvent): boolean =>
  event._tag === "item.completed" &&
  event.kind === "command_execution" &&
  event.status !== "declined";

/**
 * Returns the watch of a workspace whose checkouts are `checkouts`, with
 * `initialState` as the state that the first check is compared with. Never
 * fails. `cwd` is the workspace's working directory. A workspace without
 * checkouts is never observed, and never warned about. The caller adds the
 * first session right after.
 *
 * - `readAttachedConnection` returns the connection that is up now, or
 *   undefined. It is read on every request, so a connection that attaches at
 *   any moment is used.
 * - `warn` sends one warning on the stream of one session, in plain words.
 * - `onEnded` is called once, when the last session is gone and nothing is
 *   owed.
 *
 * A check lists the files that changed since the previous check. When exactly
 * one session was busy since then, the files are that session's. When
 * several were, they cannot be told apart: the files are dropped and each of
 * those sessions is warned once. A session counts as busy from the start to
 * the completion of an item that can write files (`canWriteFiles`).
 *
 * The files attributed to a session are sent in `filesEdited` frames, the
 * ones the current connection has not received yet. A listing that fails or
 * times out is dropped, and the next command tries again. At most one check
 * runs at a time. It runs forked in the connection's scope, outside the
 * sessions' event loops, because git can take a while.
 */
export const startEditWatch = (
  checkouts: ReadonlyArray<SessionCheckout>,
  initialState: InitialState,
  options: {
    readonly cwd: string;
    readonly readAttachedConnection: () => AttachedConnection | undefined;
    readonly warn: (sessionId: string, message: string) => Effect.Effect<void>;
    readonly onEnded: () => void;
  },
): EditWatch => {
  const { cwd, readAttachedConnection, warn, onEnded } = options;
  const members = new Map<string, Member>();
  // The checkouts as they were at the last check, or the reason they cannot be observed.
  let state: InitialState = initialState;
  // The sessions that were busy at some point since the last listing finished.
  let busySince = new Set<string>();
  // The files sent on one connection. On any other connection none were sent,
  // because a frame lost with its connection is never replayed.
  let reported:
    | {
        readonly connection: EditWatchConnection;
        readonly sent: Map<string, Set<string>>;
      }
    | undefined;
  // Where the check is. `queued` means a request came during the running
  // check, so one more check follows it.
  let run: "idle" | "running" | "queued" = "idle";
  // Whether a command finished and its listing has not run to its end on a
  // connection that stayed up.
  let listingWanted = false;
  let ended = false;

  /**
   * Tells whether files attributed to a session may not have reached a
   * controller: they were not sent on the connection that is up now, and the
   * controller there reads them, or no connection is up.
   */
  const isOwed = (sessionId: string, member: Member): boolean => {
    if (member.attributed.size === 0) return false;
    const attached = readAttachedConnection();
    if (attached === undefined) return true;
    if (!attached.readsFilesEdited) return false;
    const sent =
      reported?.connection === attached.connection ? reported.sent.get(sessionId) : undefined;
    return (sent?.size ?? 0) < member.attributed.size;
  };

  /**
   * Forgets the sessions that exited and are owed nothing, and ends the watch
   * when none is left. A session that exited stays while a listing is wanted
   * or running, because the files it changed are not attributed yet.
   */
  const pruneAndEndIfDone = (): void => {
    if (ended || run !== "idle" || listingWanted) return;
    for (const [sessionId, member] of members) {
      if (member.exited && !isOwed(sessionId, member)) members.delete(sessionId);
    }
    if (members.size > 0) return;
    ended = true;
    onEnded();
  };

  /** Warns each session once that its commands were not told apart from another session's. */
  const warnSimultaneous = (sessionIds: ReadonlyArray<string>): Effect.Effect<void> =>
    Effect.forEach(
      sessionIds,
      (sessionId) =>
        Effect.suspend(() => {
          const member = members.get(sessionId);
          if (
            member === undefined ||
            member.exited ||
            member.warnedSimultaneous ||
            readAttachedConnection() === undefined
          ) {
            return Effect.void;
          }
          member.warnedSimultaneous = true;
          return warn(
            sessionId,
            "Edits made by shell commands while another session in the workspace worked at the same time are not observed, because git cannot tell which session made them. Edits made with the edit tools still are.",
          );
        }),
      { discard: true },
    );

  /**
   * Lists what changed since the previous check and attributes it. Does
   * nothing when a listing fails or times out: the state stays, so the next
   * listing covers the same changes, and the sessions busy since then still
   * count.
   *
   * The sessions that were busy are read after git finished, so a session
   * that became busy while git ran counts too. Then the set starts again with
   * the sessions that are busy now.
   */
  const listAndAttribute = (checked: EditWatchConnection): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (state._tag !== "taken") return;
      const listed = yield* Effect.result(
        listChangesSince(state.checkouts, buildSubstrateEnv(checked.machine.baseEnv)),
      );
      if (listed._tag === "Failure") {
        return yield* Effect.logDebug(`edit check dropped: ${listed.failure}`);
      }
      const busy = yield* Effect.sync(() => {
        state = { _tag: "taken", checkouts: listed.success.states };
        const busy = [...busySince];
        busySince = new Set(
          [...members].filter(([, member]) => member.openItems.size > 0).map(([id]) => id),
        );
        if (busy.length === 1) {
          const member = members.get(busy[0]!);
          for (const path of listed.success.paths) member?.attributed.add(path);
        }
        return busy;
      });
      yield* warnSimultaneous(busy.length > 1 ? busy : []);
      yield* Effect.logDebug(
        `edit check: ${String(listed.success.paths.length)} changed files, ${String(busy.length)} sessions busy`,
      );
    }).pipe(
      // A listing cut off with its connection is wanted again on the next one.
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          listingWanted = true;
        }),
      ),
    );

  /**
   * Sends every session the files attributed to it that `checked` has not
   * received, `MAX_EDITED_FILES` at a time. A file counts as sent only once
   * its frame has been written, so nothing is lost when there are more files
   * than one frame holds.
   */
  const sendUnsentEdits = (checked: EditWatchConnection): Effect.Effect<void> =>
    Effect.gen(function* () {
      // On a connection the watch has not reported on, nothing was sent yet.
      if (reported?.connection !== checked) reported = { connection: checked, sent: new Map() };
      const connectionSent = reported.sent;
      for (const [sessionId, member] of [...members]) {
        const sent = connectionSent.get(sessionId) ?? new Set<string>();
        connectionSent.set(sessionId, sent);
        let remaining = [...member.attributed].filter((path) => !sent.has(path));
        while (remaining.length > 0) {
          const { files, unchecked } = convertEditedFiles(cwd, checkouts, remaining);
          // The paths the conversion looked at are done, including the ones it
          // dropped as invalid. The rest go into the next frame.
          const examined = remaining.slice(0, remaining.length - unchecked);
          remaining = remaining.slice(remaining.length - unchecked);
          if (files.length > 0) {
            yield* Effect.ignoreCause(
              checked.send({ _tag: "filesEdited", sessionId, editedFiles: files }),
            );
          }
          for (const path of examined) sent.add(path);
        }
      }
    });

  /**
   * Runs the wanted listing, then sends what the connection has not
   * received, and repeats while requests come in meanwhile.
   *
   * Whether to run again or to stop is decided in one synchronous step, so a
   * request that comes in between cannot be lost. A check cut off with its
   * connection leaves its listing wanted, so the next connection lists again.
   */
  const runChecks = (checked: EditWatchConnection): Effect.Effect<void> =>
    Effect.gen(function* () {
      let again = true;
      while (again) {
        const wanted = listingWanted;
        listingWanted = false;
        if (wanted) yield* listAndAttribute(checked);
        yield* sendUnsentEdits(checked);
        again = yield* Effect.sync(() => {
          if (run === "queued") {
            run = "running";
            return true;
          }
          run = "idle";
          pruneAndEndIfDone();
          return false;
        });
      }
    }).pipe(
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          run = "idle";
        }),
      ),
    );

  /**
   * Asks for a check without delaying the caller. Without a connection, the
   * wanted listing stays for the next one.
   */
  const requestCheck = (): Effect.Effect<void> =>
    Effect.suspend(() => {
      // Nothing is ever attributed in a workspace that is not observed.
      if (state._tag !== "taken" || checkouts.length === 0) return Effect.void;
      const attached = readAttachedConnection();
      if (attached === undefined) return Effect.void;
      if (!attached.readsFilesEdited) {
        // A controller without the capability is owed nothing, so a listing
        // that waited for a connection is dropped.
        listingWanted = false;
        pruneAndEndIfDone();
        return Effect.void;
      }
      if (run !== "idle") {
        run = "queued";
        return Effect.void;
      }
      run = "running";
      return Effect.asVoid(
        Effect.forkIn(runChecks(attached.connection), attached.connection.scope),
      );
    });

  /**
   * Sends one warning when edits made by shell commands cannot be observed:
   * the workspace is the main one, no state could be taken, or the controller
   * does not read `filesEdited`. Does nothing without a connection, for a
   * workspace that is observed, or after the session's first warning.
   */
  const warnWhenUnobserved = (sessionId: string, member: Member): Effect.Effect<void> =>
    Effect.suspend(() => {
      const attached = readAttachedConnection();
      if (attached === undefined || checkouts.length === 0) return Effect.void;
      const reason =
        state._tag === "unavailable"
          ? state.reason
          : attached.readsFilesEdited
            ? undefined
            : "the controller does not read them";
      if (reason === undefined || member.warnedNotObserved) return Effect.void;
      member.warnedNotObserved = true;
      return warn(
        sessionId,
        `Edits made by shell commands are not observed for this session: ${reason}. Edits made with the edit tools still are.`,
      );
    });

  return {
    addSession: (sessionId) => {
      // A session that starts again under the same id keeps what was attributed to it.
      const existing = members.get(sessionId);
      if (existing !== undefined) {
        existing.exited = false;
        return;
      }
      members.set(sessionId, {
        openItems: new Set(),
        attributed: new Set(),
        exited: false,
        warnedNotObserved: false,
        warnedSimultaneous: false,
      });
    },

    observeEvent: (event) =>
      Effect.suspend(() => {
        const member = members.get(event.sessionId);
        if (member === undefined || ended) return Effect.void;
        if (event._tag === "turn.completed") {
          // A turn that ended, interrupted or not, leaves no item running.
          if (event.subagentId === undefined) member.openItems.clear();
          return Effect.void;
        }
        if (
          (event._tag !== "item.started" && event._tag !== "item.completed") ||
          !canWriteFiles(event.kind)
        ) {
          return Effect.void;
        }
        // An item that completes without a start was busy too.
        busySince.add(event.sessionId);
        if (event._tag === "item.started") {
          member.openItems.add(event.itemId);
          return Effect.void;
        }
        member.openItems.delete(event.itemId);
        if (!isFinishedCommand(event) || checkouts.length === 0) return Effect.void;
        if (state._tag === "taken") listingWanted = true;
        return Effect.andThen(warnWhenUnobserved(event.sessionId, member), requestCheck());
      }),

    requestReport: () => Effect.suspend(() => (ended ? Effect.void : requestCheck())),

    removeSession: (sessionId) => {
      const member = members.get(sessionId);
      if (member === undefined) return;
      member.exited = true;
      member.openItems.clear();
      pruneAndEndIfDone();
    },
  };
};
