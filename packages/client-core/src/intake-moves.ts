/**
 * The moves on Intake that send nothing to the source: Done, Snooze,
 * Unsnooze and Not urgent, on one row or on the checked rows in bulk. Also
 * the snooze menu's choices, the Later row's "Back" time, and the foot under
 * the list. Spec 17 §Intake owns the screen; spec 10 §9.4 and §9.7 own what
 * each move does to a signal.
 *
 * Every wall-clock time here is in the user's timezone setting, an IANA zone
 * passed by the caller, never the machine's zone. The caller passes a zone
 * this runtime can format, as `resolveDisplayTimezone` returns one.
 */
import { DONE_ACTION_ID, type Signal, type SignalView } from "@hercule/contract";
import { formatNameList } from "./name-list";
import { isSameDay } from "./time-context";

/** A move on a row or in the bulk bar that sends nothing to the source. */
export type SignalMove = "snooze" | "done" | "not-urgent" | "unsnooze";

/**
 * Checks whether a signal's kind offers Done: whether its actions hold the
 * core's `done` action. Every plugin kind and `fyi` do; `proposal`, `offer`
 * and `unsure` do not.
 */
export const hasDoneAction = (signal: Signal): boolean =>
  signal.actions.some((action) => action.id === DONE_ACTION_ID);

/** The controls a row shows, in the order the row draws them, and whether it has a checkbox. */
export interface SignalRowControls {
  readonly moves: ReadonlyArray<SignalMove>;
  readonly checkable: boolean;
}

/**
 * Decides which controls a row shows in `view`:
 *
 * - To do: Snooze, then Done when the kind offers it, then Not urgent on a
 *   Now row. A row back from a snooze follows its kind, like any other.
 * - Later: Unsnooze, then Done when the kind offers it.
 * - Done: no controls and no checkbox.
 */
export const decideSignalRowControls = (signal: Signal, view: SignalView): SignalRowControls => {
  if (view === "done") return { moves: [], checkable: false };
  const done: ReadonlyArray<SignalMove> = hasDoneAction(signal) ? ["done"] : [];
  if (view === "later") return { moves: ["unsnooze", ...done], checkable: true };
  const notUrgent: ReadonlyArray<SignalMove> = signal.priority === "urgent" ? ["not-urgent"] : [];
  return { moves: ["snooze", ...done, ...notUrgent], checkable: true };
};

/**
 * Returns the bulk bar's buttons for the rows checked in `view`, in drawing
 * order: Snooze on To do and Unsnooze on Later, then Done when at least one
 * checked row offers it. The Done view has no bulk bar, so it returns none.
 */
export const listBulkMoves = (
  checked: ReadonlyArray<Signal>,
  view: SignalView,
): ReadonlyArray<SignalMove> => {
  if (view === "done") return [];
  const first: SignalMove = view === "later" ? "unsnooze" : "snooze";
  return checked.some(hasDoneAction) ? [first, "done"] : [first];
};

/** What one move does to the checked rows, or to the one row it is made on. */
export interface BulkPlan {
  readonly move: SignalMove;
  /** The ids the call is sent with: the rows the move applies to, in list order. */
  readonly signalIds: ReadonlyArray<string>;
  /** The rows the move leaves alone. They stay checked, and fade while the button is hovered. */
  readonly keptIds: ReadonlyArray<string>;
  /** The bar's line while the button has hover or focus: "Done 3 · keeps 2 proposals", "Snooze 5". */
  readonly preview: string;
  /** The rows the move leaves alone, named by kind: "2 proposals and 1 offer". Empty when none. */
  readonly keptLabel: string;
}

/** The label of each move's button, as the bar's line starts with it. */
const MOVE_LABELS: Readonly<Record<SignalMove, string>> = {
  snooze: "Snooze",
  done: "Done",
  unsnooze: "Unsnooze",
  "not-urgent": "Not urgent",
};

/** Checks whether `move` applies to `signal`; the server would skip or refuse the rest. */
const isMoveApplicable = (move: SignalMove, signal: Signal): boolean => {
  switch (move) {
    case "snooze":
      return true;
    case "done":
      return hasDoneAction(signal);
    case "unsnooze":
      return signal.snooze !== undefined;
    case "not-urgent":
      return signal.priority === "urgent";
  }
};

