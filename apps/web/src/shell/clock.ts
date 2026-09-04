import { useEffect, useState } from "react";

/**
 * The current minute.
 *
 * The top bar reads a wall clock down to the minute, so the tick is scheduled
 * on the minute boundary rather than every sixty seconds from mount: an
 * interval would drift and could leave the displayed time a minute stale.
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
