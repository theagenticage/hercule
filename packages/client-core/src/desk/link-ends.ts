/**
 * The two ends of a link. Every screen that draws a link has to find the end
 * that is not the thing it is drawn for, to tell whether a link joins two given
 * things, and to name the thing at the far end. These three answer for all of
 * them, so no screen works them out again its own way.
 */
import type { EntityLink } from "@hercule/contract";

/** The two refs a link joins. */
type LinkEnds = Pick<EntityLink, "fromRef" | "toRef">;

/** Returns the ref at the end of `link` that is not `ref`. `ref` is expected to be one of the two ends. */
export const readOtherRef = (link: LinkEnds, ref: string): string =>
  link.fromRef === ref ? link.toRef : link.fromRef;

/** Checks whether `link` joins the things `a` and `b`, whichever way it points. */
export const isLinkBetween = (link: LinkEnds, a: string, b: string): boolean =>
  (link.fromRef === a && link.toRef === b) || (link.fromRef === b && link.toRef === a);

/**
 * Returns how a sentence names the thing at the end of a link: its identifier
 * ("OPS-47"), else its title, else its noun ("Pull request"). A thing the
 * user cannot read has neither identifier nor title, so it is named by its
 * noun alone and never leaks a title learned through someone else's read.
 */
export const nameLinkedThing = (thing: {
  readonly identifier?: string | undefined;
  readonly title?: string | undefined;
  readonly noun: string;
}): string => thing.identifier ?? thing.title ?? thing.noun;
