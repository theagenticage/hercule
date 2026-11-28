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
