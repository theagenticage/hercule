/**
 * The pure logic behind cleaning up a machine's disk on the desktop Fleet
 * screen: which workspaces are idle candidates, the rows both the machine
 * page's "Largest idle workspaces" and the cleanup dialog draw, the dialog
 * itself, and the archive-then-remove call (spec 17 §A machine's page point 5
 * and §The cleanup dialog). What happens to a cleanup after the press is in
 * `cleanup-progress.ts`.
 *
 * The flow, as the desktop runs it:
 *
 * 1. `listCleanupCandidates` picks the idle workspaces from the shell's list.
 * 2. `readWorkspaceThreads` reads their Threads.
 * 3. `buildCleanupSnapshot` freezes the dialog's rows from both, once, when
 *    the dialog opens. The dialog does not rebuild them as pushes arrive:
 *    what the user saw is what goes.
 * 4. `describeCleanupDialog` draws the snapshot for the set of ticked rows.
 * 5. `archiveAndRemoveWorkspaces` runs the dialog's `plan`.
 *
 * This module is its own subpath (`@hercule/client-core/cleanup`) and is not
 * re-exported from the package index, so the first screen does not carry it.
 */
import {
  MAX_DISPOSE_MANY_ITEMS,
  MAX_SESSION_IDS,
  type Session,
  type Workspace,
  type WorkspaceDisposeManyResult,
} from "@hercule/contract";
import type { HerculeClient } from "../client";
import { ApiError } from "../errors";
import { buildSessionGroups } from "../threads/session-groups";
import { describeAge } from "../threads/age";
import { formatDiskSize } from "./machine";

const DAY_MS = 24 * 60 * 60 * 1000;

/** A workspace nobody has started or ended a session in for this many days is idle. */
const IDLE_AFTER_DAYS = 7;

/** The most rows the cleanup dialog lists. */
const MAX_CLEANUP_ROWS = MAX_DISPOSE_MANY_ITEMS;

/** The most Threads one cleanup archives: the limit of one `session.archive` call. */
const MAX_ARCHIVED_THREADS = MAX_SESSION_IDS;

/**
 * Checks whether nothing has started or ended a session in `workspace` for 7
 * days or more, and no session holds it now. A workspace with no recorded use
 * counts from its creation.
 */
export const isIdleWorkspace = (workspace: Workspace, now: Date): boolean =>
  workspace.sessionIds.length === 0 &&
  now.getTime() - Date.parse(workspace.lastUsedAt ?? workspace.createdAt) >=
    IDLE_AFTER_DAYS * DAY_MS;

/**
 * Returns the workspaces of the machine `runnerId` that a cleanup may remove,
 * in the order `workspaces` holds them: ephemeral, ready or failed (not
 * removed, being removed or lost), and idle (see `isIdleWorkspace`). A main
 * workspace is never listed: it is removed on its own.
 *
 * Whether a Thread used the workspace is not known from the workspace alone.
 * `readWorkspaceThreads` reads that, and the rows built after it leave out
 * workspaces no Thread used (a workflow run's workspace goes by its run's
 * rules).
 */
export const listCleanupCandidates = (
  workspaces: readonly Workspace[],
  runnerId: string,
  now: Date,
): readonly Workspace[] =>
  workspaces.filter(
    (workspace) =>
      workspace.runnerId === runnerId &&
      workspace.kind === "ephemeral" &&
      (workspace.status === "ready" || workspace.status === "failed") &&
      isIdleWorkspace(workspace, now),
  );

/**
 * Returns why the Clean up… button of the machine named `runnerName` is
 * disabled, or `null` when it is enabled. Cleaning up needs the machine
 * online, because the removal is sent to its runner.
 */
export const describeCleanUpDisabledHint = (
  runnerName: string,
  isOnline: boolean,
): string | null => (isOnline ? null : `${runnerName} is offline. Cleaning up needs it online.`);

