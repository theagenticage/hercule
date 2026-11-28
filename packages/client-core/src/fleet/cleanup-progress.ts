/**
 * How a cleanup moves from the press of the button to its end, as plain data:
 * what the dialog shows of it (`CleanupProgress`), the changes that move it
 * (`CleanupChange`), and `applyCleanupChange`, which returns the progress
 * after one change. Nothing here reads a cache or a clock: the desktop's
 * store feeds it the answers of `archiveAndRemoveWorkspaces` and
 * `requestRemovals` and the workspaces it reads, and draws what comes back.
 *
 * This module is its own subpath (`@hercule/client-core/cleanup-progress`)
 * and is not re-exported from the package index, like `cleanup.ts`.
 */
import { USED_SINCE_LOOKED_REFUSAL, type Workspace } from "@hercule/contract";
import type { CleanupRow, CleanupStart, RemovalAnswer } from "./cleanup";
import { formatDiskSize, plural } from "./machine";

/**
 * Where one removal stands: `removing` while the runner works on it,
 * `removed` once the workspace is deleted, `refused` when it stays. A refused
 * outcome has the reason to show under the row and whether the row offers Try
 * again: `retry` is false for a workspace used since the dialog showed it,
 * because asking again with the same `expectedLastUsedAt` can only be refused
 * again.
 */
export type RemovalOutcome =
  | { readonly kind: "removing" }
  | { readonly kind: "removed" }
  | { readonly kind: "refused"; readonly message: string; readonly retry: boolean };

/** The words that tell the user how a cleanup ended. See `describeCleanupOutcome`. */
export interface CleanupOutcomeWords {
  /**
   * Whether every workspace was removed: the words are then the page's toast,
   * else the first line under the dialog's title.
   */
  readonly allRemoved: boolean;
  readonly text: string;
}

/** What the dialog shows of a cleanup, from the moment the button is pressed. */
export type CleanupProgress =
  /** The Threads are being archived and the removal is being asked for. */
  | { readonly kind: "starting"; readonly rows: readonly CleanupRow[] }
  /** Nothing was removed: the archive was refused or failed. `message` says why. */
  | {
      readonly kind: "stopped";
      readonly rows: readonly CleanupRow[];
      readonly message: string;
    }
  /**
   * The Threads are archived and the removals were asked for. `outcomes` has
   * one outcome for each of `rows`. `result` is `null` while any is still
   * `removing`, else the words that tell how the cleanup ended.
   */
  | {
      readonly kind: "removing";
      readonly rows: readonly CleanupRow[];
      readonly archivedCount: number;
      readonly outcomes: ReadonlyMap<string, RemovalOutcome>;
      readonly result: CleanupOutcomeWords | null;
      /**
       * The reason to show for each workspace whose removal call failed, so
       * that it is unknown whether it was asked for. See `decideRemovalOutcome`.
       */
      readonly failureMessages: ReadonlyMap<string, string>;
    };

/** One thing that happened to a cleanup. See `applyCleanupChange`. */
export type CleanupChange =
  /** The first answer: `archiveAndRemoveWorkspaces` returned `start`. */
  | { readonly kind: "startAnswered"; readonly start: CleanupStart }
  /** The user pressed Try again on a refused row. */
  | { readonly kind: "retryAsked"; readonly workspaceId: string }
  /** The call that asked again for the removal of `workspaceId` returned `removal`. */
  | {
      readonly kind: "retryAnswered";
      readonly workspaceId: string;
      readonly removal: RemovalAnswer;
    }
  /**
   * A read of the workspaces arrived. It must have begun after the latest
   * answer, because only such a read can tell a workspace that is being
   * removed from one that was refused: a refusal leaves its reason in
   * `Workspace.message`, which asking again does not clear.
   */
  | { readonly kind: "workspacesRead"; readonly workspaces: readonly Workspace[] };

/** The words under a refused row for a workspace that was used after the dialog opened. */
const USED_SINCE_WORDS = "Used since you looked.";

/** The reason shown for a refused removal that came with no message. */
const UNKNOWN_REFUSAL = "The machine did not say why. Try again.";

