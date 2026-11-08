/**
 * What the open card's "Link something" search needs from the card: the two
 * things a link move joins, and the refs the search must not offer again.
 */
import type { EntityLink } from "@hercule/contract";

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

/**
 * Returns the refs the search must not offer for the thing at `selfRef`: the
 * thing itself, and every thing a source or the user already linked to it, in
 * either direction. `links` holds no hint, because a reference found in text
 * proves nothing: its thing can still be linked.
 */
export const listLinkedRefs = (
  selfRef: string,
  links: readonly EntityLink[],
): readonly string[] => [selfRef, ...links.flatMap((link) => [link.fromRef, link.toRef])];
