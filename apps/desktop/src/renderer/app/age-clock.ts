/**
 * The age clock: the one timer behind every label on screen that counts the
 * time since or until a moment. There are four kinds of such labels:
 *
 * - an age, such as a thread row's "20m" or the "10m" a thread has waited on
 *   the user (`useAgeLabel`), which changes minutes or hours apart
 *   (`findNextAgeChange`);
 * - a duration, such as a live turn's "Working for 12s"
 *   (`useDurationText`), which changes every second under an hour
 *   (`findNextDurationChange`);
 * - a moment in a list, such as a workflow's last run "10:31", "Sun" or
 *   "1 Oct" (`useListTime`, in the workflow screens' own module so it loads
 *   with them), which changes at local midnight, or when a future moment
 *   comes (`findNextListTimeChange`);
 * - the minutes a one-time code has left, such as "The code expires in 12
 *   minutes." (`useMinutesLeft`), which change once a minute until the code
 *   expires (`computeNextMinuteTick`).
 *
 * Instead of a timer per label, or one that ticks every second, the clock
 * keeps a single timer for the earliest moment at which some label on screen
 * changes. When it fires, the clock reads the time once and each label
 * compares its own text: only a label whose text changed draws again. With no
 * label on screen, or with the window hidden, there is no timer at all, so an
 * idle app does no work.
 *
 * A timer may not count the time the Mac slept. The clock therefore also
 * reads the time again when the window is shown, when it gets focus, and when
 * the live connection reconnects (see `useLiveConnection`), which follows a wake.
 *
 * The clock is one module-level instance, not part of the router context. The
 * labels sit in presentational rows, which read nothing from the router, and
 * the clock follows the one window this page runs in.
 */
import { useCallback, useSyncExternalStore } from "react";
import {
  computeNextMinuteTick,
  countMinutesLeft,
  describeAge,
  findNextAgeChange,
  findNextDurationChange,
  formatAge,
} from "@hercule/client-core";

/**
 * The longest delay `setTimeout` keeps. A longer one runs after 1 ms instead,
 * and a label whose time lies in the future (the controller's clock ahead of
 * this Mac's) can change more than 24 days from now. The clock sets a timer
 * this long at most; when it fires, no label has changed yet, and the clock
 * sets the next one.
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * How early a timer may fire and still count as firing on time. A timer
 * counts time on a clock that ignores the corrections made to the wall clock,
 * so it can fire slightly before the wall clock reaches the moment it was set
 * for. The gap grows with the timer's length:
 *
 * - A label that counts minutes waits long, and can change a second early
 *   without anyone seeing it. Treating the fire as early would cost a second
 *   timer.
 * - A label that counts seconds keeps the timer under a second long, so its
 *   fires are early by far less than a second.
 *
 * A fire counts as on time only when the wall clock has moved since the timer
 * was set. A wall clock that did not move is not running slow: it is stopped,
 * as in the specimens' fixed clock, or it was set back. Moving the labels to
 * the timer's moment would then show a time the wall clock never reached.
 */
const EARLY_FIRE_TOLERANCE_MS = 1_000;

export interface AgeClock {
  /**
   * Returns the time the labels are drawn at: the moment the clock last read
   * the time. It changes only when the clock reads the time again.
   */
  readNow(): Date;
  /**
   * Registers a label while it is on screen. `findNextChange` returns the
   * first moment after `now` at which the label's text changes, such as
   * `findNextAgeChange` for the label's own moment. It must return the same
   * moment for every `now` before that moment, because the clock finds it
   * again only once the time reaches it.
   *
   * Reads the time, so a label that appears is never out of date, and sets
   * the timer. `onChange` is called whenever the clock reads a time at which
   * some label's text changed. Returns a function that removes the label.
   */
  watch(findNextChange: (now: Date) => Date, onChange: () => void): () => void;
  /**
   * Reads the time again, calls every registered label's `onChange` if some
   * label's text changed, and sets the timer for the next change.
   */
  refresh(): void;
}

