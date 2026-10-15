/**
 * The observation of one session's edits made by shell commands (spec 19
 * section 4.1). The watch decides when to check, remembers what it already
 * sent, and ends once an exited session has nothing left to deliver. What a
 * check finds is `checkout-edits.ts`'s work.
 */
import type { ProviderEvent, RunnerToController } from "@hercule/protocol";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import { buildSubstrateEnv } from "../workspaces";
import { listSessionEdits, SHARED_WORKSPACE_REASON, type ChangeBaseline } from "./checkout-edits";
import { convertEditedFiles, type SessionCheckout } from "./edited-files";

/**
 * Tells whether `event` reports a command that ran to its end. A failed
 * command can still have changed files. A declined one never ran.
 */
export const isFinishedCommand = (event: ProviderEvent): boolean =>
  event._tag === "item.completed" &&
  event.kind === "command_execution" &&
  event.status !== "declined";

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
 * The observation of one session's edits made by shell commands. It belongs
 * to the session, and outlives it until the last check it owes has reached a
 * controller.
 */
export interface EditWatch {
  /**
   * Reports the files the session changed that were not yet sent on the
   * current connection, without waiting for git. When the session's edits
   * are not observed, warns once instead. Call it after a command ran to its
   * end (see `isFinishedCommand`).
   */
  readonly reportNewEdits: () => Effect.Effect<void>;
  /**
   * Stops observing the session's edits for good, because git cannot tell
   * which session changed a file in a shared workspace. Call it when another
   * live session starts in the session's workspace. The warning goes out with
   * the next finished command.
   */
  readonly stopObservingEdits: () => void;
  /**
   * Reports every file the session changed to the connection that just
   * attached, without waiting for git. Frames are never replayed, and no
   * command may come to ask for a check. Does not warn, and does nothing once
   * the watch has ended.
   */
  readonly reportEditsToNewConnection: () => Effect.Effect<void>;
  /**
   * Ends the watch now, or once its pending check is done. Call it when the
   * session has exited. A check that is running, or that was cut off or asked
   * for while no connection was up, still runs to the end. The watch then
   * calls `onEnded`.
   */
  readonly endAfterPendingCheck: () => void;
}

/**
 * Returns the watch of a session that works in `checkouts`, measured against
 * `baseline`. Never fails. `cwd` is the session's working directory, which the
 * paths of edited files are resolved against. A session without checkouts is
 * never observed, and never warned about.
 *
 * - `readAttachedConnection` returns the connection that is up now, or
 *   undefined. It is read on every request, so a connection that attaches at
 *   any moment is used.
 * - `warn` sends the one warning, with the reason in plain words.
 * - `onEnded` is called once, when the session has exited and no check is owed.
 *
 * A check lists the files the session changed and sends the ones not yet sent
 * on this connection, in `filesEdited` frames. A listing that fails or times
 * out is dropped, and the next command tries again. At most one check runs at
 * a time. It runs forked in the connection's scope, outside the session's
 * event loop, because git can take a while.
 */
