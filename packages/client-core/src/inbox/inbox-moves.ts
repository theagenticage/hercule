/**
 * What the Inbox's moves decide and say: whether a move may be made on the
 * things it was asked for, and the words the undo line shows for it. The
 * screen sends the move; this module never reads or writes anything.
 *
 * Every refusal says what was wrong and what to do instead, and an undo line
 * puts the title of the thing last (`title`), so a line that is too narrow
 * cuts the title and never the words before it.
 */
import { MAX_INBOX_MOVED_THINGS, type InboxThing } from "@hercule/contract";
import { decideHandMove, type CardOffers } from "./card-hand-off";

/** The moves of a thing that the Inbox's keys and buttons make. */
export type InboxMoveKind = "dismiss" | "takeOn" | "handOff" | "goToTask";

/** What may be done: go on, or refuse and say why. */
export type InboxMovePlan =
  | { readonly kind: "go" }
  | { readonly kind: "refuse"; readonly reason: string };

/** The words of an undo line: what happened, and the title of the thing it happened to. */
export interface InboxLineWords {
  readonly text: string;
  readonly title: string | null;
}

const GO: InboxMovePlan = { kind: "go" };
const refuse = (reason: string): InboxMovePlan => ({ kind: "refuse", reason });

/** The longest title a sentence quotes before it is cut, in letters. */
const QUOTED_TITLE_LENGTH = 44;

/** Returns `title` in quotes for the middle of a sentence, cut with an ellipsis when it is long. */
const quoteTitle = (title: string): string =>
  `“${title.length > QUOTED_TITLE_LENGTH ? `${title.slice(0, QUOTED_TITLE_LENGTH - 2)}…` : title}”`;

/** Returns who has the thing, as a sentence's subject: its first live workflow, else the user. */
const describeWhoHasIt = (thing: Pick<InboxThing, "liveWorkflows">): string =>
  thing.liveWorkflows[0] === undefined ? "You have" : `${thing.liveWorkflows[0].name} has`;

const OFFLINE = "You are offline, so that was not done. Try again when the connection is back.";

/**
 * Decides whether `move` may be made on `things`, the things the move was
 * asked for (the selection, else the current row, else the row whose button
 * was pressed), in the order they are listed.
 *
 * - Every move but Go to its Task needs the connection, because the outbox
 *   that would hold a move for later does not exist yet.
 * - Dismiss takes up to `MAX_INBOX_MOVED_THINGS` things, in one call.
 * - Take on and the hand-off take one thing. Take on also refuses a thing a
 *   Task already holds, and the hand-off a thing no workflow can take
 *   (`offers`, the offers of the one thing).
 * - Go to its Task needs one thing that has a Task.
 *
 * Call it with at least one thing.
 */
export const planInboxMove = ({
  move,
  things,
  isOffline,
  offers,
}: {
  readonly move: InboxMoveKind;
  readonly things: readonly InboxThing[];
  readonly isOffline: boolean;
  readonly offers: CardOffers;
}): InboxMovePlan => {
  if (isOffline && move !== "goToTask") return refuse(OFFLINE);
  const [thing] = things;
  const isOne = things.length === 1 && thing !== undefined;
  switch (move) {
    case "dismiss":
      return things.length > MAX_INBOX_MOVED_THINGS
        ? refuse(
            `Dismiss takes up to ${MAX_INBOX_MOVED_THINGS.toLocaleString("en-US")} things at once, and ${things.length.toLocaleString("en-US")} are selected. Select fewer, then press E again.`,
          )
        : GO;
    case "takeOn":
      if (!isOne)
        return refuse(
          "Take on makes one Task for one thing. Press Esc to clear the selection, then T on the thing you want.",
        );
      return thing.taskId === undefined
        ? GO
        : refuse(`${describeWhoHasIt(thing)} this already. G goes to its Task.`);
    case "handOff":
      if (!isOne)
        return refuse(
          "Hand-off takes one thing at a time. Press Esc to clear the selection, then H on the thing you want.",
        );
      return decideHandMove(offers).kind === "none"
        ? refuse(`No workflow takes ${thing.noun.toLowerCase()}s yet.`)
        : GO;
    case "goToTask":
      if (!isOne) return refuse("Go to its Task takes one thing at a time.");
      return thing.taskId === undefined ? refuse("This has no Task yet. T takes it on.") : GO;
  }
};

/** Returns the words for the line after `things` were dismissed. One thing shows its title. */
export const describeInboxDismissal = (things: readonly InboxThing[]): InboxLineWords =>
  things.length === 1
    ? { text: "Dismissed", title: things[0]!.title }
    : { text: `Dismissed ${things.length.toLocaleString("en-US")} things`, title: null };

/** The words for the line after an undo put dismissed things back. */
export const DISMISSAL_UNDONE = "Back in your Inbox.";

/** Returns the sentence for a dismissal the controller refused: the things are back, and why. */
export const describeInboxDismissalFailure = (
  things: readonly InboxThing[],
  reason: string,
): string =>
  things.length === 1
    ? `${quoteTitle(things[0]!.title)} was not dismissed, so it is back: ${reason}. Try again.`
    : `${things.length.toLocaleString("en-US")} things were not dismissed, so they are back: ${reason}. Try again.`;

/** Returns the words for the line after `thing` was taken on, with `created` saying whether this made the Task. */
export const describeInboxTakeOn = (thing: InboxThing, created: boolean): InboxLineWords =>
  created
    ? { text: "Took on, a Task on Work", title: thing.title }
    : { text: "It already had a Task, so no new one was made", title: null };

/** The words for the line after an undo took the Task a Take on made away again. */
export const TAKE_ON_UNDONE = "The Task is gone, and nothing had started.";

/** Returns the sentence for a Take on the controller refused. */
export const describeInboxTakeOnFailure = (thing: InboxThing, reason: string): string =>
  `${quoteTitle(thing.title)} was not taken on: ${reason}. Try again.`;

/** Returns the words for the line after `thing` was handed to the workflow `workflowName`. */
export const describeInboxHandOff = (thing: InboxThing, workflowName: string): InboxLineWords => ({
  text: `Handed to ${workflowName}`,
  title: thing.title,
});

/** Returns the sentence for a hand-off the controller refused. */
export const describeInboxHandOffFailure = (
  thing: InboxThing,
  workflowName: string,
  reason: string,
): string => `${quoteTitle(thing.title)} was not handed to ${workflowName}: ${reason}. Try again.`;

/** Returns the line for a thing that has no address to open at its source. */
export const NO_SOURCE_ADDRESS = "This has no address to open at its source.";

/** The line for Go to its Task, which the screen shows while it goes. */
export const describeGoingToTask = (thing: InboxThing): InboxLineWords => ({
  text: "Going to its Task on Work",
  title: thing.title,
});
