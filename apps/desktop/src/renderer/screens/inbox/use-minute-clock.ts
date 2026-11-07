import { useClockValue } from "../../app/age-clock";

const MINUTE_MS = 60_000;

/** Returns the start of the minute after `now`. The moment does not depend on the label, so every card shares it. */
const findNextMinute = (_moment: string, now: Date): Date =>
  new Date((Math.floor(now.getTime() / MINUTE_MS) + 1) * MINUTE_MS);

/**
 * Returns the time a card draws its wait and the age of its facts at, the
 * start of the current minute, and draws the card again each minute while
 * `isTicking` is true. A card that shows nothing that depends on the time
 * passes `false` and sets no timer, so a quiet Inbox wakes the app no more
 * than the age clock's single timer does.
 */
export const useMinuteClock = (isTicking: boolean): Date => {
  const minute = useClockValue("", isTicking, findNextMinute, (now) =>
    Math.floor(now.getTime() / MINUTE_MS),
  );
  return new Date(minute * MINUTE_MS);
};
