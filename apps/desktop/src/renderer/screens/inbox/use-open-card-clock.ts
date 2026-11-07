import { useCallback } from "react";
import { findNextAgeChange } from "@hercule/client-core";
import {
  findNextCardTimeChange,
  isCardTimeDependent,
  type CardRecord,
  type TimelineLine,
} from "@hercule/client-core/inbox";
import { NEVER, useClockValue } from "../../app/age-clock";

/**
 * Returns the time the open card draws its wait, the age of its facts and the
 * ages of its timeline at, and draws the card again when the age clock reads
 * the time anew. The clock sets one timer for the earliest change of any age
 * on screen, so a quiet card adds no timer of its own: the card's own (`findNextCardTimeChange`) or the next
 * line of the timeline to read differently (`findNextAgeChange`). A card
 * with no time dependent words and no lines sets no timer.
 *
 * `record` is `undefined` while the card is not read yet.
 */
export const useOpenCardClock = (
  record: CardRecord | undefined,
  lines: readonly TimelineLine[],
): Date => {
  const findNextChange = useCallback(
    (_moment: string, now: Date) =>
      new Date(
        Math.min(
          record === undefined ? NEVER.getTime() : findNextCardTimeChange(record, now).getTime(),
          ...lines.map((line) => findNextAgeChange(line.at, now).getTime()),
        ),
      ),
    [record, lines],
  );
  const isCounting = (record !== undefined && isCardTimeDependent(record)) || lines.length > 0;
  // The value is the clock's own reading, so the card is drawn again whenever the clock reads the time anew,
  // which it does only when some age on screen changes, and a draw made from an older reading is corrected
  // as soon as the card subscribes. The time must come from this value: a time read from the clock directly
  // is not an input of the draw, and the React Compiler would keep the first one.
  const reading = useClockValue("", isCounting, findNextChange, (now) => now.getTime());
  return new Date(reading);
};