/** An idle workspace as the machine page and the cleanup dialog draw it. */
export interface IdleWorkspaceRow {
  readonly workspaceId: string;
  /** The name of the workspace's sidebar row: the title of its oldest Thread. */
  readonly name: string;
  /** What the workspace takes on disk, or `null` when it was never measured. */
  readonly sizeBytes: number | null;
  /** What removing the workspace gives back, or `null` when it was never measured. */
  readonly freesBytes: number | null;
  readonly sizeText: string | null;
  readonly freesText: string | null;
  /** When a session last started or ended in it, such as "2 weeks ago". */
  readonly lastUsedText: string;
  /**
   * Why the sizes are old or missing, to draw in the muted ink under the row:
   * "Sizes from 3 days ago: measuring took longer than 10 minutes." or "Not
   * measured yet: measuring took longer than 10 minutes.". A workspace that was
   * never measured and failed no measuring says "Not measured yet.". `null`
   * when the sizes are current.
   */
  readonly measuringNote: string | null;
}

/** Lowercases the first letter of `text` and ends it with a single full stop. */
const toSentenceTail = (text: string): string => {
  const trimmed = text.trim().replace(/\.+$/, "");
  return `${trimmed.charAt(0).toLowerCase()}${trimmed.slice(1)}.`;
};

/** Describes why a workspace's sizes are not current, or returns `null` when they are. */
const describeMeasuringNote = (workspace: Workspace, now: Date): string | null => {
  const { diskUsage, diskUsageError } = workspace;
  if (diskUsage === null) {
    return diskUsageError === null
      ? "Not measured yet."
      : `Not measured yet: ${toSentenceTail(diskUsageError)}`;
  }
  return diskUsageError === null
    ? null
    : `Sizes from ${describeAge(diskUsage.measuredAt, now)}: ${toSentenceTail(diskUsageError)}`;
};

/** Builds the row of `workspace`, named `name`, with its sizes and its last use counted at `now`. */
const buildIdleWorkspaceRow = (workspace: Workspace, name: string, now: Date): IdleWorkspaceRow => {
  const { diskUsage } = workspace;
  return {
    workspaceId: workspace.id,
    name,
    sizeBytes: diskUsage?.sizeBytes ?? null,
    freesBytes: diskUsage?.freesBytes ?? null,
    sizeText: diskUsage === null ? null : formatDiskSize(diskUsage.sizeBytes),
    freesText: diskUsage === null ? null : formatDiskSize(diskUsage.freesBytes),
    lastUsedText: describeAge(workspace.lastUsedAt ?? workspace.createdAt, now),
    measuringNote: describeMeasuringNote(workspace, now),
  };
};

/**
 * Returns the rows of the `candidates` that at least one of `threads` used,
 * each named as the workspace's sidebar row is named. `threads` are the
 * Threads `readWorkspaceThreads` read for the candidates. The rows are ordered
 * by what removing them frees, largest first. A workspace never measured goes
 * last, and ties go by workspace id.
 */
export const buildIdleWorkspaceRows = (
  candidates: readonly Workspace[],
  threads: readonly Session[],
  now: Date,
): readonly IdleWorkspaceRow[] => {
  const candidateIds = new Set(candidates.map((workspace) => workspace.id));
  const names = new Map(
    buildSessionGroups(
      threads.filter(
        (thread) => thread.workspaceId !== null && candidateIds.has(thread.workspaceId),
      ),
    ).map((group) => [group.lead.workspaceId, group.lead.title]),
  );
  return candidates
    .flatMap((workspace) => {
      const name = names.get(workspace.id);
      return name === undefined ? [] : [buildIdleWorkspaceRow(workspace, name, now)];
    })
    .toSorted(
      (a, b) =>
        (b.freesBytes ?? -1) - (a.freesBytes ?? -1) ||
        (a.workspaceId < b.workspaceId ? -1 : a.workspaceId > b.workspaceId ? 1 : 0),
    );
};

/** Which group of the dialog a workspace is in. */
export type CleanupGroupId = "done" | "notDone";

