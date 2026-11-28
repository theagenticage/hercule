/**
 * What the details pane says when the user links a thing to a Task by hand or
 * removes a link: the line on the undo line for each outcome, and the words
 * of the gesture Undo reverses.
 */
import type { LinkDirection } from "../desk/link-search";

/**
 * Returns the words of the gesture, in the past tense, as the undo line shows
 * them and Undo reports them ("Put back: Linked #412 to Fix the basket").
 * `thing` is how a sentence names the linked thing (`nameLinkedThing`).
 */
export const describeTaskLinkGesture = (
  direction: LinkDirection,
  thing: string,
  taskTitle: string,
): string =>
  direction === "link"
    ? `Linked ${thing} to ${taskTitle}`
    : `Removed the link from ${taskTitle} to ${thing}`;

/**
 * Returns the sentence for a change the user asked for, which the undo line
 * says when they act. A removed link stays removed, which the line says,
 * because the user may expect the next scan of the source to bring it back.
 */
export const describeTaskLinkDone = (
  direction: LinkDirection,
  thing: string,
  taskTitle: string,
): string =>
  direction === "link"
    ? `Linked ${thing} to ${taskTitle}.`
    : `Removed ${thing} from ${taskTitle}. It stays removed until you link it again.`;

/**
 * Returns the sentence for a change that found nothing to do: the Task linked
 * the thing already, or did not link it. It replaces the sentence said when
 * the user acted, which was for a change that has not happened.
 */
export const describeTaskLinkNothing = (
  direction: LinkDirection,
  thing: string,
  taskTitle: string,
): string =>
  direction === "link"
    ? `${thing} was linked to ${taskTitle} already, so nothing changed.`
    : `${thing} was not linked to ${taskTitle}, so nothing was removed.`;

/** Returns the sentence for a change the controller refused, with its `reason` and what to do. */
export const describeTaskLinkFailure = (
  direction: LinkDirection,
  thing: string,
  taskTitle: string,
  reason: string,
): string =>
  direction === "link"
    ? `${thing} was not linked to ${taskTitle}: ${reason}. Try again.`
    : `The link from ${taskTitle} to ${thing} was not removed: ${reason}. Try again.`;
