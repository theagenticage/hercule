import { useEffect, useState } from "react";

/**
 * The current minute: what anything reading a wall clock or an age down to
 * the minute re-renders on.
 *
 * The tick is scheduled on the minute boundary rather than every sixty
 * seconds from mount: an interval would drift and could leave the displayed
 * reading a minute stale.
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