/** Builds the refused outcome for the controller's or the runner's `message`. */
const buildRefusal = (message: string | null | undefined): RemovalOutcome => {
  if (message === USED_SINCE_LOOKED_REFUSAL) {
    return { kind: "refused", message: USED_SINCE_WORDS, retry: false };
  }
  return {
    kind: "refused",
    message:
      message === null || message === undefined || message === "" ? UNKNOWN_REFUSAL : message,
    retry: true,
  };
};

/** Checks whether two outcomes of one row are the same, so that a read that changes nothing changes nothing. */
const isSameOutcome = (a: RemovalOutcome, b: RemovalOutcome): boolean =>
  a.kind === b.kind &&
  (a.kind !== "refused" ||
    (b.kind === "refused" && a.message === b.message && a.retry === b.retry));

/**
 * Decides where the removal of `workspace` stands, from a workspace read that
 * began after `workspace.disposeMany` answered or failed: `deleted` is
 * removed, `disposing` is still being removed, and any other status means the
 * workspace stayed.
 *
 * A workspace that stayed is refused with its own reason, `Workspace.message`.
 * After a failed call (`removalUnknown`) pass the error's message as
 * `failureMessage`: it is then the reason shown, with `retry` set, because
 * `Workspace.message` may be left over from an earlier attempt.
 */
const decideRemovalOutcome = (
  workspace: Workspace,
  failureMessage: string | null,
): RemovalOutcome => {
  if (workspace.status === "deleted") return { kind: "removed" };
  if (workspace.status === "disposing") return { kind: "removing" };
  return failureMessage === null
    ? buildRefusal(workspace.message)
    : { kind: "refused", message: failureMessage, retry: true };
};

/**
 * Words how a cleanup ended, or returns `null` while any of its `rows` has
 * no outcome yet or is still `removing`. `archivedCount` is what
 * `archiveAndRemoveWorkspaces` archived.
 *
 * - All removed, the page's toast: "Archived 9 threads and removed 6
 *   workspaces. 41 GB freed."
 * - Some or all refused, the first line under the dialog's title: "Archived 9
 *   threads. Removed 4 of 6 workspaces." The archive is always said when it
 *   archived something, because it is never undone.
 *
 * With nothing archived, the archive is left out of the words, and a freed
 * size of 0 is too.
 */
export const describeCleanupOutcome = (
  archivedCount: number,
  rows: readonly CleanupRow[],
  outcomes: ReadonlyMap<string, RemovalOutcome>,
): CleanupOutcomeWords | null => {
  const removedRows: CleanupRow[] = [];
  for (const row of rows) {
    const outcome = outcomes.get(row.workspaceId);
    if (outcome === undefined || outcome.kind === "removing") return null;
    if (outcome.kind === "removed") removedRows.push(row);
  }
  const archived = `${String(archivedCount)} ${plural(archivedCount, "thread", "threads")}`;
  const total = `${String(rows.length)} ${plural(rows.length, "workspace", "workspaces")}`;
  if (removedRows.length === rows.length) {
    const freed = removedRows.reduce((sum, row) => sum + (row.freesBytes ?? 0), 0);
    const removed =
      archivedCount > 0 ? `Archived ${archived} and removed ${total}.` : `Removed ${total}.`;
    return {
      allRemoved: true,
      text: freed === 0 ? removed : `${removed} ${formatDiskSize(freed)} freed.`,
    };
  }
  const removed = `Removed ${String(removedRows.length)} of ${total}.`;
  return {
    allRemoved: false,
    text: archivedCount > 0 ? `Archived ${archived}. ${removed}` : removed,
  };
};

/**
 * Returns the progress after the removal call for `askedIds` returned
 * `removal`. A removal the controller accepts is `removing` until a read of
 * the workspaces settles it. A refused one is refused at once. When the call
 * failed, every asked workspace is `removing` and keeps the error's message
 * as the reason to show if it turns out to have stayed.
 *
 * The first answer sets `archivedCount`. Later answers (Try again) keep it.
 */
