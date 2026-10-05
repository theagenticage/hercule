/**
 * The age clock: the one timer behind every label on screen that counts the
 * time since or until a moment. There are three kinds of such labels:
 *
 * - an age, such as a thread row's "20m" or the "10m" a thread has waited on
 *   the user (`useAgeLabel`), which changes minutes or hours apart
 *   (`findNextAgeChange`);
 * - a duration, such as a live turn's "Working for 12s"
 *   (`useDurationText`), which changes every second under an hour
 *   (`findNextDurationChange`);
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
   * `findNextAgeChange` for the label's own moment.
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

/** Creates an age clock. Exported for tests; the app uses `ageClock`. */
export const createAgeClock = (): AgeClock => {
  let now = new Date();
  /** Each registered label's `onChange`, and the function that finds its next change. */
  const watched = new Map<() => void, (now: Date) => Date>();
  /** The earliest moment, in milliseconds, at which a registered label's text changes. */
  let nextChange: number | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Finds the next change among the registered labels, and sets the one timer
   * for it unless the window is hidden. Clears any earlier timer first.
   */
  const schedule = (): void => {
    clearTimeout(timer);
    timer = undefined;
    nextChange = null;
    for (const findNextChange of watched.values()) {
      const change = findNextChange(now).getTime();
      if (nextChange === null || change < nextChange) nextChange = change;
    }
    if (nextChange === null || document.visibilityState === "hidden") return;
    timer = setTimeout(fire, Math.min(MAX_TIMER_DELAY_MS, Math.max(0, nextChange - Date.now())));
  };

  /**
   * Stores `time` as the time the labels are drawn at, sets the timer again,
   * and tells the labels when one of them has a new text.
   */
  const moveTo = (time: Date): void => {
    now = time;
    const changed = nextChange !== null && now.getTime() >= nextChange;
    schedule();
    if (changed) for (const onChange of [...watched.keys()]) onChange();
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
    moveTo(new Date(due - time <= EARLY_FIRE_TOLERANCE_MS ? Math.max(time, due) : time));
  };

  const followVisibility = (): void => {
    if (document.visibilityState === "hidden") schedule();
    else refresh();
  };

  return {
    readNow: () => now,
    watch: (findNextChange, onChange) => {
      if (watched.size === 0) {
        document.addEventListener("visibilitychange", followVisibility);
        window.addEventListener("focus", refresh);
      }
      watched.set(onChange, findNextChange);
      refresh();
      return () => {
        watched.delete(onChange);
        if (watched.size === 0) {
          document.removeEventListener("visibilitychange", followVisibility);
          window.removeEventListener("focus", refresh);
        }
        schedule();
      };
    },
    refresh,
  };
};

/** The app's age clock. */
export const ageClock = createAgeClock();

/**
 * Returns `format(now)` for the age clock's current time, and draws the
 * calling component again whenever that value changes. `findNextChange` finds
 * when the value of a label counting from or to `moment` changes next, and is
 * one of the stable functions `findNextAgeChange`, `findNextDurationChange`
 * and `findNextMinuteLeftChange`.
 *
 * The label registers with the clock only while `counting` is true. Otherwise
 * it keeps the value it had, and reads a fresh one as soon as it counts again.
 * The value is a string or a number, so that an unchanged value compares equal
 * and draws nothing.
 */
const useClockValue = <Value extends string | number | null>(
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
