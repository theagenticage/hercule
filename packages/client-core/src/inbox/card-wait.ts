import type { EntityRecord } from "@hercule/contract";
import { describeDeskAge, findNextDeskAgeChange } from "../desk/age";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** The units a stretch of time is written in, largest first. A month is 30 days. */
const SPAN_UNITS = [
  { ms: 30 * DAY_MS, suffix: "mo", word: "month" },
  { ms: 7 * DAY_MS, suffix: "w", word: "week" },
  { ms: DAY_MS, suffix: "d", word: "day" },
  { ms: HOUR_MS, suffix: "h", word: "hour" },
  { ms: MINUTE_MS, suffix: "m", word: "minute" },
] as const;

/** A stretch of time written short ("5d") and in words ("5 days"). */
export interface Span {
  readonly text: string;
  readonly words: string;
}

/**
 * Returns the time from `since` to `now`, rounded down to the largest unit it
 * fills: "now", "12m", "3h", "5d", "2w" or "4mo". A moment after `now` counts
 * as no time at all. A row of the list and the open card write their ages
 * with this one function.
 */
export const measureSpan = (since: string, now: Date): Span => {
  const elapsed = Math.max(0, now.getTime() - Date.parse(since));
  const unit = SPAN_UNITS.find((candidate) => elapsed >= candidate.ms);
  if (unit === undefined) return { text: "now", words: "less than a minute" };
  const count = Math.floor(elapsed / unit.ms);
  return {
    text: `${String(count)}${unit.suffix}`,
    words: `${String(count)} ${unit.word}${count === 1 ? "" : "s"}`,
  };
};

/**
 * How much of its patience a wait has used, which sets the ink and weight of
 * the figure (never a colour, which is the status shape's job):
 *
 * - `fresh`: under half the patience;
 * - `recent`: half the patience up to the whole;
 * - `due`: the whole patience up to three times it;
 * - `over`: three times the patience or more. It draws in full ink and bold.
 */
export type WaitLevel = "fresh" | "recent" | "due" | "over";

/** The shares of the patience at which a wait becomes `recent`, `due` and `over`. */
const LEVEL_SHARES = [0.5, 1, 3] as const;

/** How long a wait has lasted: a short figure, words for a screen reader, and how much patience it has used. */
export interface CardWait {
  /** A short figure such as "12m", "5h" or "5d". */
  readonly text: string;
  /** For a screen reader, such as "Waiting 5 days, overdue". */
  readonly words: string;
  readonly level: WaitLevel;
}

const decideLevel = (hours: number, patienceHours: number): WaitLevel => {
  const used = hours / Math.max(1, patienceHours);
  if (used >= LEVEL_SHARES[2]) return "over";
  if (used >= LEVEL_SHARES[1]) return "due";
  return used >= LEVEL_SHARES[0] ? "recent" : "fresh";
};

const LEVEL_WORDS: Readonly<Record<WaitLevel, string>> = {
  fresh: "",
  recent: "",
  due: ", due",
  over: ", overdue",
};

/**
 * Returns the wait that began at `since`, measured against a patience in
 * hours. A row of the list and the open card both draw a wait with this one.
 */
export const describeWaitSince = (since: string, patienceHours: number, now: Date): CardWait => {
  const span = measureSpan(since, now);
  const hours = Math.max(0, now.getTime() - Date.parse(since)) / HOUR_MS;
  const level = decideLevel(hours, patienceHours);
  return { text: span.text, words: `Waiting ${span.words}${LEVEL_WORDS[level]}`, level };
};

/**
 * Returns the wait of `card`, or `null` when it shows none: a kind with
 * `pace: slow` has no clock, and a card with a live Task is held by someone,
 * so its wait has ended. The wait counts from `waitingSince`, or from the
 * first observation when the card has none.
 */
export const describeCardWait = (card: EntityRecord, now: Date): CardWait | null =>
  countsWait(card)
    ? describeWaitSince(card.waitingSince ?? card.firstObservedAt, card.patience, now)
    : null;

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
 * Checks whether anything a card shows depends on the time, so that a screen
 * draws it again as time passes: a wait that counts minutes up to months, or
 * the age of facts that may be old. A card that shows neither never changes by
 * itself.
 */
export const isCardTimeDependent = (card: EntityRecord): boolean =>
  countsWait(card) || showsAgeOfFacts(card);

/** A moment so far off that no timer reaches it: the next change of a card that never changes by itself. */
const NEVER = new Date(8.64e15);

/**
 * Returns the first moment after `now` at which a wait's text or level
 * changes. The text changes at each whole unit of `measureSpan`, and at the
 * start of the next larger unit when that comes first (4 weeks turn into a
 * month before 5 weeks). The level changes at half the patience, at the
 * patience, and at three times it.
 */
const findNextWaitChange = (since: number, patienceHours: number, now: Date): number => {
  const elapsed = Math.max(0, now.getTime() - since);
  const unitIndex = SPAN_UNITS.findIndex((candidate) => elapsed >= candidate.ms);
  const unit = SPAN_UNITS[unitIndex];
  const nextText =
    unit === undefined
      ? MINUTE_MS
      : Math.min(
          (Math.floor(elapsed / unit.ms) + 1) * unit.ms,
          SPAN_UNITS[unitIndex - 1]?.ms ?? Infinity,
        );
  const patience = Math.max(1, patienceHours) * HOUR_MS;
  const nextLevel = LEVEL_SHARES.map((share) => share * patience).find((at) => at > elapsed);
  // Counted from `now`, not from `since`, so a wait that has not started yet (`since`
  // after `now`) still looks again soon. Rounded up, so the card is drawn at a moment
  // the new text has certainly started.
  return Math.ceil(now.getTime() - elapsed + Math.min(nextText, nextLevel ?? Infinity));
};

/**
 * Returns the first moment after `now` at which `describeCardWait` or
 * `describeCardTrust` returns something different for `card`, so a screen sets one timer for it and draws
 * the card only then. It is `NEVER` for a card that is not time dependent.
 * The earliest of these counts: the wait's text and level
 * (`findNextWaitChange`), and the age of the facts in the trust line, which
 * changes by the day or week.
 */
export const findNextCardTimeChange = (card: EntityRecord, now: Date): Date => {
  const changes: number[] = [];
  if (countsWait(card)) {
    const since = Date.parse(card.waitingSince ?? card.firstObservedAt);
    changes.push(findNextWaitChange(since, card.patience, now));
  }
  if (showsAgeOfFacts(card)) changes.push(findNextDeskAgeChange(card.observedAt, now).getTime());
  return changes.length === 0 ? NEVER : new Date(Math.min(...changes));
};
