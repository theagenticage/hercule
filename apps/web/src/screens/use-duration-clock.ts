import { useEffect, useState } from "react";
import { findNextDurationChange } from "@hercule/client-core";

/**
 * Returns the current time, and draws the calling component again at each
 * moment a duration counted from one of `startedAts` shows a new value in
 * `formatDuration`: every second under an hour, every minute after.
 *
 * Pass the start times of what is still running only. With an empty list the
 * clock sets no timer, so a screen that shows only finished durations never
 * draws again on its own.
 *
 * `useTickingClock` in `@hercule/ui` wakes ten times a second and
 * `useMinuteClock` once a minute; this clock wakes exactly when the text
 * changes, which is what a "16m 2s" label needs.
 */
export function useDurationClock(startedAts: readonly string[]): Date {
  const [now, setNow] = useState(() => new Date());
  // The list is a new array on every render; its contents decide the timer.
  const key = startedAts.join(" ");

  useEffect(() => {
    if (key === "") return;
    const starts = key.split(" ");
    let timer: ReturnType<typeof setTimeout>;
    const tick = (): void => {
      const current = new Date();
      setNow(current);
      const next = Math.min(
        ...starts.map((since) => findNextDurationChange(since, current).getTime()),
      );
      timer = setTimeout(tick, Math.max(0, next - current.getTime()));
    };
    // The first tick runs at once, because the time read on an earlier render
    // may be long past when the list changed.
    timer = setTimeout(tick, 0);
    return () => {
      clearTimeout(timer);
    };
  }, [key]);

  return now;
}
