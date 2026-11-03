/**
 * What the desktop decides about archiving rows (spec 17 §Archiving a row):
 * which rows can be archived, which rows "Archive all" takes, and the words
 * of the confirmation and of the toast. Archiving acts on a row, as Done
 * does: every Thread of the row goes in one `session.archive` call.
 */
import { MAX_SESSION_IDS } from "@hercule/contract";
import type { GroupRow } from "./group-row";

/** The rows "Archive all" takes from the Done shelf, and what it leaves out. */
export interface ArchivePlan {
  /** The rows to archive, the oldest marked Done first. */
  readonly rows: readonly GroupRow[];
  /** The Threads of `rows`, for one `session.archive` call. */
  readonly sessionIds: readonly string[];
  /** How many rows on the shelf were left out because a session of theirs is working. */
  readonly skippedWorking: number;
  /** How many rows that could be archived did not fit in the call's limit of Threads. */
  readonly leftOver: number;
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
 *   left over are always the newest.
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
    sessionIds: taken.flatMap((row) => row.threadIds),
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
  { skippedWorking, leftOver }: Pick<ArchivePlan, "skippedWorking" | "leftOver"> = {
    skippedWorking: 0,
    leftOver: 0,
  },
): string => {
  const noun = (count: number): string => (count === 1 ? "row" : "rows");
  const sentences = [rowCount === 1 ? "Archived" : `Archived ${String(rowCount)}`];
  if (skippedWorking > 0)
    sentences.push(`${String(skippedWorking)} working ${noun(skippedWorking)} skipped`);
  if (leftOver > 0) sentences.push(`${String(leftOver)} ${noun(leftOver)} left`);
  return sentences.length === 1 ? sentences[0]! : `${sentences.join(". ")}.`;
};
