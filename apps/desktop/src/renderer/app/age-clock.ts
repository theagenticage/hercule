/**
 * The age clock: the one timer behind every age label on screen, such as a
 * thread row's "20m".
 *
 * A label changes only at the moments `findNextAgeChange` names, minutes or
 * hours apart. So instead of a timer per label, or one that ticks every
 * second, the clock keeps a single timer for the earliest of those moments
 * among the labels on screen. When it fires, the clock reads the time once
 * and each label compares its own text: only a label whose text changed draws
 * again. With no label on screen, or with the window hidden, there is no
 * timer at all, so an idle app does no work.
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
import { describeAge, findNextAgeChange, formatAge } from "@hercule/client-core";

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
 * for. A label that counts minutes can change a second early without anyone
 * seeing it, and treating the fire as late would cost a second timer.
 */
const EARLY_FIRE_TOLERANCE_MS = 1_000;

export interface AgeClock {
  /**
   * Returns the time the labels are drawn at: the moment the clock last read
   * the time. It changes only when the clock reads the time again.
   */
  readNow(): Date;
  /**
   * Registers a label that shows the age of `at`, while it is on screen.
   * Reads the time, so a label that appears is never out of date, and sets the
   * timer. `onChange` is called whenever the clock reads a time at which some
   * label's text changed. Returns a function that removes the label.
   */
  watch(at: string, onChange: () => void): () => void;
  /**
   * Reads the time again, calls every registered label's `onChange` if some
   * label's text changed, and sets the timer for the next change.
   */
  refresh(): void;
}

/** Creates an age clock. Exported for tests; the app uses `ageClock`. */
export const createAgeClock = (): AgeClock => {
  let now = new Date();
  /** Each registered label's `onChange`, and the time its age counts from. */
  const watched = new Map<() => void, string>();
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
    for (const at of watched.values()) {
      const change = findNextAgeChange(at, now).getTime();
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
    watch: (at, onChange) => {
      if (watched.size === 0) {
        document.addEventListener("visibilitychange", followVisibility);
        window.addEventListener("focus", refresh);
      }
      watched.set(onChange, at);
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
 * Returns `format(at, now)` for the age clock's current time, and draws the
 * calling component again whenever that text changes. The label registers
 * with the clock only while `onScreen` is true; off screen it keeps the text
 * it had, and reads a fresh one as soon as it is on screen again.
 */
const useAgeText = (
  at: string,
  onScreen: boolean,
  format: (at: string, now: Date) => string,
): string => {
  const subscribe = useCallback(
    (onChange: () => void) => (onScreen ? ageClock.watch(at, onChange) : () => {}),
    [at, onScreen],
  );
  return useSyncExternalStore(subscribe, () => format(at, ageClock.readNow()));
};

/**
 * Returns the short age of `at` that a row shows, such as "now", "5m" or "3h"
 * (`formatAge`), and keeps it current while `onScreen` is true. Pass `true`
 * only while the label is inside the visible part of the list.
 */
export const useAgeLabel = (at: string, onScreen: boolean): string =>
  useAgeText(at, onScreen, formatAge);

/**
 * Returns the age of `at` in words, such as "20 minutes ago" (`describeAge`),
 * for a screen reader to say where the row shows `useAgeLabel`. It changes at
 * the same moments as the short label, so a row that calls both draws both
 * in the same render.
 */
export const useAgeWords = (at: string, onScreen: boolean): string =>
  useAgeText(at, onScreen, describeAge);
