/**
 * The moves on Intake that send nothing to the source: Done, Snooze,
 * Unsnooze and Not urgent, on one row, in the pane, or on the checked rows
 * in bulk. Also the snooze menu's choices, the Later pane's snooze line, and
 * the foot under the list. Spec 17 §Intake owns the screen; spec 10 §9.4 and
 * §9.7 own what each move does to a signal.
 *
 * Every wall-clock time here is in the user's timezone setting, an IANA zone
 * passed by the caller, never the machine's zone. The caller passes a zone
 * this runtime can format, as `resolveDisplayTimezone` returns one.
 */
import { DONE_ACTION_ID, type Signal, type SignalView } from "@hercule/contract";
import { lowerFirst, nameSignalKind } from "./intake";
import { formatNameList } from "./name-list";
import { parsePluginId } from "./plugin-id";
import {
  addCalendarDays,
  computeMinutesOfDay,
  computeWeekday,
  computeZonedInstant,
  formatClock,
  formatRelativeDay,
  formatRelativeMoment,
  formatShortMoment,
  isSameDay,
  readWallClock,
  type CalendarDate,
} from "./time-context";

/** A move on a row, in the pane, or in the bulk bar that sends nothing to the source. */
export type SignalMove = "snooze" | "done" | "not-urgent" | "unsnooze";

/** The label of each move's button, and the first word of the bulk bar's line. */
export const SIGNAL_MOVE_LABELS: Readonly<Record<SignalMove, string>> = {
  snooze: "Snooze",
  done: "Done",
  unsnooze: "Unsnooze",
  "not-urgent": "Not urgent",
};

/**
 * Checks whether a signal's kind offers Done: whether its actions hold the
 * core's `done` action. `fyi` and the plugin kinds that declare it do;
 * `proposal`, `offer` and `unsure` do not.
 */
export const hasDoneAction = (signal: Signal): boolean =>
  signal.actions.some((action) => action.id === DONE_ACTION_ID);

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

/** The moves each view offers on a row, in the order the row draws them. */
const ROW_MOVES: Readonly<Record<SignalView, ReadonlyArray<SignalMove>>> = {
  "to-do": ["snooze", "done", "not-urgent"],
  later: ["unsnooze", "done"],
  done: [],
};

/** The controls a row shows, and whether it has a checkbox. */
interface SignalRowControls {
  /**
   * The row's moves in the order the row draws them. `null` is an empty
   * place the row keeps, so the moves line up down the list.
   */
  readonly slots: ReadonlyArray<SignalMove | null>;
  readonly checkable: boolean;
}

/**
 * Decides which controls a row shows in `view`:
 *
 * - To do: Snooze, then Done, then Not urgent on a Now row. A row back from
 *   a snooze follows its kind, like any other.
 * - Later: Unsnooze, then Done.
 * - Done: no controls and no checkbox.
 *
 * A kind that does not offer Done keeps an empty place for it. Not urgent
 * gets no place outside Now, because Now is a section of its own, so its
 * rows line up with each other.
 */
export const decideSignalRowControls = (signal: Signal, view: SignalView): SignalRowControls => ({
  slots: ROW_MOVES[view].flatMap((move) =>
    isMoveApplicable(move, signal) ? [move] : move === "not-urgent" ? [] : [null],
  ),
  checkable: view !== "done",
});

/**
 * Returns the bulk bar's buttons for the rows checked in `view`, in the
 * order the rows draw them: Snooze on To do and Unsnooze on Later, then Done
 * when at least one checked row offers it. Not urgent is never in the bar.
 * The Done view has no bulk bar, so it returns none.
 */
export const listBulkMoves = (
  checked: ReadonlyArray<Signal>,
  view: SignalView,
): ReadonlyArray<SignalMove> =>
  ROW_MOVES[view].filter(
    (move) => move !== "not-urgent" && checked.some((signal) => isMoveApplicable(move, signal)),
  );

