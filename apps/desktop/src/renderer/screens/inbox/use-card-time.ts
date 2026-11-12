import { useCallback } from "react";
import type { EntityRecord } from "@hercule/contract";
import {
  describeCardTime,
  findNextCardTimeChange,
  isCardTimeDependent,
  type CardTime,
} from "@hercule/client-core/inbox";
import { ageClock, useClockValue } from "../../app/age-clock";

/**
 * Returns the wait of `card`, the line about the age of its facts and how long
 * ago its sentence's signal landed, and draws the card again only when one of
 * them changes: once an hour for a wait, but each minute while a signal is under
 * an hour old, which reads in minutes. The age clock sets one timer for the
 * earliest such change of any card on screen, so many young signals still
 * cost one timer. A card whose words do not depend on the time registers nothing,
 * so a quiet Inbox wakes the app no more than the age clock's single timer does.
 */
export const useCardTime = (card: EntityRecord): CardTime => {
  const findNextChange = useCallback(
    (_moment: string, now: Date) => findNextCardTimeChange(card, now),
    [card],
  );
  // The value is the words themselves, so an unchanged text draws nothing. The
  // words are then read at the clock's time, which equals the time of that value.
  useClockValue("", isCardTimeDependent(card), findNextChange, (now) =>
    JSON.stringify(describeCardTime(card, now)),
  );
  return describeCardTime(card, ageClock.readNow());
};
