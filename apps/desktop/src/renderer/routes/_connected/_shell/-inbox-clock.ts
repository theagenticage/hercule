import { useCallback } from "react";
import { findNextAgeChange } from "@hercule/client-core";
import type { InboxThing } from "@hercule/contract";
import { NEVER, useClockValue } from "../../../app/age-clock";

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
