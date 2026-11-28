/**
 * What the "Link something" search and the changes it makes need, on the
 * details pane and on the Inbox's open card. The search itself is Work's Add
 * search (`externalEntity.search`, `buildResultRows`); this decides which of
 * its rows can be linked, and names the two ways a link changes.
 */
import type { EntityLink } from "@hercule/contract";
import type { AddRow } from "../work/add-list";

/** Which way a change to a link goes. */
export type LinkDirection = "link" | "unlink";

/** Returns the direction that reverses `direction`: a link is undone by an unlink, an unlink by a link. */
export const reverseLinkDirection = (direction: LinkDirection): LinkDirection =>
  direction === "link" ? "unlink" : "link";

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

/**
 * Returns the refs the search must not offer for the thing at `selfRef`: the
 * thing itself, and every thing a source or the user already linked to it, in
 * either direction. `links` holds no hint, because a reference found in text
 * proves nothing: its thing can still be linked.
 */
export const listRefsNotToOffer = (
  selfRef: string,
  links: readonly EntityLink[],
): readonly string[] => [selfRef, ...links.flatMap((link) => [link.fromRef, link.toRef])];
