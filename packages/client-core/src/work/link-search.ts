/**
 * What the "Link something" search lists, on the details pane and on the
 * Inbox's open card. The search itself is Work's Add search
 * (`externalEntity.search`, `buildResultRows`); this decides which of its rows
 * can be linked.
 */
import type { AddRow } from "./add-list";

/** The most rows the search under "Link something" lists. A longer list is narrowed by typing more. */
export const MAX_LINK_RESULTS = 5;

/**
 * Returns the rows of a search that can be linked, at most `MAX_LINK_RESULTS`:
 * those whose ref is not in `excludedRefs`. The caller names there the thing
 * the link is for, and everything it is linked to already.
 */
export const listLinkableRows = (
  rows: readonly AddRow[],
  excludedRefs: readonly string[],
): readonly AddRow[] => {
  const excluded = new Set(excludedRefs);
  return rows.filter((row) => !excluded.has(row.ref)).slice(0, MAX_LINK_RESULTS);
};
