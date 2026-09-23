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