/** One of the pane's own moves, under its answers, as the pane draws it. */
export interface SignalPaneMove {
  /** The move it makes, or `open-newer` to open the signal that replaced this one. */
  readonly move: SignalMove | "open-newer";
  readonly label: string;
  readonly describe: string;
}

/**
 * Decides the pane's own moves for `signal`, shown in `view`:
 *
 * - a replaced signal: Open the newer one;
 * - an open signal on Later: Unsnooze, then Snooze again…;
 * - an open signal on To do: Snooze…, then Not urgent for a Now signal;
 * - any other resolved signal: none.
 */
export const decideSignalPaneMoves = (
  signal: Signal,
  view: SignalView,
): ReadonlyArray<SignalPaneMove> => {
  if (signal.replacedBy !== undefined)
    return [
      {
        move: "open-newer",
        label: "Open the newer one",
        describe: "A newer signal asks the same thing",
      },
    ];
  if (signal.status !== "open") return [];
  if (view === "later")
    return [
      { move: "unsnooze", label: "Unsnooze", describe: "Puts it back on To do now" },
      {
        move: "snooze",
        label: "Snooze again…",
        describe: "Changes when it comes back. Only for you",
      },
    ];
  const snooze: SignalPaneMove = {
    move: "snooze",
    label: "Snooze…",
    describe: "Hides it from To do until a time you pick. Only for you",
  };
  return isMoveApplicable("not-urgent", signal)
    ? [
        snooze,
        { move: "not-urgent", label: "Not urgent", describe: "Moves it out of Now. Only for you" },
      ]
    : [snooze];
};

/** What one move does to the checked rows, or to the one row it is made on. */
export interface SignalMovePlan {
  readonly move: SignalMove;
  /** The rows the move applies to, in list order. The call is sent with their ids. */
  readonly acted: ReadonlyArray<Signal>;
  /** The rows the move leaves alone. They stay checked, and fade while the button is hovered. */
  readonly keptIds: ReadonlyArray<string>;
  /** The bar's line while the button has hover or focus: "Done 3 · keeps 2 proposals", "Snooze 5". */
  readonly preview: string;
  /** The rows the move leaves alone, named by kind: "2 proposals and 1 offer". Empty when none. */
  readonly keptLabel: string;
}

/**
 * The singular and the plural noun for the signals of each core kind, as a
 * sentence counts them. A plugin kind is counted by its kind's label, such
 * as "1 review requested", because its label is no noun to make plural.
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
  const counts = new Map<string, number>();
  for (const signal of signals) counts.set(signal.kind, (counts.get(signal.kind) ?? 0) + 1);
  return formatNameList(
    [...counts].map(([kind, count]) => {
      const label = lowerFirst(nameSignalKind(kind));
      const [singular, plural] = KIND_NOUNS[kind] ?? [label, label];
      return `${String(count)} ${count === 1 ? singular : plural}`;
    }),
    "and",
  );
};

/**
 * Plans `move` over the checked rows, or over the one row it is made on:
 * which rows the call sends, which it leaves alone, and the line the bar
 * shows while the button has hover or focus.
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
export const planSignalMove = (
  checked: ReadonlyArray<Signal>,
  move: SignalMove,
): SignalMovePlan => {
  const acted = checked.filter((signal) => isMoveApplicable(move, signal));
  const kept = checked.filter((signal) => !isMoveApplicable(move, signal));
  const keptLabel = countSignalsByKind(kept);
  const head = `${SIGNAL_MOVE_LABELS[move]} ${String(acted.length)}`;
  return {
    move,
    acted,
    keptIds: kept.map((signal) => signal.id),
    preview: keptLabel === "" ? head : `${head} · keeps ${keptLabel}`,
    keptLabel,
  };
};

/**
 * Returns the title of the bulk Done button when Done leaves some checked
 * rows alone, so the pointer shows the split before the click: "Marks 3 of
 * 5 done. 2 proposals need their own answer". Returns `null` for any other
 * move, which applies to every row the bar offers it on, and for a Done
 * that applies to every checked row; the button then keeps its plain title.
 */
