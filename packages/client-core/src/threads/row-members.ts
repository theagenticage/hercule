import type { GroupRow } from "./group-row";

/**
 * One session of a sidebar row, with what a screen outside the sidebar needs
 * to name its row: the row's key and title, the lead the row opens, and the
 * session's own label among the row's sessions.
 */
export interface RowMember {
  readonly rowKey: string;
  readonly rowTitle: string;
  readonly leadId: string;
  readonly label: string;
}

/**
 * Returns every session of `groupRows` (exited ones included) as a
 * `RowMember`, keyed by session id.
 *
 * The result holds plain strings only, so a query's `select` can return it
 * and keep its identity until a row's key, title or lead, or a session's
 * label, changes. A push that changes only a session's usage or last activity
 * leaves it equal.
 */
export const indexRowMembers = (
  groupRows: readonly GroupRow[],
): Readonly<Record<string, RowMember>> =>
  Object.fromEntries(
    groupRows.flatMap((row) =>
      row.members.map((member) => [
        member.sessionId,
        { rowKey: row.key, rowTitle: row.title, leadId: row.leadId, label: member.label },
      ]),
    ),
  );