/** A label the clock watches: how to find its next change, and the one last found. */
interface WatchedLabel {
  readonly findNextChange: (now: Date) => Date;
  /** The label's next change, in milliseconds, found at a time before it. */
  change: number;
}

/** Creates an age clock. Exported for tests; the app uses `ageClock`. */
export const createAgeClock = (): AgeClock => {
  let now = new Date();
  /** Each registered label, by its `onChange`. */
  const watched = new Map<() => void, WatchedLabel>();
  /**
   * The earliest moment, in milliseconds, at which a registered label's text
   * changes: the smallest `change` of the labels, or null with no label.
   */
  let nextChange: number | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** The wall clock's time, in milliseconds, when `timer` was set. */
  let timerSetAt = 0;

  /** Sets the one timer for `nextChange` unless the window is hidden. Clears any earlier timer first. */
  const setTimer = (): void => {
    clearTimeout(timer);
    timer = undefined;
    if (nextChange === null || document.visibilityState === "hidden") return;
    timerSetAt = Date.now();
    timer = setTimeout(fire, Math.min(MAX_TIMER_DELAY_MS, Math.max(0, nextChange - timerSetAt)));
  };

  /** Returns the smallest `change` among the registered labels, or null with no label. */
  const findEarliestChange = (): number | null => {
    let earliest: number | null = null;
    for (const { change } of watched.values()) {
      if (earliest === null || change < earliest) earliest = change;
    }
    return earliest;
  };

  /**
   * Stores `time` as the time the labels are drawn at, and sets the timer
   * again.
   *
   * While `time` is before `nextChange`, no label's text has changed since
   * each label's next change was found, so those changes still hold and
   * nothing is found again. Once `time` reaches `nextChange`, the clock finds
   * every label's next change again and tells every label, and each label
   * compares its own text.
   */
  const moveTo = (time: Date): void => {
    now = time;
    if (nextChange === null || now.getTime() < nextChange) {
      setTimer();
      return;
    }
    for (const label of watched.values()) label.change = label.findNextChange(now).getTime();
    nextChange = findEarliestChange();
    setTimer();
    for (const onChange of [...watched.keys()]) onChange();
  };

  const refresh = (): void => {
    moveTo(new Date());
  };

  const fire = (): void => {
    // Counted by the performance script: an idle window should fire at most
    // once per label change.
    performance.mark("age-clock-fire");
    const time = Date.now();
    const due = nextChange ?? time;
    const onTime = due - time <= EARLY_FIRE_TOLERANCE_MS && time > timerSetAt;
    moveTo(new Date(onTime ? Math.max(time, due) : time));
  };

  const followVisibility = (): void => {
    if (document.visibilityState === "hidden") setTimer();
    else refresh();
  };

  return {
    readNow: () => now,
    watch: (findNextChange, onChange) => {
      if (watched.size === 0) {
        document.addEventListener("visibilitychange", followVisibility);
        window.addEventListener("focus", refresh);
      }
      // Reading the time first brings the labels already watched up to date.
      // The new label's next change is then the only one to find, so a list
      // that mounts n labels finds n changes, not n² of them.
      refresh();
      const label: WatchedLabel = { findNextChange, change: findNextChange(now).getTime() };
      watched.set(onChange, label);
      if (nextChange === null || label.change < nextChange) {
        nextChange = label.change;
        setTimer();
      }
      return () => {
        watched.delete(onChange);
        if (watched.size === 0) {
          document.removeEventListener("visibilitychange", followVisibility);
          window.removeEventListener("focus", refresh);
        }
        // Removing a label can only move the next change later, and only when
        // the label was the one it was set for.
        if (label.change === nextChange) {
          nextChange = findEarliestChange();
          setTimer();
        }
      };
    },
    refresh,
  };
};

/** The app's age clock. */
export const ageClock = createAgeClock();