/** One row of the dialog, frozen when the dialog opened. */
export interface CleanupRow extends IdleWorkspaceRow {
  readonly group: CleanupGroupId;
  /**
   * The workspace's `lastUsedAt` as the dialog showed it, which the removal
   * sends back so a workspace used since is refused. `null` when it had none.
   */
  readonly expectedLastUsedAt: string | null;
  /** The Threads of the workspace that are not archived yet, which the cleanup archives. */
  readonly unarchivedThreadIds: readonly string[];
}

/** What the dialog shows when it opens, kept for as long as it stays open. */
export interface CleanupSnapshot {
  readonly runnerName: string;
  /** At most 200 rows, largest first by what removing them frees. */
  readonly rows: readonly CleanupRow[];
  /** The workspaces ticked when the dialog opens: those whose Threads are all Done. */
  readonly initialTicked: ReadonlySet<string>;
}

/**
 * Freezes the cleanup dialog's rows for the machine named `runnerName`, from
 * the `candidates` and the `threads` read for them (see `readWorkspaceThreads`).
 *
 * - A workspace no Thread used has no row.
 * - Rows are ordered by what removing them frees, largest first, and a
 *   workspace never measured goes last. Ties go by workspace id. Only the
 *   first 200 are kept, the most one `workspace.disposeMany` call takes.
 * - A workspace is in the `done` group when every one of its Threads is Done
 *   (an archived Thread is Done too), else in `notDone`.
 */
export const buildCleanupSnapshot = (
  runnerName: string,
  candidates: readonly Workspace[],
  threads: readonly Session[],
  now: Date,
): CleanupSnapshot => {
  const threadsByWorkspace = new Map<string, Session[]>();
  for (const thread of threads) {
    if (thread.workspaceId === null) continue;
    const held = threadsByWorkspace.get(thread.workspaceId);
    if (held === undefined) threadsByWorkspace.set(thread.workspaceId, [thread]);
    else held.push(thread);
  }
  const workspacesById = new Map(candidates.map((workspace) => [workspace.id, workspace]));
  const rows = buildIdleWorkspaceRows(candidates, threads, now)
    .map((row): CleanupRow => {
      const workspaceThreads = threadsByWorkspace.get(row.workspaceId) ?? [];
      return {
        ...row,
        group: workspaceThreads.every((thread) => thread.done !== undefined) ? "done" : "notDone",
        expectedLastUsedAt: workspacesById.get(row.workspaceId)?.lastUsedAt ?? null,
        unarchivedThreadIds: workspaceThreads
          .filter((thread) => thread.archived === undefined)
          .map((thread) => thread.id),
      };
    })
    .toSorted(
      (a, b) =>
        (b.freesBytes ?? -1) - (a.freesBytes ?? -1) ||
        (a.workspaceId < b.workspaceId ? -1 : a.workspaceId > b.workspaceId ? 1 : 0),
    )
    .slice(0, MAX_CLEANUP_ROWS);
  return {
    runnerName,
    rows,
    initialTicked: new Set(
      rows.filter((row) => row.group === "done").map((row) => row.workspaceId),
    ),
  };
};

/** What the button does: archive the Threads, then remove the workspaces of `rows`. */
export interface CleanupPlan {
  /** The Threads of the ticked workspaces that are not archived yet. Empty skips the archive. */
  readonly threadIds: readonly string[];
  /** The ticked rows, which the removal sends back as the dialog showed them. */
  readonly rows: readonly CleanupRow[];
}

/** A row as the dialog draws it. */
export interface CleanupDialogRow extends CleanupRow {
  readonly ticked: boolean;
}

/** One group of the dialog, with the state of the checkbox in its head. */
export interface CleanupDialogGroup {
  readonly id: CleanupGroupId;
  readonly title: string;
  readonly hint: string;
  /** The head's checkbox: all of the group's rows ticked, some of them, or none. */
  readonly checked: "all" | "some" | "none";
  /** Such as "3 · frees 18 GB": the rows in the group and what removing all of them frees. */
  readonly summary: string;
  readonly rows: readonly CleanupDialogRow[];
}