export const describeBulkDoneTitle = (plan: SignalMovePlan): string | null => {
  const kept = plan.keptIds.length;
  if (plan.move !== "done" || kept === 0) return null;
  const marked = `Marks ${String(plan.acted.length)} of ${String(plan.acted.length + kept)} done`;
  return `${marked}. ${plan.keptLabel} ${kept === 1 ? "needs its" : "need their"} own answer`;
};

/**
 * Returns the toast shown after a move succeeded. `movedIds` are the ids the
 * server reports it moved, so a row it skipped, because it was resolved
 * meanwhile, is not counted. One row reads without a count, more rows name
 * theirs:
 *
 * - Snooze: "Snoozed until Monday 09:00", "Snoozed 3 until Monday 09:00".
 *   `untilLabel` is `formatRelativeMoment`'s; without it the toast reads
 *   "Snoozed".
 * - Done: "Done · <title>" for one row with none kept; otherwise "Marked 3
 *   done", then ". Kept 2 proposals" when the plan left rows alone.
 * - Unsnooze: "Back on To do", "3 back on To do".
 * - Not urgent: "Moved out of Now", "Moved 3 out of Now".
 */
export const describeMoveToast = (
  plan: SignalMovePlan,
  movedIds: ReadonlyArray<string>,
  untilLabel?: string,
): string => {
  const count = movedIds.length;
  const many = count === 1 ? "" : ` ${String(count)}`;
  switch (plan.move) {
    case "snooze":
      return `Snoozed${many}${untilLabel === undefined ? "" : ` until ${untilLabel}`}`;
    case "done": {
      const only = count === 1 ? plan.acted.find((signal) => signal.id === movedIds[0]) : undefined;
      if (only !== undefined && plan.keptLabel === "") return `Done · ${only.title}`;
      return `Marked ${String(count)} done${plan.keptLabel === "" ? "" : `. Kept ${plan.keptLabel}`}`;
    }
    case "unsnooze":
      return count === 1 ? "Back on To do" : `${String(count)} back on To do`;
    case "not-urgent":
      return `Moved${many} out of Now`;
  }
};

/**
 * Checks whether `move` takes a signal out of the list of `view`: Done out
 * of To do and Later, Snooze out of To do, Unsnooze out of Later. Snooze
 * again on Later and Not urgent on To do keep the signal in its list.
 */
export const isMoveLeavingView = (move: SignalMove, view: SignalView): boolean => {
  switch (move) {
    case "done":
      return view !== "done";
    case "snooze":
      return view === "to-do";
    case "unsnooze":
      return view === "later";
    case "not-urgent":
      return false;
  }
};

/**
 * Returns the list of `view` as it reads after `move` moved the signals
 * `movedIds`, before the controller's lists are read again: the moved
 * signals taken out when the move leaves the view, and lowered to `high`
 * after Not urgent. Any other change, such as a new `until` after Snooze
 * again, waits for the read. Returns `signals` itself when nothing changes.
 */
export const applySignalMove = (
  signals: ReadonlyArray<Signal>,
  view: SignalView,
  move: SignalMove,
  movedIds: ReadonlyArray<string>,
): ReadonlyArray<Signal> => {
  const moved = new Set(movedIds);
  if (isMoveLeavingView(move, view)) return signals.filter((signal) => !moved.has(signal.id));
  if (move === "not-urgent")
    return signals.map((signal) =>
      moved.has(signal.id) ? { ...signal, priority: "high" as const } : signal,
    );
  return signals;
};

/** The snooze menu's keys, which never move: 2 stays the afternoon or evening choice all day. */
type SnoozeChoiceKey = 1 | 2 | 3 | 4 | 5;

