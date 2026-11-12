import { useCallback } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import {
  findNextAgeChange,
  formatClock,
  resolveDisplayTimezone,
  type HerculeClient,
} from "@hercule/client-core";
import type { InboxThing } from "@hercule/contract";
import { NEVER, useClockValue } from "../../../app/age-clock";
import { settingsQuery } from "../../../app/queries";

/**
 * Returns the time the rows' waits and ages are written at, and draws again
 * when the age clock reads the time anew. The clock sets one timer for the
 * earliest change of any age among `things`, so a list of old rows wakes the
 * app once an hour or less, and no list sets a timer when it holds nothing.
 */
export const useInboxNow = (things: ReadonlyArray<InboxThing>): Date => {
  const findNextChange = useCallback(
    (_moment: string, now: Date): Date => {
      let earliest = NEVER.getTime();
      for (const thing of things) {
        earliest = Math.min(earliest, findNextAgeChange(thing.sourceUpdatedAt, now).getTime());
        if (thing.waitingSince !== undefined) {
          earliest = Math.min(earliest, findNextAgeChange(thing.waitingSince, now).getTime());
        }
        if (thing.dismissedAt !== undefined) {
          earliest = Math.min(earliest, findNextAgeChange(thing.dismissedAt, now).getTime());
        }
      }
      return new Date(earliest);
    },
    [things],
  );
  const reading = useClockValue("", things.length > 0, findNextChange, (now) => now.getTime());
  return new Date(reading);
};

/**
 * Returns a function that writes a time as a clock time such as "09:12", in
 * the timezone the user's settings choose, like every other screen's clock
 * times. The Inbox uses it for the offline pill and a failing source.
 */
export const useInboxClock = (client: HerculeClient): ((at: Date | string) => string) => {
  const { data: settings } = useSuspenseQuery(settingsQuery(client));
  const timezone = resolveDisplayTimezone(settings.user.timezone);
  return (at) => formatClock(new Date(at), timezone) ?? "";
};