/** Everything the cleanup dialog draws. See `describeCleanupDialog`. */
export interface CleanupDialog {
  /** Such as "Clean up atlas". */
  readonly head: string;
  /** The groups that hold rows, "Threads Done" first. */
  readonly groups: readonly CleanupDialogGroup[];
  /** The line shown in place of the groups when no workspace is listed, else `null`. */
  readonly empty: string | null;
  /** The warning line at the dialog's foot, `null` when `empty` is shown. */
  readonly foot: string | null;
  readonly button: {
    /** Such as "Archive and remove 6, frees 41 GB". */
    readonly label: string;
    readonly disabled: boolean;
    /** Why the button is disabled when the ticked workspaces hold too many Threads, else `null`. */
    readonly hint: string | null;
  };
  /** What the button runs, or `null` while the button is disabled. */
  readonly plan: CleanupPlan | null;
}

const GROUP_WORDS: Readonly<Record<CleanupGroupId, { title: string; hint: string }>> = {
  done: {
    title: "Threads Done",
    hint: "Not used for a week or more, and every thread in them is Done.",
  },
  notDone: {
    title: "Threads not Done",
    hint: "Some threads here are not Done. Removing marks them Done and archives them.",
  },
};

/** Words the rows of a group: "3 · frees 18 GB", leaving out what was never measured. */
const summarizeRows = (rows: readonly CleanupRow[]): string => {
  const freed = rows.reduce((sum, row) => sum + (row.freesBytes ?? 0), 0);
  return freed === 0
    ? String(rows.length)
    : `${String(rows.length)} · frees ${formatDiskSize(freed)}`;
};

/** Words the button for `count` ticked workspaces that free `freedBytes`. */
const labelCleanupButton = (count: number, freedBytes: number): string => {
  if (count === 0) return "Archive and remove";
  return freedBytes === 0
    ? `Archive and remove ${String(count)}`
    : `Archive and remove ${String(count)}, frees ${formatDiskSize(freedBytes)}`;
};

/**
 * Describes the cleanup dialog for `snapshot` with the workspaces in `ticked`
 * ticked. A tick for a workspace the snapshot does not hold is ignored.
 *
 * The button is disabled while nothing is ticked, and while the ticked
 * workspaces hold more than 500 Threads that are not archived yet, the most
 * one `session.archive` call takes. In that case `hint` says so and `plan`
 * is `null`.
 */
export const describeCleanupDialog = (
  snapshot: CleanupSnapshot,
  ticked: ReadonlySet<string>,
): CleanupDialog => {
  const groups = (["done", "notDone"] as const).flatMap((id): CleanupDialogGroup[] => {
    const rows = snapshot.rows.filter((row) => row.group === id);
    if (rows.length === 0) return [];
    const tickedCount = rows.filter((row) => ticked.has(row.workspaceId)).length;
    return [
      {
        id,
        ...GROUP_WORDS[id],
        checked: tickedCount === 0 ? "none" : tickedCount === rows.length ? "all" : "some",
        summary: summarizeRows(rows),
        rows: rows.map((row) => ({ ...row, ticked: ticked.has(row.workspaceId) })),
      },
    ];
  });
  const tickedRows = snapshot.rows.filter((row) => ticked.has(row.workspaceId));
  const threadIds = tickedRows.flatMap((row) => row.unarchivedThreadIds);
  const freedBytes = tickedRows.reduce((sum, row) => sum + (row.freesBytes ?? 0), 0);
  const tooManyThreads = threadIds.length > MAX_ARCHIVED_THREADS;
  const disabled = tickedRows.length === 0 || tooManyThreads;
  return {
    head: `Clean up ${snapshot.runnerName}`,
    groups,
    empty:
      snapshot.rows.length === 0
        ? "Nothing to clean up. Every workspace here was used in the last 7 days."
        : null,
    foot:
      snapshot.rows.length === 0
        ? null
        : "Everything in these workspaces is deleted, files you never committed included.",
    button: {
      label: labelCleanupButton(tickedRows.length, freedBytes),
      disabled,
      hint: tooManyThreads
        ? `Tick fewer: one cleanup archives at most ${String(MAX_ARCHIVED_THREADS)} threads.`
        : null,
    },
    plan: disabled
      ? null
      : {
          threadIds,
          rows: tickedRows,
        },
  };
};