/**
 * The singular and the plural noun for the signals of each core kind, as a
 * sentence counts them. A plugin kind is counted as "signal", because every
 * plugin kind offers Done and so is only left alone by Not urgent.
 */
const KIND_NOUNS: Readonly<Record<string, readonly [string, string]>> = {
  proposal: ["proposal", "proposals"],
  offer: ["offer", "offers"],
  unsure: ["unsure signal", "unsure signals"],
  fyi: ["FYI", "FYIs"],
};

/**
 * Counts `signals` by kind, as a sentence names them: "2 proposals and 1
 * offer". The kinds are listed in the order they first appear. Returns ""
 * for no signals.
 */
const countSignalsByKind = (signals: ReadonlyArray<Signal>): string => {
  // Keyed by the singular noun, so every plugin kind is counted together.
  const counts = new Map<string, { readonly plural: string; count: number }>();
  for (const signal of signals) {
    const [singular, plural] = KIND_NOUNS[signal.kind] ?? ["signal", "signals"];
    const held = counts.get(singular) ?? { plural, count: 0 };
    held.count += 1;
    counts.set(singular, held);
  }
  return formatNameList(
    [...counts].map(
      ([singular, { plural, count }]) => `${String(count)} ${count === 1 ? singular : plural}`,
    ),
    "and",
  );
};

/**
 * Plans `move` over the checked rows: which ids the call sends, which rows
 * it leaves alone, and the line the bar shows while the button has hover or
 * focus.
 *
 * - Snooze applies to every row; Unsnooze to the snoozed ones.
 * - Done applies to the rows whose kind offers it.
 * - Not urgent applies to the Now rows.
 *
 * The line names the kept rows by kind, never by where they came from, such
 * as "Done 3 · keeps 2 proposals", because any run can raise a core kind.
 * When the move applies to every row, the line is the label and the count:
 * "Snooze 5".
 */
export const planBulkAction = (checked: ReadonlyArray<Signal>, move: SignalMove): BulkPlan => {
  const acted = checked.filter((signal) => isMoveApplicable(move, signal));
  const kept = checked.filter((signal) => !isMoveApplicable(move, signal));
  const keptLabel = countSignalsByKind(kept);
  const head = `${MOVE_LABELS[move]} ${String(acted.length)}`;
  return {
    move,
    signalIds: acted.map((signal) => signal.id),
    keptIds: kept.map((signal) => signal.id),
    preview: keptLabel === "" ? head : `${head} · keeps ${keptLabel}`,
    keptLabel,
  };
};

/**
 * Returns the toast shown after a move succeeded. One row reads without a
 * count, more rows name theirs:
 *
 * - Snooze: "Snoozed until Monday 09:00", "Snoozed 3 until Monday 09:00".
 *   `untilLabel` is `describeSnoozeUntil`'s; without it the toast reads
 *   "Snoozed".
 * - Done: "Marked done", "Marked 3 done", then ". Kept 2 proposals" when
 *   some rows were left alone.
 * - Unsnooze: "Back on To do", "3 back on To do".
 * - Not urgent: "Moved out of Now", "Moved 3 out of Now".
 */
export const describeMoveToast = (plan: BulkPlan, untilLabel?: string): string => {
  const count = plan.signalIds.length;
  const many = count === 1 ? "" : ` ${String(count)}`;
  switch (plan.move) {
    case "snooze":
      return `Snoozed${many}${untilLabel === undefined ? "" : ` until ${untilLabel}`}`;
    case "done":
      return `Marked${many} done${plan.keptLabel === "" ? "" : `. Kept ${plan.keptLabel}`}`;
    case "unsnooze":
      return count === 1 ? "Back on To do" : `${String(count)} back on To do`;
    case "not-urgent":
      return `Moved${many} out of Now`;
  }
};

