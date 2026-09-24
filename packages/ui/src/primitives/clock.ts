import { useEffect, useState } from "react";

/**
 * Returns the current time, updated at the start of every minute. Use it in
 * anything that shows a clock time or an age to the minute, so that it
 * re-renders when the minute changes.
 *
 * Each tick is scheduled for the next minute boundary, not every sixty seconds
 * from mount: an interval would drift and could leave the shown time a minute
 * behind.
 */
export function useMinuteClock(): Date {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const scheduleNextMinute = (): void => {
      timer = setTimeout(
        () => {
          setNow(new Date());
          scheduleNextMinute();
        },
        60_000 - (Date.now() % 60_000),
      );
    };
    scheduleNextMinute();
    return () => {
      clearTimeout(timer);
    };
  }, []);

  return now;
}

/** How often a ticking clock updates: often enough for a duration shown to the tenth of a second. */
const TICK_MS = 100;

/**
 * Returns the current time in milliseconds, updated every tenth of a second
 * while `isTicking` is true. Use it for a duration that counts up while
 * something runs. While `isTicking` is false the clock stands still, so a
 * screen showing only finished durations does not re-render.
 */
export function useTickingClock(isTicking: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!isTicking) return;
    const timer = setInterval(() => {
      setNow(Date.now());
    }, TICK_MS);
    return () => {
      clearInterval(timer);
    };
  }, [isTicking]);

  return now;
}
