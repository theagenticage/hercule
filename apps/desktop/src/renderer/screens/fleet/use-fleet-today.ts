import { useCallback, useRef, useSyncExternalStore } from "react";
import { computeDayStart, findNextListTimeChange } from "@hercule/client-core/list-time";
import { ageClock } from "../../app/age-clock";

/** The instant the age clock last read, the zone, and the start of the day that instant is in. */
interface DayRead {
  readonly now: Date;
  readonly timezone: string;
  readonly dayStart: Date;
}

/**
 * Returns the day that the Fleet page and a machine's page word their times
 * in, such as "Offline since 09:12": the start of the current day in
 * `timezone`. It is the same `Date` until the local day changes. A time on
 * these pages depends on it only through its date: "09:12" today, the weekday
 * within a week, the date after that. So the pages draw again at midnight and
 * at no other moment.
 *
 * The value comes from the age clock, which tells every label on screen
 * whenever any one of them is due, such as a per-second duration elsewhere.
 * Those calls find the same day and change nothing here.
 *
 * `showsTimes` is whether the page shows a time at all, which it does for a
 * machine that is away (offline or unreachable). While it is true, the hook
 * watches the clock for the next local midnight in `timezone`. While it is
 * false, nothing is watched.
 */
export const useFleetToday = (timezone: string, showsTimes: boolean): Date => {
  const subscribe = useCallback(
    (onChange: () => void) =>
      showsTimes
        ? ageClock.watch((now) => findNextListTimeChange(now, timezone, now, "past"), onChange)
        : () => {},
    [showsTimes, timezone],
  );
  const lastRead = useRef<DayRead | null>(null);
  // React compares the snapshot with `Object.is`, so a new `Date` for the same
  // day would draw the pages again. The previous `Date` is returned instead.
  const readDayStart = (): Date => {
    const now = ageClock.readNow();
    const previous = lastRead.current;
    if (previous?.now === now && previous.timezone === timezone) return previous.dayStart;
    // A zone that cannot be formatted has no day start. Its times cannot be
    // formatted either, so `now` itself does no harm.
    const found = computeDayStart(now, timezone) ?? now;
    const dayStart = previous?.dayStart.getTime() === found.getTime() ? previous.dayStart : found;
    lastRead.current = { now, timezone, dayStart };
    return dayStart;
  };
  return useSyncExternalStore(subscribe, readDayStart);
};