export const startEditWatch = (
  checkouts: ReadonlyArray<SessionCheckout>,
  baseline: ChangeBaseline,
  options: {
    readonly sessionId: string;
    readonly cwd: string;
    readonly readAttachedConnection: () => AttachedConnection | undefined;
    readonly warn: (message: string) => Effect.Effect<void>;
    readonly onEnded: () => void;
  },
): EditWatch => {
  const { sessionId, cwd, readAttachedConnection, warn, onEnded } = options;
  let measuredAgainst = baseline;
  // The paths sent on one connection. On any other connection none were sent,
  // because a frame lost with its connection is never replayed.
  let reported:
    | { readonly connection: EditWatchConnection; readonly paths: Set<string> }
    | undefined;
  // Where the check is. `queued` means a command finished during the running
  // check, so one more check follows it.
  let check: "idle" | "running" | "queued" = "idle";
  // Whether a check was asked for and has not finished on a connection that is
  // still up. A watch of an exited session ends only when this is false.
  let checkPending = false;
  let warned = false;
  let exited = false;
  let ended = false;

  /** Ends the watch once the session has exited and no check is pending. */
  const endIfDone = (): void => {
    if (!exited || checkPending || ended) return;
    ended = true;
    onEnded();
  };

  /**
   * Checks once for files the session changed and sends the ones not sent
   * before, `MAX_EDITED_FILES` at a time. A file counts as sent only once its
   * frame has been written, so nothing is lost when a listing is longer than
   * one frame holds.
   */
  const sendNewEdits = (checked: EditWatchConnection): Effect.Effect<void> =>
    Effect.gen(function* () {
      const before = measuredAgainst;
      if (before._tag !== "taken") return;
      const listed = yield* Effect.result(
        listSessionEdits(before.checkouts, buildSubstrateEnv(checked.machine.baseEnv)),
      );
      if (listed._tag === "Failure") {
        return yield* Effect.logDebug(`edit check dropped for ${sessionId}: ${listed.failure}`);
      }
      // The session may have lost its observation while git ran.
      if (measuredAgainst._tag !== "taken") return;
      // On a connection the watch has not reported on, nothing was sent yet.
      if (reported?.connection !== checked) reported = { connection: checked, paths: new Set() };
      const sent = reported.paths;
      // Distinct, because the conversion counts what it did not check among
      // distinct paths, and the slicing below relies on the same count.
      let remaining = [...new Set(listed.success)].filter((path) => !sent.has(path));
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
    });

  /**
   * Runs `sendNewEdits` and repeats it while commands finish meanwhile.
   *
   * Whether to run again or to stop is decided in one synchronous step, so a
   * request that comes in between cannot be lost. A check cut off with its
   * connection leaves `checkPending` set, so the next connection checks again.
   */
  const runChecks = (checked: EditWatchConnection): Effect.Effect<void> =>
    Effect.gen(function* () {
      let again = true;
      while (again) {
        yield* sendNewEdits(checked);
        again = yield* Effect.sync(() => {
          if (check === "queued") {
            check = "running";
            return true;
          }
          check = "idle";
          // A connection that ended may have dropped the frames.
          if (readAttachedConnection()?.connection === checked) checkPending = false;
          endIfDone();
          return false;
        });
      }
    }).pipe(
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          check = "idle";
        }),
      ),
    );

  /**
   * Asks for a check without delaying the caller. Does nothing for a session
   * without checkouts or whose edits are not observed. Without a connection,
   * the check stays pending for the next one.
   */
  const requestCheck = (): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (checkouts.length === 0 || measuredAgainst._tag !== "taken") return Effect.void;
      const attached = readAttachedConnection();
      if (attached === undefined) {
        checkPending = true;
        return Effect.void;
      }
      if (!attached.readsFilesEdited) {
        // A controller without the capability is owed nothing, so a check that
        // waited for a connection is dropped.
        checkPending = false;
        endIfDone();
        return Effect.void;
      }
      checkPending = true;
      if (check !== "idle") {
        check = "queued";
        return Effect.void;
      }
      check = "running";
      return Effect.asVoid(
        Effect.forkIn(runChecks(attached.connection), attached.connection.scope),
      );
    });

  /**
   * Sends one warning when edits made by shell commands cannot be observed:
   * no baseline could be taken, the workspace is shared, or the controller does
   * not read `filesEdited`. Does nothing without a connection, for a session
   * whose edits are observed, or after the first warning.
   */
  const warnWhenUnobserved = (): Effect.Effect<void> =>
    Effect.suspend(() => {
      const attached = readAttachedConnection();
      if (attached === undefined || checkouts.length === 0) return Effect.void;
      const reason =
        measuredAgainst._tag === "unavailable"
          ? measuredAgainst.reason
          : attached.readsFilesEdited
            ? undefined
            : "the controller does not read them";
      if (reason === undefined || warned) return Effect.void;
      warned = true;
      return warn(
        `Edits made by shell commands are not observed for this session: ${reason}. Edits made with the edit tools still are.`,
      );
    });

  return {
    reportNewEdits: () => Effect.andThen(warnWhenUnobserved(), requestCheck()),
    stopObservingEdits: () => {
      measuredAgainst = { _tag: "unavailable", reason: SHARED_WORKSPACE_REASON };
      // Nothing is observed any more, so no check is pending.
      checkPending = false;
      endIfDone();
    },
    reportEditsToNewConnection: () => Effect.suspend(() => (ended ? Effect.void : requestCheck())),
    endAfterPendingCheck: () => {
      exited = true;
      endIfDone();
    },
  };
};
