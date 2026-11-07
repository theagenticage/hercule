/**
 * The wait a card shows and the words about how old its facts are. Both take
 * `now` as a parameter, so a test can fix it.
 */
import type { InboxCard } from "@hercule/contract";
import { describeDeskAge } from "../desk/age";

const HOUR_MS = 60 * 60 * 1000;

/**
 * How much of its patience a wait has used, which sets the ink and weight of
 * the figure (never a colour, which is the status shape's job):
 *
 * - `fresh`: under a quarter of the patience;
 * - `recent`: a quarter up to the whole patience;
 * - `due`: the whole patience up to three times it;
 * - `over`: three times the patience or more. It draws in full ink and bold.
 */
export type WaitLevel = "fresh" | "recent" | "due" | "over";

/** The wait of a card on the clock. */
export interface CardWait {
  /** A short figure: "5h" under a day, then "5d". */
  readonly text: string;
  /** For a screen reader, such as "Waiting 5 days". */
  readonly words: string;
  readonly level: WaitLevel;
}

const decideLevel = (hours: number, patience: number): WaitLevel => {
  const used = hours / Math.max(1, patience);
  if (used >= 3) return "over";
  if (used >= 1) return "due";
  if (used >= 0.25) return "recent";
  return "fresh";
};

/**
 * Returns the wait of `card`, or `null` when it shows none: a kind with
 * `pace: slow` has no clock, and a card with a live Task is held by someone,
 * so its wait has ended. The wait counts from `waitingSince`, or from the
 * first observation when the card has none. Hours are rounded down, and a wait
 * under an hour reads "1h".
 */
export const describeCardWait = (card: InboxCard, now: Date): CardWait | null => {
  if (card.pace !== "fast" || card.taskId !== undefined) return null;
  const since = Date.parse(card.waitingSince ?? card.firstObservedAt);
  const hours = Math.max(0, now.getTime() - since) / HOUR_MS;
  const inDays = hours >= 24;
  const count = inDays ? Math.floor(hours / 24) : Math.max(1, Math.floor(hours));
  return {
    text: `${String(count)}${inDays ? "d" : "h"}`,
    words: `Waiting ${String(count)} ${inDays ? "day" : "hour"}${count === 1 ? "" : "s"}`,
    level: decideLevel(hours, card.patience),
  };
};

/**
 * Returns the line that tells the user a card may be out of date, or
 * `undefined` when its facts are as fresh as they can be:
 *
 * - `deleted`: the source said the thing is gone;
 * - `inaccessible`: no account can read it now, and the facts are the last known;
 * - `stale`: no account can poll now, so the age of the facts shows.
 */
export const describeCardTrust = (card: InboxCard, now: Date): string | undefined => {
  if (card.access === "deleted") return "Deleted at the source";
  const age = `Last read ${describeDeskAge(card.observedAt, now)}`;
  if (card.access === "inaccessible") return `No account can read this now. ${age}`;
  return card.stale ? age : undefined;
};

/**
 * Checks whether anything a card shows depends on the time, so that a screen
 * draws it again as time passes: a wait that counts hours and days, or the age
 * of facts that may be old. A card that shows neither never changes by itself.
 */
export const isCardTimeDependent = (card: InboxCard): boolean =>
  (card.pace === "fast" && card.taskId === undefined) || card.stale || card.access !== "ok";
