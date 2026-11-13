/**
 * The words the Inbox pane says about the things it holds: the line for an
 * answer from the moment it is held to the moment it is sent, why a dismissed
 * thing is back, and who has a thing. Each function returns text only, so the
 * pane draws it and never words it.
 *
 * Where a sentence names the source of a thing, it takes the source's name
 * from the caller, which reads it from the plugin list (`namePlugin`).
 */
import type { InboxAsk, InboxThing } from "@hercule/contract";
import { describeAge } from "../threads/age";
import { findHolder } from "./inbox-holder";
import {
  APP_CLOSED_BEFORE_SENT,
  APP_CLOSED_WHILE_SENDING,
  type FailureReason,
} from "../work/held-answers";
import { SIGNAL_ANSWER_HOLD_MS } from "./inbox-asks";

/** What the undo line says for a held answer: what is being done, and the note that it waits. */
export interface HeldAnswerWords {
  readonly text: string;
  readonly note: string;
}

/**
 * Returns the undo line for an answer that is held before it is sent, such as
 * "Approve ENG-1 on GitHub" with the note "Sends in 8s". `replyTo` is the
 * asker's name for an answer the user typed, which reads "Reply to Mei on
 * GitHub" instead.
 */
export const describeHeldSignalAnswer = (answer: {
  readonly label: string;
  readonly identifier: string;
  readonly sourceName: string;
  readonly replyTo?: string;
}): HeldAnswerWords => ({
  text:
    answer.replyTo === undefined
      ? `${answer.label} ${answer.identifier} on ${answer.sourceName}`
      : `${answer.label} to ${answer.replyTo} on ${answer.sourceName}`,
  note: `Sends in ${String(SIGNAL_ANSWER_HOLD_MS / 1000)}s`,
});

/** The note an answer shows while the pointer or focus holds the undo line, so the answer waits. */
export const ANSWER_WAITS_NOTE = "Sends when you let go";

/** Returns the note for an answer that has just been sent. */
export const describeAnswerSent = (sourceName: string): string => `Sent to ${sourceName}.`;

/** Returns the line for Undo (⌘Z) after the answer was sent, which can no longer be taken back. */
export const describeAnswerTooLate = (sourceName: string): string =>
  `Already sent to ${sourceName}, so it can’t be taken back here. Answer again on ${sourceName} if it needs changing.`;

/** Returns the line for Undo (⌘Z) while the answer is on its way and delivery is not confirmed. */
export const describeAnswerSending = (sourceName: string): string =>
  `It is being sent to ${sourceName}, so it can’t be taken back here.`;

/** The line after Undo took back a held answer. */
export const ANSWER_CANCELLED = "Not sent. The ask is open again.";

/** Returns the line for an answer the source or the controller refused: `reason` says why. */
export const describeAnswerFailure = (
  answer: { readonly label: string; readonly identifier: string; readonly sourceName: string },
  reason: string,
): string =>
  `${answer.label} ${answer.identifier} was not sent to ${answer.sourceName}: ${reason}. Try again.`;

/**
 * Returns the sentence for an answer that was not sent: why, in the words of
 * its `failure`. An answer left over from a closed app says so, and says
 * whether the source may have it; any other failure carries the controller's
 * message.
 */
export const describeUnsentSignalAnswer = (
  answer: { readonly label: string; readonly identifier: string; readonly sourceName: string },
  failure: { readonly reason: FailureReason; readonly message: string },
): string => {
  if (failure.reason === "interrupted") return APP_CLOSED_BEFORE_SENT;
  if (failure.reason === "interrupted-while-sending") return APP_CLOSED_WHILE_SENDING;
  return describeAnswerFailure(answer, failure.message);
};

/** Returns the line for Done after it ended an ask: the source was not told, and the user cannot undo it here. */
export const describeMarkedDone = (sourceName: string): string =>
  `Marked done. ${sourceName} was not told, and it can’t be undone here.`;

/** Returns what the Done answer does, shown before it is pressed. */
export const describeDoneEffect = (sourceName: string): string =>
  `Ends this ask here. ${sourceName} is not told.`;

/** The line for O while the pane shows a selection, since O opens only one thing. */
export const OPEN_AT_SOURCE_NEEDS_ONE_THING =
  "O opens one thing. Press Esc to clear the selection, then O on the thing you want.";

/** The line for a thing the user asked for that the list no longer holds. */
export const THING_NOT_IN_LIST = "That thing is not in this list.";

/** Returns the line for a part of the pane that could not be read: `reason` is why, from the controller. */
export const describeUnreadable = (part: "ask" | "thing", reason: string): string =>
  `This ${part} could not be read. ${reason}`;

/**
 * Returns the quiet line for the open asks the pane has no section for:
 * "3 more". It does not say "asks", because some of the hidden signals may be
 * snoozed or may not ask for a move.
 */
export const describeHiddenAsks = (count: number): string => `${String(count)} more`;

/** Returns the title of the selection pane: "1 thing selected", "3 things selected". */
export const describeSelectedThings = (count: number): string =>
  `${String(count)} ${count === 1 ? "thing" : "things"} selected`;

/** Returns an ask's name by who raised it: "Mei’s review request", or "the failing checks" when no one did. */
const nameAsk = (ask: Pick<InboxAsk, "asker" | "noun">): string =>
  ask.asker === undefined ? `the ${ask.noun}` : `${ask.asker}’s ${ask.noun}`;

/** Joins names as a sentence does: "a", "a and b", "a, b and c". */
const joinNames = (names: readonly string[]): string =>
  names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)!}`;

/**
 * Returns why a dismissed thing is back, such as "Dismissed 1 day ago, back for
 * Kwame’s mention", or `undefined` when the thing was never dismissed. The
 * reasons are the open asks raised after the dismissal, oldest first. A thing
 * whose row lists none of them (the row lists only the newest asks) gets just
 * "Dismissed 1 day ago".
 */
export const describeDismissalReturn = (
  thing: Pick<InboxThing, "dismissedAt" | "asks">,
  now: Date,
): string | undefined => {
  const { dismissedAt } = thing;
  if (dismissedAt === undefined) return undefined;
  const since = Date.parse(dismissedAt);
  const dismissed = `Dismissed ${describeAge(dismissedAt, now)}`;
  const back = thing.asks
    .filter((ask) => Date.parse(ask.createdAt) > since)
    .toSorted((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .map(nameAsk);
  return back.length === 0 ? dismissed : `${dismissed}, back for ${joinNames(back)}`;
};

/**
 * Returns the strong line of the strip that says who has a thing: "Your Task",
 * or "Review PR has it" for a live workflow. Returns `undefined` when no one
 * does. It reads the same rule as the list's row (`findHolder`).
 */
export const describeHolderStrip = (
  thing: Pick<InboxThing, "liveWorkflows" | "takenOn">,
): string | undefined => {
  const holder = findHolder(thing);
  if (holder === undefined) return undefined;
  return holder.kind === "you" ? "Your Task" : `${holder.name} has it`;
};
