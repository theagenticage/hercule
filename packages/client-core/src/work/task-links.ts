/**
 * What the details pane says when the user links a thing to a Task by hand or
 * removes a link: the line on the undo line for each outcome, and the words
 * of the gesture Undo reverses.
 */

/** Which way a change to a Task's link goes. */
export type TaskLinkDirection = "link" | "unlink";

/** Returns the direction that reverses `direction`. */
export const reverseTaskLinkDirection = (direction: TaskLinkDirection): TaskLinkDirection =>
  direction === "link" ? "unlink" : "link";

/**
 * Returns the words of the gesture, in the past tense, as the undo line shows
 * them and Undo reports them ("Put back: Linked #412 to Fix the basket").
 * `thing` is how a sentence names the linked thing (`nameLinkedThing`).
 */
export const describeTaskLinkGesture = (
  direction: TaskLinkDirection,
  thing: string,
  taskTitle: string,
): string =>
  direction === "link"
    ? `Linked ${thing} to ${taskTitle}`
    : `Removed the link from ${taskTitle} to ${thing}`;

/**
 * Returns the sentence for a change the controller accepted. A removed link
 * stays removed, which the line says, because the user may expect the next
 * scan of the source to bring it back.
 */
export const describeTaskLinkDone = (
  direction: TaskLinkDirection,
  thing: string,
  taskTitle: string,
): string =>
  direction === "link"
    ? `Linked ${thing} to ${taskTitle}.`
    : `Removed ${thing} from ${taskTitle}. It stays removed until you link it again.`;

/** Returns the sentence for a change the controller refused, with its `reason` and what to do. */
export const describeTaskLinkFailure = (
  direction: TaskLinkDirection,
  thing: string,
  taskTitle: string,
  reason: string,
): string =>
  direction === "link"
    ? `${thing} was not linked to ${taskTitle}: ${reason}. Try again.`
    : `The link from ${taskTitle} to ${thing} was not removed: ${reason}. Try again.`;