const recordRemovalAnswer = (
  progress: Exclude<CleanupProgress, { kind: "stopped" }>,
  askedIds: readonly string[],
  archivedCount: number,
  removal: RemovalAnswer,
): CleanupProgress => {
  const previous = progress.kind === "removing" ? progress : null;
  const failureMessages = new Map(previous?.failureMessages);
  const answered = new Map<string, RemovalOutcome>();
  if (removal.status === "started") {
    for (const { workspaceId, outcome, message } of removal.results) {
      answered.set(
        workspaceId,
        outcome === "requested" ? { kind: "removing" } : buildRefusal(message),
      );
    }
  } else {
    for (const workspaceId of askedIds) {
      answered.set(workspaceId, { kind: "removing" });
      failureMessages.set(workspaceId, removal.message);
    }
  }
  return {
    kind: "removing",
    rows: progress.rows,
    archivedCount: previous?.archivedCount ?? archivedCount,
    outcomes: new Map([...(previous?.outcomes ?? []), ...answered]),
    result: null,
    failureMessages,
  };
};

/**
 * Settles the rows of `progress` that are still `removing` from `workspaces`,
 * and words the result once none is left. Returns `progress` itself when the
 * read changes no row and ends nothing.
 */
const settleFromWorkspaces = (
  progress: Extract<CleanupProgress, { kind: "removing" }>,
  workspaces: readonly Workspace[],
): CleanupProgress => {
  if (progress.result !== null) return progress;
  const byId = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  const outcomes = new Map(progress.outcomes);
  let isChanged = false;
  for (const row of progress.rows) {
    const workspace = byId.get(row.workspaceId);
    const current = outcomes.get(row.workspaceId);
    if (current?.kind !== "removing" || workspace === undefined) continue;
    const decided = decideRemovalOutcome(
      workspace,
      progress.failureMessages.get(row.workspaceId) ?? null,
    );
    if (isSameOutcome(decided, current)) continue;
    outcomes.set(row.workspaceId, decided);
    isChanged = true;
  }
  const result = describeCleanupOutcome(progress.archivedCount, progress.rows, outcomes);
  return isChanged || result !== null ? { ...progress, outcomes, result } : progress;
};

/**
 * Returns the progress of a cleanup after `change`. Returns `progress` itself
 * when the change does not apply or changes nothing, so a caller can tell by
 * identity whether anything happened.
 *
 * - `startAnswered`: a failed archive stops the cleanup (`stopped`).
 *   Otherwise every row has the outcome of its removal request (see
 *   `recordRemovalAnswer`). Applies to a `starting` cleanup.
 * - `retryAsked`: a refused row is `removing` again, and the cleanup has no
 *   result until it settles. Applies only to a refused row.
 * - `retryAnswered`: like `startAnswered`, for one row.
 * - `workspacesRead`: the rows still `removing` are settled from the
 *   workspaces. Applies to a cleanup with no result yet.
 */
export const applyCleanupChange = (
  progress: CleanupProgress,
  change: CleanupChange,
): CleanupProgress => {
  switch (change.kind) {
    case "startAnswered": {
      if (progress.kind !== "starting") return progress;
      if (change.start.status === "archiveFailed") {
        return { kind: "stopped", rows: progress.rows, message: change.start.message };
      }
      return recordRemovalAnswer(
        progress,
        progress.rows.map((row) => row.workspaceId),
        change.start.archivedCount,
        change.start.removal,
      );
    }
    case "retryAsked": {
      if (progress.kind !== "removing") return progress;
      if (progress.outcomes.get(change.workspaceId)?.kind !== "refused") return progress;
      const failureMessages = new Map(progress.failureMessages);
      failureMessages.delete(change.workspaceId);
      return {
        ...progress,
        failureMessages,
        outcomes: new Map(progress.outcomes).set(change.workspaceId, { kind: "removing" }),
        result: null,
      };
    }
    case "retryAnswered":
      return progress.kind === "removing"
        ? recordRemovalAnswer(
            progress,
            [change.workspaceId],
            progress.archivedCount,
            change.removal,
          )
        : progress;
    case "workspacesRead":
      return progress.kind === "removing"
        ? settleFromWorkspaces(progress, change.workspaces)
        : progress;
  }
};
