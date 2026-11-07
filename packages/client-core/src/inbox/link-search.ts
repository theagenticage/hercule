/**
 * What the open card's "Link something" search lists. The search itself is
 * Work's Add search (`externalEntity.search`, `buildResultRows`); this decides
 * which of its rows can be linked to the open thing.
 */
import type { EntityLink } from "@hercule/contract";
import type { AddRow } from "../work/add-list";

/**
 * The two things a link move joins, and how to name each in the undo line
 * ("Linked SHOP-371 and #6238"). The move is the user's own: `fromRef` is the
 * thing the user was looking at when they linked.
 */
export interface EntityLinkMove {
  readonly fromRef: string;
  readonly toRef: string;
  readonly fromName: string;
  readonly toName: string;
}

/** The most rows the search under "Link something" lists. A longer list is narrowed by typing more. */
export const MAX_LINK_RESULTS = 5;

/**
 * Returns the rows of a search that can be linked to the thing at `selfRef`,
 * at most `MAX_LINK_RESULTS`: not the thing itself, and not a thing already
 * linked to it by a source or by the user. `links` holds no hint, because a
 * reference found in text proves nothing: its thing can still be linked.
 */
export const listLinkableRows = (
  rows: readonly AddRow[],
  selfRef: string,
  links: readonly EntityLink[],
): readonly AddRow[] => {
  const linked = new Set(links.flatMap((link) => [link.fromRef, link.toRef]));
  return rows
    .filter((row) => row.ref !== selfRef && !linked.has(row.ref))
    .slice(0, MAX_LINK_RESULTS);
};
