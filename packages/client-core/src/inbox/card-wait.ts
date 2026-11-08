/**
 * The wait a card shows and the words about how old its facts are. Both take
 * `now` as a parameter, so a test can fix it.
 */
import type { EntityRecord } from "@hercule/contract";
import { describeDeskAge, findNextDeskAgeChange } from "../desk/age";
import { findNextAgeChange, formatAge } from "../threads/age";
import { readSentenceSignal, type CardRecord } from "./card-face";

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
export const describeCardWait = (card: EntityRecord, now: Date): CardWait | null => {
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
export const describeCardTrust = (card: EntityRecord, now: Date): string | undefined => {
  if (card.access === "deleted") return "Deleted at the source";
  const age = `Last read ${describeDeskAge(card.observedAt, now)}`;
  if (card.access === "inaccessible") return `No account can read this now. ${age}`;
  return card.stale ? age : undefined;
};

/** Checks whether the card's trust line counts the age of its facts. A deleted card says only that it is gone. */
const showsAgeOfFacts = (card: EntityRecord): boolean =>
  card.access !== "deleted" && (card.stale || card.access === "inaccessible");

/** Checks whether the card counts a wait: a fast kind that no live Task holds. */
const countsWait = (card: EntityRecord): boolean =>
  card.pace === "fast" && card.taskId === undefined;

/**
 * Returns when the latest signal of `card` landed, if the card draws how long
 * ago: a row of lasting work, with a sentence from a signal, that no live Task
 * holds. A request has its wait for that, and a card a Task holds says nothing new.
 */
const readSignalMoment = (card: CardRecord): string | undefined =>
  card.card === "rich" && card.taskId === undefined
    ? readSentenceSignal(card)?.createdAt
    : undefined;

/**
 * Checks whether anything a card shows depends on the time, so that a screen
 * draws it again as time passes: a wait that counts hours and days, the age of
 * facts that may be old, or how long ago its sentence's signal landed. A card that
 * shows none of them never changes by itself.
 */
export const isCardTimeDependent = (card: CardRecord): boolean =>
  countsWait(card) || showsAgeOfFacts(card) || readSignalMoment(card) !== undefined;

/** Everything a card shows that depends on the time. */
export interface CardTime {
  readonly wait: CardWait | null;
  readonly trust: string | undefined;
  /** How long ago the sentence's signal landed, as `formatAge` writes it ("4m"), or `undefined` when the card draws none. */
  readonly signalAge: string | undefined;
}

/** Returns the wait, the trust line and the age of the sentence of `card` at `now`. */
export const describeCardTime = (card: CardRecord, now: Date): CardTime => {
  const moment = readSignalMoment(card);
  return {
    wait: describeCardWait(card, now),
    trust: describeCardTrust(card, now),
    signalAge: moment === undefined ? undefined : formatAge(moment, now),
  };
};

/** A moment so far off that no timer reaches it: the next change of a card that never changes by itself. */
const NEVER = new Date(8.64e15);

/**
 * Returns the first moment after `now` at which `describeCardTime` returns
 * something different for `card`, so a screen sets one timer for it and draws
 * the card only then. It is `NEVER` for a card that is not time dependent.
 *
 * Four things change over time, and the earliest counts:
 *
 * - its text: the hour figure goes up each whole hour from the second hour
 *   (a wait under two hours reads "1h"), and once past a day, each whole day;
 * - its level, at a quarter of the kind's patience, at the patience, and at
 *   three times it;
 * - the age of the facts in the trust line, which changes by the day or week;
 * - the age of the sentence's signal (`findNextAgeChange`), which changes by
 *   the minute while it is under an hour old.
 */
export const findNextCardTimeChange = (card: CardRecord, now: Date): Date => {
  const changes: number[] = [];
  if (countsWait(card)) {
    const since = Date.parse(card.waitingSince ?? card.firstObservedAt);
    const hours = Math.max(0, now.getTime() - since) / HOUR_MS;
    const nextText =
      hours < 2 ? 2 : hours < 24 ? Math.floor(hours) + 1 : (Math.floor(hours / 24) + 1) * 24;
    const patience = Math.max(1, card.patience);
    const nextLevel = [0.25, 1, 3].map((share) => share * patience).find((at) => at > hours);
    // Rounded up, so the card is drawn at a moment the new text has certainly started.
    changes.push(Math.ceil(since + Math.min(nextText, nextLevel ?? Infinity) * HOUR_MS));
  }
  if (showsAgeOfFacts(card)) changes.push(findNextDeskAgeChange(card.observedAt, now).getTime());
  const moment = readSignalMoment(card);
  if (moment !== undefined) changes.push(findNextAgeChange(moment, now).getTime());
  return changes.length === 0 ? NEVER : new Date(Math.min(...changes));
};