/** What `requestRemovals` returns. */
export type RemovalAnswer =
  | {
      readonly status: "started";
      /** For each row asked, in order: `requested` when the runner was told, else `refused` with the reason. */
      readonly results: readonly WorkspaceDisposeManyResult[];
    }
  /**
   * The call failed, so it is not known what became of the workspaces: the
   * controller commits the items one by one, and some may be `disposing` or
   * `deleted` already. `message` is the error's.
   */
  | { readonly status: "removalUnknown"; readonly message: string };

/** What `archiveAndRemoveWorkspaces` returns. */
export type CleanupStart =
  /**
   * The archive was refused, or failed without a usable answer (the connection
   * dropped, or the controller answered `internal`), so nothing was removed.
   * `message` is worded for the user. A refusal carries the controller's
   * message. A failure without an answer says the archive may have happened,
   * and to check the threads.
   */
  | { readonly status: "archiveFailed"; readonly message: string }
  | {
      readonly status: "archived";
      /** How many Threads the archive archived; 0 when there was none to archive. */
      readonly archivedCount: number;
      readonly removal: RemovalAnswer;
    };

/**
 * Asks `workspace.disposeMany` to remove the workspaces of `rows`, each with
 * the `lastUsedAt` its row showed. Never fails: a failed call returns
 * `removalUnknown`. A removal the controller accepts answers `requested`: its
 * outcome arrives later, on the `workspace` topic.
 *
 * Try again calls this with the one row that was refused, so the original
 * `lastUsedAt` is sent again.
 */
export const requestRemovals = async (
  client: HerculeClient,
  rows: readonly CleanupRow[],
): Promise<RemovalAnswer> => {
  try {
    const { results } = await client.workspace.disposeMany({
      payload: {
        items: rows.map(({ workspaceId, expectedLastUsedAt }) =>
          // The controller stamps `lastUsedAt` when it creates a workspace, so a null
          // one is a row from before that was recorded. Such a row sends no
          // `expectedLastUsedAt`, so it is not checked against use since the dialog
          // opened. The controller still refuses it while a session holds it.
          expectedLastUsedAt === null ? { workspaceId } : { workspaceId, expectedLastUsedAt },
        ),
      },
    });
    return { status: "started", results };
  } catch (error) {
    return {
      status: "removalUnknown",
      message: error instanceof Error ? error.message : String(error),
    };
  }
};

/**
 * Archives the Threads of `plan` with one `session.archive` call (none when
 * `plan.threadIds` is empty), then removes its rows with `requestRemovals`.
 * Never fails.
 *
 * A refused archive, such as a Thread that started working again, removes
 * nothing and returns `archiveFailed` with the controller's message. So does
 * an archive call that fails with no answer from the controller, or with an
 * `internal` error (which includes a success the client could not decode),
 * because the archive may have been committed: its message says so. Once the
 * archive is done this returns `archived`, because the archive cannot be
 * undone and its count must reach the user, even when the removal call
 * failed.
 */
export const archiveAndRemoveWorkspaces = async (
  client: HerculeClient,
  plan: CleanupPlan,
): Promise<CleanupStart> => {
  let archivedCount = 0;
  if (plan.threadIds.length > 0) {
    try {
      const archived = await client.session.archive({ payload: { sessionIds: plan.threadIds } });
      // The controller archives a workspace's Agent sessions with its last Thread, and those are not counted.
      archivedCount = archived.filter((session) => session.kind === "thread").length;
    } catch (error) {
      // The client also turns a success body it cannot decode into an `internal` ApiError, and
      // then the archive may have been committed. Every other code is the controller's refusal.
      if (error instanceof ApiError && error.code !== "internal") {
        return { status: "archiveFailed", message: error.message };
      }
      const reason = (error instanceof Error ? error.message : String(error)).replace(/\.+$/, "");
      return {
        status: "archiveFailed",
        message: `Could not confirm that the threads were archived: ${reason}. Check them before you try again.`,
      };
    }
  }
  return { status: "archived", archivedCount, removal: await requestRemovals(client, plan.rows) };
};