/** A calendar date: the year, the month from 1 to 12, and the day of the month. */
interface CalendarDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/** A calendar date and the time on the clock, as someone in one zone reads an instant. */
interface WallClock extends CalendarDate {
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

/** The formatters built so far, one per zone: building one is slow, reusing it is cheap. */
const formatters = new Map<string, Intl.DateTimeFormat>();

/**
 * Reads the date and the clock time of `instant` in `timezone`. Fails with a
 * `RangeError` when this runtime cannot format the zone.
 */
const readWallClock = (instant: number, timezone: string): WallClock => {
  let formatter = formatters.get(timezone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      hourCycle: "h23",
    });
    formatters.set(timezone, formatter);
  }
  const parts = formatter.formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
  };
};

/**
 * Returns a calendar date as the number of days since 1 January 1970, so two
 * consecutive dates differ by exactly 1, however long the day between them
 * was in some zone.
 */
const countDaysSinceEpoch = (date: CalendarDate): number =>
  Date.UTC(date.year, date.month - 1, date.day) / 86_400_000;

/** Returns the calendar date `days` after `date`, rolling over months and years. */
const addDays = (date: CalendarDate, days: number): CalendarDate => {
  const moved = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: moved.getUTCFullYear(), month: moved.getUTCMonth() + 1, day: moved.getUTCDate() };
};

/**
 * Computes the instant at which the clock in `timezone` reads `hour:minute`
 * on `date`, in milliseconds since 1970. Returns `null` when the clock never
 * reads that time on that date, as in the hour skipped when daylight saving
 * time starts. When the clock reads it twice, as in the hour repeated when
 * daylight saving time ends, the later instant is returned.
 */
const computeZonedInstant = (
  date: CalendarDate,
  hour: number,
  minute: number,
  timezone: string,
): number | null => {
  const asIfUtc = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  const offsetAt = (instant: number): number => {
    const clock = readWallClock(instant, timezone);
    const read = Date.UTC(
      clock.year,
      clock.month - 1,
      clock.day,
      clock.hour,
      clock.minute,
      clock.second,
    );
    return read - (instant - (((instant % 1000) + 1000) % 1000));
  };
  // The zone's offset at the guess can differ from its offset at the answer
  // when a daylight saving change falls between the two, so it is read twice.
  const firstOffset = offsetAt(asIfUtc);
  let instant = asIfUtc - firstOffset;
  const secondOffset = offsetAt(instant);
  if (secondOffset !== firstOffset) instant = asIfUtc - secondOffset;
  const clock = readWallClock(instant, timezone);
  const matches =
    clock.year === date.year &&
    clock.month === date.month &&
    clock.day === date.day &&
    clock.hour === hour &&
    clock.minute === minute;
  return matches ? instant : null;
};

/**
 * Computes the instant of a fixed menu time, 09:00, 14:00 or 18:00, on
 * `date` in `timezone`, as an ISO instant. No zone skips those hours when its
 * clock changes, so the time always exists.
 */
const computeMenuInstant = (date: CalendarDate, hour: number, timezone: string): string =>
  new Date(computeZonedInstant(date, hour, 0, timezone)!).toISOString();

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Returns the weekday of a calendar date, 0 for Sunday to 6 for Saturday. */
const readWeekday = (date: CalendarDate): number =>
  new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();

/** Formats the clock time of a wall clock on a 24-hour clock: "09:05". */
const formatClock = (clock: WallClock): string =>
  `${String(clock.hour).padStart(2, "0")}:${String(clock.minute).padStart(2, "0")}`;

/** The snooze menu's keys, which never move: 2 stays the afternoon or evening choice all day. */
type SnoozeChoiceKey = 1 | 2 | 3 | 4 | 5;

/** One choice of the snooze menu. */
export interface SnoozeChoice {
  readonly key: SnoozeChoiceKey;
  /** "In 1 hour", "This afternoon", "This evening", "Tomorrow", "Monday" or "Pick a time". */
  readonly label: string;
  /** The exact time shown beside the label: "14:00" today, "Monday 09:00" on another day. `null` for Pick a time. */
  readonly timeLabel: string | null;
  /** The ISO instant the signal comes back. `null` for Pick a time, and while the choice is disabled. */
  readonly until: string | null;
  readonly disabled: boolean;
}