/**
 * A moment so far off that the age clock never reaches it: the next change
 * of a label that never changes again, such as the next midnight in a zone
 * that has none.
 */
export const NEVER = new Date(8.64e15);

/**
 * Returns `format(now)` for the age clock's current time, and draws the
 * calling component again whenever that value changes. `findNextChange` finds
 * when the value of a label counting from or to `moment` changes next, and is
 * one of the stable functions `findNextAgeChange`, `findNextDurationChange`
 * and `findNextMinuteLeftChange`, or `findNextListTimeChange` wrapped in a
 * memoized callback.
 *
 * The label registers with the clock only while `counting` is true. Otherwise
 * it keeps the value it had, and reads a fresh one as soon as it counts again.
 * The value is a string or a number, so that an unchanged value compares equal
 * and draws nothing.
 */
export const useClockValue = <Value extends string | number | null>(
  moment: string,
  counting: boolean,
  findNextChange: (moment: string, now: Date) => Date,
  format: (now: Date) => Value,
): Value => {
  const subscribe = useCallback(
    (onChange: () => void) =>
      counting ? ageClock.watch((now) => findNextChange(moment, now), onChange) : () => {},
    [moment, counting, findNextChange],
  );
  return useSyncExternalStore(subscribe, () => format(ageClock.readNow()));
};

/**
 * Returns the short age of `at` that a row shows, such as "now", "5m" or "3h"
 * (`formatAge`), and keeps it current while `onScreen` is true. Pass `true`
 * only while the label is inside the visible part of the list.
 */
export const useAgeLabel = (at: string, onScreen: boolean): string =>
  useClockValue(at, onScreen, findNextAgeChange, (now) => formatAge(at, now));

/**
 * Returns the age of `at` in words, such as "20 minutes ago" (`describeAge`),
 * for a screen reader to say where the row shows `useAgeLabel`. It changes at
 * the same moments as the short label, so a row that calls both draws both
 * in the same render.
 */
export const useAgeWords = (at: string, onScreen: boolean): string =>
  useClockValue(at, onScreen, findNextAgeChange, (now) => describeAge(at, now));

/**
 * Returns `describe(now)`, where `now` is the age clock's current time in
 * milliseconds since the epoch, and keeps it current while `counting` is
 * true. The text is read again at each moment the duration since `since`
 * shows a new number of seconds, or of minutes past an hour
 * (`findNextDurationChange`), and the component draws again only when the
 * text changed.
 *
 * A work stretch's divider reads, for example:
 *
 * ```ts
 * useDurationText(block.startedAt, block.endedAt === null, (now) => describeWorkStretch(block, now))
 * ```
 *
 * A stretch that has ended passes `counting: false`, and sets no timer.
 */
export const useDurationText = (
  since: string,
  counting: boolean,
  describe: (now: number) => string,
): string =>
  useClockValue(since, counting, findNextDurationChange, (now) => describe(now.getTime()));

/**
 * Returns the moment after `now` at which the minutes left before
 * `expiresAt` next change. Once the code has expired, the count never
 * changes again, so the moment is as far off as a timer can wait.
 */
const findNextMinuteLeftChange = (expiresAt: string, now: Date): Date =>
  new Date(computeNextMinuteTick(expiresAt, now.getTime()) ?? now.getTime() + MAX_TIMER_DELAY_MS);

/**
 * Returns how many whole minutes a one-time code that expires at `expiresAt`
 * still works (`countMinutesLeft`), and keeps the count current, so it ticks
 * down on screen until it reaches 0. Returns null, and sets no timer, when
 * `expiresAt` is undefined because the code's issuer did not say.
 */
export const useMinutesLeft = (expiresAt: string | undefined): number | null =>
  useClockValue(expiresAt ?? "", expiresAt !== undefined, findNextMinuteLeftChange, (now) =>
    expiresAt === undefined ? null : countMinutesLeft(expiresAt, now.getTime()),
  );