/** One choice of the snooze menu. */
export interface SnoozeChoice {
  readonly key: SnoozeChoiceKey;
  /** "In 1 hour", "This afternoon", "This evening", "Tomorrow", "Monday" or "Pick a time…". */
  readonly label: string;
  /** The time shown beside the label: "14:00" today, "Mon 09:00" on another day. `null` when there is none. */
  readonly timeLabel: string | null;
  /** The ISO instant the signal comes back. `null` for Pick a time…, and while the choice is disabled. */
  readonly until: string | null;
  readonly disabled: boolean;
}

/**
 * Counts the days from `today` to the Monday the snooze menu's fourth
 * choice comes back on: the first Monday after tomorrow. Returns 7 on a
 * Monday, 8 on a Sunday, and 2 to 6 on the other days.
 */
const countDaysToMonday = (today: CalendarDate): number => {
  // Monday is weekday 1, so this counts the days to the coming Monday, 0 on a Monday.
  const days = (8 - computeWeekday(today)) % 7;
  return days <= 1 ? days + 7 : days;
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
 * 4. Monday at 09:00: the next Monday after tomorrow. On a Monday that is
 *    a week ahead, and on a Sunday eight days ahead, so it is never the
 *    same time as Tomorrow.
 * 5. Pick a time…, which has no time of its own.
 *
 * Days are counted on the calendar in `timezone`, never as 24 hours, so a
 * day on which the clock changes still ends at 09:00 on the next one. A
 * choice whose time the clock never reads, as on the day Samoa skipped in
 * 2011, is disabled.
 */
export const buildSnoozeChoices = (now: Date, timezone: string): ReadonlyArray<SnoozeChoice> => {
  const today = readWallClock(now, timezone);
  const minutesOfDay = computeMinutesOfDay(now, timezone) ?? 0;
  const evening = minutesOfDay >= 13 * 60;

  const buildChoice = (
    key: SnoozeChoiceKey,
    label: string,
    until: number | undefined,
  ): SnoozeChoice =>
    until === undefined
      ? { key, label, timeLabel: null, until: null, disabled: true }
      : {
          key,
          label,
          timeLabel: formatShortMoment(new Date(until), now, timezone) ?? null,
          until: new Date(until).toISOString(),
          disabled: false,
        };
  const buildFixedChoice = (
    key: SnoozeChoiceKey,
    label: string,
    date: CalendarDate | undefined,
    hour: number,
  ): SnoozeChoice => buildChoice(key, label, date && computeZonedInstant(date, hour, 0, timezone));

  return [
    buildChoice(1, "In 1 hour", now.getTime() + 3_600_000),
    minutesOfDay >= 17 * 60
      ? { key: 2, label: "This evening", timeLabel: "18:00", until: null, disabled: true }
      : buildFixedChoice(2, evening ? "This evening" : "This afternoon", today, evening ? 18 : 14),
    buildFixedChoice(3, "Tomorrow", today && addCalendarDays(today, 1), 9),
    buildFixedChoice(4, "Monday", today && addCalendarDays(today, countDaysToMonday(today)), 9),
    { key: 5, label: "Pick a time…", timeLabel: null, until: null, disabled: false },
  ];
};

/**
 * Describes a snooze in the Later pane: "Snoozed at 09:44 until today
 * 14:00.", or "Snoozed yesterday at 16:10 until Monday 09:00.", relative to
 * `now` in `timezone`. When `sourceName` is given, the signal's source can
 * still end it, so the line adds " Answered on GitHub before then, it goes
 * to Done." Returns `null` for a signal that is not snoozed.
 */
export const describeSnoozeLine = (
  signal: Signal,
  now: Date,
  timezone: string,
  sourceName: string | null,
): string | null => {
  if (signal.snooze === undefined) return null;
  const snoozedAt = new Date(signal.snooze.snoozedAt);
  const day = formatRelativeDay(snoozedAt, now, timezone);
  const at = `${day === "today" || day === undefined ? "" : `${day} `}at ${formatClock(snoozedAt, timezone) ?? ""}`;
  const until = formatRelativeMoment(new Date(signal.snooze.until), now, timezone) ?? "";
  const source =
    sourceName === null ? "" : ` Answered on ${sourceName} before then, it goes to Done.`;
  return `Snoozed ${at} until ${until}.${source}`;
};

/**
 * Converts the time picked under Pick a time…, a wall-clock time
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
  if (instant === undefined || instant <= now.getTime()) return null;
  return new Date(instant).toISOString();
};

/** The two numbers the foot under the list shows. */
interface ClearedToday {
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
  const today = listClearedToday(done, now, timezone).map((signal) => signal.resolution!);
  return {
    cleared: today.length,
    leftOnTheirOwn: today.filter(
      (resolution) => !(resolution.kind === "decided" && resolution.actor === "user"),
    ).length,
  };
};

/**
 * Returns the signals among `done` resolved since midnight of `now` in
 * `timezone`, leaving out replaced signals: the ones `countClearedToday`
 * counts.
 */
const listClearedToday = (
  done: ReadonlyArray<Signal>,
  now: Date,
  timezone: string,
): ReadonlyArray<Signal> =>
  done.filter(
    (signal) =>
      signal.resolution !== undefined &&
      signal.replacedBy === undefined &&
      isSameDay(new Date(signal.resolution.at), now, timezone),
  );

/** How many signals of one plugin were cleared today. */
export interface PluginClearedToday {
  readonly pluginId: string;
  readonly cleared: number;
}

/**
 * Counts the signals among `done` cleared today, as `countClearedToday`
 * counts them, per plugin that raised them. Inbox zero shows one pill per
 * plugin with these numbers (spec 17 §Motion).
 *
 * Returns only plugins with at least one signal cleared today, in the order
 * `plugins` lists them, then any plugin `plugins` does not list, by id, as
 * the tabs order them (see `buildIntakeTabs`). Core signals belong to no
 * plugin, so they are counted in no entry.
 */
export const countClearedTodayByPlugin = (
  done: ReadonlyArray<Signal>,
  now: Date,
  timezone: string,
  plugins: ReadonlyArray<{ readonly id: string }>,
): ReadonlyArray<PluginClearedToday> => {
  const counts = new Map<string, number>();
  for (const signal of listClearedToday(done, now, timezone)) {
    const pluginId = parsePluginId(signal.kind);
    if (pluginId !== null) counts.set(pluginId, (counts.get(pluginId) ?? 0) + 1);
  }
  const listed = plugins.map((plugin) => plugin.id).filter((id) => counts.has(id));
  const unlisted = [...counts.keys()].filter((id) => !listed.includes(id)).sort();
  return [...listed, ...unlisted].map((pluginId) => ({ pluginId, cleared: counts.get(pluginId)! }));
};

/**
 * Returns the foot under the list, without its closing link, which the
 * client draws after it as "See Done.": "7 cleared today. 3 left on their
 * own: answered elsewhere or withdrawn.", or "7 cleared today." when none
 * were left on their own. Returns `null` when none were cleared, because
 * then there is no foot.
 */
export const describeIntakeFoot = (cleared: ClearedToday): string | null => {
  if (cleared.cleared === 0) return null;
  const count = `${String(cleared.cleared)} cleared today.`;
  return cleared.leftOnTheirOwn === 0
    ? count
    : `${count} ${String(cleared.leftOnTheirOwn)} left on their own: answered elsewhere or withdrawn.`;
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
 * Returns the outcome a Done row shows under its title:
 *
 * - "Replaced by a newer one" for a signal a newer one replaced;
 * - "Withdrawn · " and the stored outcome for a signal withdrawn on its
 *   source: "Withdrawn · Marta removed the request";
 * - the stored outcome otherwise: "Approved #1293".
 *
 * The Done view holds only resolved signals, so a signal with no resolution
 * returns "".
 */
export const describeDoneRowOutcome = (signal: Signal): string => {
  if (signal.replacedBy !== undefined) return "Replaced by a newer one";
  const { resolution } = signal;
  if (resolution === undefined) return "";
  return resolution.kind === "withdrawn" ? `Withdrawn · ${resolution.outcome}` : resolution.outcome;
};

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