/**
 * Formats the time a menu choice shows beside its label: the clock time
 * when it falls on the day of `now`, and the weekday and the clock time
 * otherwise, such as "Monday 09:00".
 */
const formatMenuTime = (until: number, today: CalendarDate, timezone: string): string => {
  const clock = readWallClock(until, timezone);
  return countDaysSinceEpoch(clock) === countDaysSinceEpoch(today)
    ? formatClock(clock)
    : `${WEEKDAYS[readWeekday(clock)]!} ${formatClock(clock)}`;
};

/**
 * Builds the snooze menu's five choices from `now`, in `timezone`, the
 * user's timezone setting:
 *
 * 1. In 1 hour.
 * 2. This afternoon at 14:00 before 13:00; This evening at 18:00 from 13:00.
 *    From 17:00 This evening is disabled, so key 2 never moves to another
 *    choice.
 * 3. Tomorrow at 09:00.
 * 4. Monday at 09:00: the next Monday, a week ahead on a Monday.
 * 5. Pick a time, which has no time of its own.
 *
 * Days are counted on the calendar in `timezone`, never as 24 hours, so a
 * day on which the clock changes still ends at 09:00 on the next one.
 */
export const buildSnoozeChoices = (now: Date, timezone: string): ReadonlyArray<SnoozeChoice> => {
  const clock = readWallClock(now.getTime(), timezone);
  const minutesOfDay = clock.hour * 60 + clock.minute;

  const inAnHour = now.getTime() + 3_600_000;
  const evening = minutesOfDay >= 13 * 60;
  const lateEvening = minutesOfDay >= 17 * 60;
  const tomorrow = addDays(clock, 1);
  // Monday is weekday 1; on a Monday itself the choice is a week ahead.
  const monday = addDays(clock, (8 - readWeekday(clock)) % 7 || 7);

  const fixedChoice = (
    key: SnoozeChoiceKey,
    label: string,
    date: CalendarDate,
    hour: number,
  ): SnoozeChoice => {
    const until = computeMenuInstant(date, hour, timezone);
    return {
      key,
      label,
      timeLabel: formatMenuTime(Date.parse(until), clock, timezone),
      until,
      disabled: false,
    };
  };

  return [
    {
      key: 1,
      label: "In 1 hour",
      timeLabel: formatMenuTime(inAnHour, clock, timezone),
      until: new Date(inAnHour).toISOString(),
      disabled: false,
    },
    lateEvening
      ? { key: 2, label: "This evening", timeLabel: "18:00", until: null, disabled: true }
      : fixedChoice(2, evening ? "This evening" : "This afternoon", clock, evening ? 18 : 14),
    fixedChoice(3, "Tomorrow", tomorrow, 9),
    fixedChoice(4, "Monday", monday, 9),
    { key: 5, label: "Pick a time", timeLabel: null, until: null, disabled: false },
  ];
};

/**
 * Describes when a snoozed signal comes back, for the Later row ("Back " and
 * this) and the toast ("Snoozed until " and this), counted in calendar days
 * from `now` in `timezone`:
 *
 * - "today 14:00" and "tomorrow 09:00", in lowercase because the label sits
 *   inside a sentence: "Back today 14:00";
 * - the weekday from 2 to 7 days ahead: "Monday 09:00", which is also a
 *   Monday snooze picked on a Monday;
 * - the date for any other day, such as a time picked further ahead: "4 Nov
 *   09:00".
 */
export const describeSnoozeUntil = (until: string, now: Date, timezone: string): string => {
  const clock = readWallClock(Date.parse(until), timezone);
  const days =
    countDaysSinceEpoch(clock) - countDaysSinceEpoch(readWallClock(now.getTime(), timezone));
  const time = formatClock(clock);
  if (days === 0) return `today ${time}`;
  if (days === 1) return `tomorrow ${time}`;
  if (days >= 2 && days <= 7) return `${WEEKDAYS[readWeekday(clock)]!} ${time}`;
  return `${String(clock.day)} ${MONTHS[clock.month - 1]!} ${time}`;
};

