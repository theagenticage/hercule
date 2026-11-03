/**
 * What the desktop decides about archiving rows (spec 17 §Archiving a row):
 * which rows can be archived, which rows "Archive all" takes, the words of
 * the confirmation, and the archive itself. Archiving acts on a row, as Done
 * does: every Thread of the row goes in one `session.archive` call.
 */
import { MAX_SESSION_IDS, type Session } from "@hercule/contract";
import type { HerculeClient } from "../client";
import { readEveryPage } from "../read-every-page";
import type { GroupRow } from "./group-row";

/** The rows an archive takes, and what the user is told about the rows it leaves. */
export interface ArchivePlan {
  /** The rows to archive, the oldest marked Done first. */
  readonly rows: readonly GroupRow[];
  /** How many rows on the shelf were left out because a session of theirs is working. */
  readonly skippedWorking: number;
  /** How many rows that could be archived did not fit in the call's limit of Threads, counting the Threads the sidebar holds. */
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
 *   left over are always the newest. The Threads counted are the ones the
 *   rows hold, which can be fewer than the workspace has (see
 *   `archiveRows`), so the archive may still leave rows out.
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
const buildArchivedToast = (rowCount: number, skippedWorking: number, leftOver: number): string => {
  const noun = (count: number): string => (count === 1 ? "row" : "rows");
  const sentences = [rowCount === 1 ? "Archived" : `Archived ${String(rowCount)}`];
  if (skippedWorking > 0)
    sentences.push(`${String(skippedWorking)} working ${noun(skippedWorking)} skipped`);
  if (leftOver > 0) sentences.push(`${String(leftOver)} ${noun(leftOver)} left`);
  return sentences.length === 1 ? sentences[0]! : `${sentences.join(". ")}.`;
};

/**
 * Archives the rows of `plan` and returns the sessions the controller
 * archived and the toast that tells the user what happened. Fails when a
 * read or the archive fails, or when the first row alone holds more Threads
 * than one call takes.
 *
 * The sidebar's list leaves out a Thread marked Done more than 14 days ago,
 * so a row can miss such a sibling, and a workspace with one Thread left
 * unarchived would never be cleaned up. So the rows' workspaces are read
 * first, with one query, and each row's Threads are the ones it knows plus
 * every unarchived Thread of its workspace. Rows are then taken whole, in
 * order, while their Threads stay within the limit of one call. The first
 * row that does not fit ends the list, and the toast counts it as left.
 */
export const archiveRows = async (
  client: HerculeClient,
  { rows, skippedWorking, leftOver }: ArchivePlan,
): Promise<{ readonly sessions: readonly Session[]; readonly notice: string }> => {
  const workspaceIds = [...new Set(rows.flatMap((row) => row.workspaceId ?? []))];
  // A Thread with no workspace is a row of its own, so there is nothing to read for it.
  const workspaceThreads =
    workspaceIds.length === 0
      ? []
      : await readEveryPage((page) =>
          client.session.query({
            query: { workspaceId: workspaceIds, kind: "thread", archived: false, ...page },
          }),
        );
  const taken: GroupRow[] = [];
  const sessionIds: string[] = [];
  for (const row of rows) {
    const unlisted = workspaceThreads
      .filter(
        (thread) => thread.workspaceId === row.workspaceId && !row.threadIds.includes(thread.id),
      )
      .map((thread) => thread.id);
    const rowIds = [...row.threadIds, ...unlisted];
    if (sessionIds.length + rowIds.length > MAX_SESSION_IDS) break;
    taken.push(row);
    sessionIds.push(...rowIds);
  }
  if (taken.length === 0) {
    throw new Error("The first row holds more threads than one archive can take.");
  }
  const sessions = await client.session.archive({ payload: { sessionIds } });
  return {
    sessions,
    notice: buildArchivedToast(taken.length, skippedWorking, leftOver + rows.length - taken.length),
  };
};
