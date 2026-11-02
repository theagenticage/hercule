import { useCallback, useRef, useSyncExternalStore } from "react";
import type { FleetMachine } from "@hercule/client-core/fleet";
import { computeDayStart, findNextListTimeChange } from "@hercule/client-core/list-time";
import { ageClock } from "../../app/age-clock";

/** The start of the local day the age clock last read, and the zone it was found in. */
interface DayRead {
  readonly now: Date;
  readonly timezone: string;
  readonly dayStart: Date;
}

/**
 * Returns the time that the Fleet page and a machine's page draw their times
 * at, such as "Offline since 09:12". The value is the start of the current
 * day in `timezone`, and it is the same `Date` until the local day changes.
 * A time on these pages depends on `now` only through its date: "09:12"
 * today, the weekday within a week, the date after that. So the pages draw
 * again at midnight and at no other moment.
 *
 * The time comes from the age clock, which tells every label on screen
 * whenever any one of them is due, such as a per-second duration elsewhere.
 * Those calls find the same day and change nothing here.
 *
 * `machines` are the machines the page shows. A machine that is not online
 * shows when it was last heard from. While such a machine is shown, the hook
 * watches the clock for the next local midnight in `timezone`. With every
 * machine online no time is shown, and the hook watches nothing.
 */
export const useFleetNow = (machines: readonly FleetMachine[], timezone: string): Date => {
  const showsTime = machines.some(
    ({ runner }) => runner.connectivity !== "online" && runner.lastSeenAt !== null,
  );
  const subscribe = useCallback(
    (onChange: () => void) =>
      showsTime
        ? ageClock.watch((now) => findNextListTimeChange(now, timezone, now, "past"), onChange)
        : () => {},
    [showsTime, timezone],
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