/**
 * Converts the time picked under Pick a time, a wall-clock time
 * `yyyy-mm-ddThh:mm` in `timezone` as a date and time field gives it, to the
 * ISO instant `signal.snooze` takes. Returns `null` when the text is not such
 * a time, when the clock in `timezone` never reads it (the hour skipped when
 * daylight saving time starts), or when it is not after `now`, because the
 * server refuses a time in the past.
 */
export const parsePickedSnoozeTime = (
  local: string,
  now: Date,
  timezone: string,
): string | null => {
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (parts === null) return null;
  const [year, month, day, hour, minute] = parts.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  // The zone check below also refuses a date such as 31 February, because
  // the clock never reads it.
  if (hour > 23 || minute > 59) return null;
  const instant = computeZonedInstant({ year, month, day }, hour, minute, timezone);
  if (instant === null || instant <= now.getTime()) return null;
  return new Date(instant).toISOString();
};

/** The two numbers the foot under the list shows. */
export interface ClearedToday {
  /** The signals resolved since midnight. */
  readonly cleared: number;
  /** Those of them the user's own move did not end: withdrawn, or decided on the source. */
  readonly leftOnTheirOwn: number;
}

/**
 * Counts the signals among `done`, the Done view's, resolved since midnight
 * of `now` in `timezone`. A replaced signal is not counted: its successor
 * still asks the same move. A signal counts as left on its own unless the
 * user decided it, the same rule `describeSignalOutcome` labels with.
 */
export const countClearedToday = (
  done: ReadonlyArray<Signal>,
  now: Date,
  timezone: string,
): ClearedToday => {
  const today = done.flatMap((signal) =>
    signal.resolution !== undefined &&
    signal.replacedBy === undefined &&
    isSameDay(new Date(signal.resolution.at), now, timezone)
      ? [signal.resolution]
      : [],
  );
  return {
    cleared: today.length,
    leftOnTheirOwn: today.filter(
      (resolution) => !(resolution.kind === "decided" && resolution.actor === "user"),
    ).length,
  };
};

/**
 * Returns the foot under the list: "7 cleared today. 3 left on their own:
 * answered elsewhere or withdrawn. See Done.", or "7 cleared today. See
 * Done." when none were left on their own. Returns `null` when none were
 * cleared, because then there is no foot.
 */
export const describeIntakeFoot = (cleared: ClearedToday): string | null => {
  if (cleared.cleared === 0) return null;
  const count = `${String(cleared.cleared)} cleared today.`;
  return cleared.leftOnTheirOwn === 0
    ? `${count} See Done.`
    : `${count} ${String(cleared.leftOnTheirOwn)} left on their own: answered elsewhere or withdrawn. See Done.`;
};

/**
 * Checks whether the Done list read so far holds a signal resolved before
 * midnight of `now` in `timezone`. The list is newest first, so once it does,
 * it holds every signal resolved today, and no older page is needed for the
 * foot's count. Returns false for an empty list.
 */
export const reachesBeforeToday = (
  done: ReadonlyArray<Signal>,
  now: Date,
  timezone: string,
): boolean =>
  done.some(
    (signal) =>
      signal.resolution !== undefined && !isSameDay(new Date(signal.resolution.at), now, timezone),
  );

/**
 * Returns the outcome a Done row shows: "Replaced by a newer one" for a
 * signal a newer one replaced, and the resolution's stored outcome line
 * otherwise. The Done view holds only resolved signals, so a signal with no
 * resolution returns "".
 */
export const describeDoneRowOutcome = (signal: Signal): string =>
  signal.replacedBy !== undefined ? "Replaced by a newer one" : (signal.resolution?.outcome ?? "");

/**
 * Returns the checked rows with `signalId` toggled: checked when it was not,
 * unchecked when it was. `X` calls it on the selected row; the shifted keys
 * call it on each row the selection moves onto. Returns a new set and leaves
 * `checked` as it was.
 */
export const toggleSignalCheck = (
  checked: ReadonlySet<string>,
  signalId: string,
): ReadonlySet<string> => {
  const next = new Set(checked);
  if (!next.delete(signalId)) next.add(signalId);
  return next;
};
