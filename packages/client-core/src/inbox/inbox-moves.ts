/**
 * What the Inbox's moves decide and say: whether a move may be made on the
 * things it was asked for, and the words the undo line shows for it. The
 * screen sends the move; this module never reads or writes anything.
 *
 * Every refusal says what was wrong and what to do instead, and an undo line
 * puts the title of the thing last (`title`), so a line that is too narrow
 * cuts the title and never the words before it.
 */
import {
  MAX_INBOX_MOVED_THINGS,
  MAX_THREAD_THINGS,
  type InboxThing,
  type WorkflowOffer,
} from "@hercule/contract";
import { decideHandMove, type CardOffers } from "./card-hand-off";
import { findHolder } from "./inbox-holder";

/** The moves of a thing that the Inbox's keys and buttons make. */
export type InboxMoveKind = "dismiss" | "takeOn" | "handOff" | "goToTask" | "startThread";

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

/**
 * Returns who has the thing, with the verb, as the words that start a
 * sentence (see `findHolder`). Used for a thing the user took on.
 */
const describeWhoHasIt = (thing: Pick<InboxThing, "liveWorkflows" | "takenOn">): string => {
  const holder = findHolder(thing);
  return holder?.kind === "colleague" ? `${holder.name} has` : "You have";
};

/** Returns the same words as `describeWhoHasIt`, for the middle of a sentence, where "you" is lower case. */
const describeWhoHasItMidSentence = (
  thing: Pick<InboxThing, "liveWorkflows" | "takenOn">,
): string => {
  const holder = findHolder(thing);
  return holder?.kind === "colleague" ? `${holder.name} has` : "you have";
};

const OFFLINE = "You are offline, so that was not done. Try again when the connection is back.";

/**
 * Decides whether `move` may be made on `things`, the things the move was
 * asked for (the selection, else the current row, else the row whose button
 * was pressed), in the order they are listed.
 *
 * - Every move but Go to its Task needs the connection, because the outbox
 *   that would hold a move for later does not exist yet.
 * - Dismiss takes up to `MAX_INBOX_MOVED_THINGS` things, in one call.
 * - Take on and the hand-off take one thing. Take on also refuses a thing the
 *   user already took on, and the hand-off a thing no workflow can take
 *   (`offers`, the offers of the one thing).
 * - Go to its Task needs one thing that has a Task.
 * - Start a thread takes a selection of up to `MAX_THREAD_THINGS` things, none
 *   of which someone already has (a live workflow, or the user's own Task).
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
      // A thing with a Task the user did not take on (a signal's, a hand-off's) may be taken on:
      // the controller marks that Task as taken instead of making another.
      return !thing.takenOn
        ? GO
        : refuse(`${describeWhoHasIt(thing)} this already. G goes to its Task.`);
    case "handOff":
      if (!isOne)
        return refuse(
          "Hand-off takes one thing at a time. Press Esc to clear the selection, then H on the thing you want.",
        );
      return decideHandMove(offers).kind === "none"
        ? refuse(`No workflow can take this ${thing.noun.toLowerCase()} yet.`)
        : GO;
    case "startThread": {
      if (things.length > MAX_THREAD_THINGS)
        return refuse(
          `A thread starts from up to ${MAX_THREAD_THINGS} things, and ${things.length.toLocaleString("en-US")} are selected. Select fewer, then press N again.`,
        );
      // Starting a thread always makes a new Task, so a thing on any active Task is refused.
      const taken = things.find((candidate) => candidate.taskId !== undefined);
      if (taken === undefined) return GO;
      const hasHolder = findHolder(taken) !== undefined;
      if (isOne)
        return refuse(
          hasHolder
            ? `${describeWhoHasIt(taken)} this already. G goes to its Task.`
            : `${quoteTitle(taken.title)} is on a Task already. G goes to its Task, where you can start a thread.`,
        );
      return refuse(
        hasHolder
          ? `${quoteTitle(taken.title)} is in the selection, and ${describeWhoHasItMidSentence(taken)} it already. Take it out of the selection, then press N again.`
          : `${quoteTitle(taken.title)} is in the selection, and it is on a Task already. Take it out of the selection, then press N again.`,
      );
    }
    case "goToTask":
      if (!isOne) return refuse("Go to its Task takes one thing at a time.");
      return thing.taskId === undefined ? refuse("This has no Task yet. T takes it on.") : GO;
  }
};

/**
 * Returns `thing` as it reads once `offer` has it: the workflow is live on it,
 * and the asks the workflow answers are gone. A thing left with no ask has no
 * wait, so its row shows who has it. The row shows this at once, until the
 * next read of the list says what the controller made of the hand-off.
 */
export const buildHandedThing = (thing: InboxThing, offer: WorkflowOffer): InboxThing => {
  const askKinds = thing.askKinds.filter((kind) => !offer.answers.includes(kind));
  const liveWorkflows = [
    { workflowId: offer.workflowId, name: offer.name },
    ...thing.liveWorkflows,
  ];
  if (askKinds.length > 0) {
    const asks = thing.asks.filter((ask) => !offer.answers.includes(ask.kind));
    const answered = thing.asks.length - asks.length;
    const everyAskIsListed = thing.askCount === thing.asks.length;
    // The row lists only the newest asks. When it lists them all, the count and the
    // wait follow exactly. When older ones are not listed, their kinds are not known:
    // the count drops by the answered asks it can see (an upper bound) and the wait
    // stays the oldest ask's, until the next read says what the controller made of it.
    const oldest = asks.at(-1);
    const waiting =
      answered > 0 && everyAskIsListed && oldest !== undefined
        ? { waitingSince: oldest.createdAt }
        : {};
    return {
      ...thing,
      asks,
      askCount: thing.askCount - answered,
      askKinds,
      liveWorkflows,
      ...waiting,
    };
  }
  // A thing with no ask waits for nobody, so its row has no wait to show.
  const unwaiting: { -readonly [Key in keyof InboxThing]: InboxThing[Key] } = { ...thing };
  delete unwaiting.waitingSince;
  return { ...unwaiting, asks: [], askCount: 0, askKinds, liveWorkflows };
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

/** Returns the words for the line after a thread was started on `title`, the Task's name. */
export const describeInboxThreadStart = (title: string): InboxLineWords => ({
  text: "Started a thread on",
  title,
});

/**
 * Returns the sentence for a thread the controller refused to start: nothing
 * was made. It adds no advice of its own, because the controller's reasons
 * end with the advice that fits them ("Try again." for a thing that changed,
 * "Leave it out, or start the thread on that Task." for a thing already on one).
 */
export const describeInboxThreadStartFailure = (title: string, reason: string): string =>
  `${quoteTitle(title)} was not started as a thread: ${reason}.`;
