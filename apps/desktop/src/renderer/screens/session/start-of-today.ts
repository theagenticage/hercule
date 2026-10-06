import { useSyncExternalStore } from "react";
import { ageClock } from "../../app/age-clock";

/** Returns the first moment of the local day `now` falls on, in milliseconds since the epoch. */
const findStartOfDay = (now: Date): number =>
  new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

/** Registers with the age clock to be told when the local day changes. */
const subscribeToDayChange = (onChange: () => void): (() => void) =>
  ageClock.watch((now) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1), onChange);

/**
 * Returns the start of the current local day, in milliseconds since the epoch,
 * and draws the caller again when the day changes. The day is read from the
 * age clock, which keeps one timer for every label on screen, so the day
 * change costs no timer of its own.
 *
 * The thread's transcript and an assistant's Conversation draw their times
 * against it, so "09:04" becomes "4 Sep 09:04" when the day changes.
 */
export const useStartOfToday = (): number =>
  useSyncExternalStore(subscribeToDayChange, () => findStartOfDay(ageClock.readNow()));
