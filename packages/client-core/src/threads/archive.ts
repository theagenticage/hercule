/**
 * What the desktop decides about archiving rows (spec 17 §Archiving a row):
 * which rows can be archived, which rows "Archive all" takes, and the words
 * of the confirmation and of the toast. Archiving acts on a row, as Done
 * does: every Thread of the row goes in one `session.archive` call.
 */
import { MAX_PAGE_LIMIT, MAX_SESSION_IDS, type Session } from "@hercule/contract";
import type { GroupRow } from "./group-row";

/** The rows "Archive all" takes from the Done shelf, and what it leaves out. */
export interface ArchivePlan {
  /** The rows to archive, the oldest marked Done first. */
  readonly rows: readonly GroupRow[];
  /** How many rows on the shelf were left out because a session of theirs is working. */
  readonly skippedWorking: number;
  /** How many rows that could be archived did not fit in the call's limit of Threads, counting the Threads the sidebar holds. */
  readonly leftOver: number;
}

/** What archiving the rows of an `ArchivePlan` really sends, once each row's Threads are complete. */
export interface ArchiveCall {
  /** The rows archived: the plan's rows, oldest first, while their Threads fit in one call. */
  readonly rows: readonly GroupRow[];
  /** Every Thread of `rows`, for one `session.archive` call. */
  readonly sessionIds: readonly string[];
  /** How many of the plan's rows did not fit in the call's limit of Threads. */
  readonly droppedRows: number;
}

/**
 * Returns why `row` cannot be archived, such as "Ship v2.4 is working. Stop
 * it first.", or `null` when it can. A row cannot be archived while any of
 * its sessions is queued, starting or busy, because archiving stops them.
 */
export const findArchiveBlockReason = (row: GroupRow): string | null =>
  row.members.some((member) => member.working) ? `${row.title} is working. Stop it first.` : null;

/**
 * Returns the rows "Archive all" archives out of `rows`, the rows of the
 * sidebar:
 *
 * - only the rows on the Done shelf, all of them and not only the ones the
 *   shelf draws;
 * - the oldest marked Done first, ties in key order;
 * - not the rows that work, which are counted in `skippedWorking`;
 * - whole rows only, while their Threads together stay within the limit of
 *   one call. The first row that does not fit ends the list, so the rows
 *   left over are always the newest. The Threads counted are the ones the
 *   rows hold, which can be fewer than the workspace has (see
 *   `buildArchiveCall`), so the call may still drop rows.
 */
export const planArchiveAll = (rows: readonly GroupRow[]): ArchivePlan => {
  const shelf = rows
    .filter((row) => row.doneAt !== null)
    .toSorted(
      (a, b) =>
        Date.parse(a.doneAt!) - Date.parse(b.doneAt!) ||
        (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    );
  const idle = shelf.filter((row) => findArchiveBlockReason(row) === null);
  const taken: GroupRow[] = [];
  let threadCount = 0;
  for (const row of idle) {
    threadCount += row.threadIds.length;
    if (threadCount > MAX_SESSION_IDS) break;
    taken.push(row);
  }
  return {
    rows: taken,
    skippedWorking: shelf.length - idle.length,
    leftOver: idle.length - taken.length,
  };
};

/** Returns the confirmation's title: "Archive Ship v2.4?" for one row, "Archive 12 rows?" for several. */
export const buildArchiveTitle = (rows: readonly GroupRow[]): string =>
  rows.length === 1 ? `Archive ${rows[0]!.title}?` : `Archive ${String(rows.length)} rows?`;

/**
 * Returns the toast that follows an archive of `rowCount` rows: "Archived"
 * for one row and "Archived 12" for several. "Archive all" adds a sentence
 * for the rows it skipped as working and one for the rows it left over:
 * "Archived 12. 2 working rows skipped. 3 rows left."
 */
export const buildArchivedToast = (
  rowCount: number,
  { skippedWorking, leftOver }: Pick<ArchivePlan, "skippedWorking" | "leftOver">,
): string => {
  const noun = (count: number): string => (count === 1 ? "row" : "rows");
  const sentences = [rowCount === 1 ? "Archived" : `Archived ${String(rowCount)}`];
  if (skippedWorking > 0)
    sentences.push(`${String(skippedWorking)} working ${noun(skippedWorking)} skipped`);
  if (leftOver > 0) sentences.push(`${String(leftOver)} ${noun(leftOver)} left`);
  return sentences.length === 1 ? sentences[0]! : `${sentences.join(". ")}.`;
};

/**
 * Returns the ids of the workspaces of `rows`, in lists of at most one page
 * each, which is the most a read of Threads by workspace takes. A Thread with
 * no workspace has none to read.
 */
export const listArchiveWorkspaceIds = (
  rows: readonly GroupRow[],
): readonly (readonly string[])[] => {
  const ids = [
    ...new Set(rows.flatMap((row) => (row.workspaceId === null ? [] : [row.workspaceId]))),
  ];
  return Array.from({ length: Math.ceil(ids.length / MAX_PAGE_LIMIT) }, (_, index) =>
    ids.slice(index * MAX_PAGE_LIMIT, (index + 1) * MAX_PAGE_LIMIT),
  );
};

/**
 * Returns the call that archives `rows`, from the Threads the controller
 * holds in the rows' workspaces (`workspaceThreads`, as the read by
 * `listArchiveWorkspaceIds` returns them).
 *
 * The sidebar's read leaves out a Thread marked Done more than 14 days ago,
 * so a row can miss such a sibling. Archiving only the row's known Threads
 * would leave the workspace not fully archived, and it would never be
 * cleaned up. So each row's Threads are the ones it knows plus every
 * unarchived Thread in `workspaceThreads` of its workspace. Rows are then
 * taken whole, in order, while their Threads stay within the limit of one
 * call. The first row that does not fit ends the list.
 */
export const buildArchiveCall = (
  rows: readonly GroupRow[],
  workspaceThreads: readonly Session[],
): ArchiveCall => {
  const taken: GroupRow[] = [];
  const sessionIds: string[] = [];
  for (const row of rows) {
    const unseen =
      row.workspaceId === null
        ? []
        : workspaceThreads
            .filter(
              (session) =>
                session.workspaceId === row.workspaceId &&
                session.kind === "thread" &&
                session.archived === undefined &&
                !row.threadIds.includes(session.id),
            )
            .map((session) => session.id);
    const rowIds = [...row.threadIds, ...unseen];
    if (sessionIds.length + rowIds.length > MAX_SESSION_IDS) break;
    taken.push(row);
    sessionIds.push(...rowIds);
  }
  return { rows: taken, sessionIds, droppedRows: rows.length - taken.length };
};
