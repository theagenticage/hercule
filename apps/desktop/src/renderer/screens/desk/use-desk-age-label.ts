import { findNextDeskAgeChange, formatDeskAge } from "@hercule/client-core/desk";
import { useClockValue } from "../../app/age-clock";

/**
 * Returns the age of `at` that a card on the Overview shows, such as "today",
 * "2d" or "3w" (`formatDeskAge`), and keeps it current while `onScreen` is
 * true. It counts whole days, so a board of cards draws its ages again about
 * once a day.
 *
 * It lives here, not in the age clock's module, so that the desk's age code
 * loads with the pages that draw cards and stays off the first screen.
 */
export const useDeskAgeLabel = (at: string, onScreen: boolean): string =>
  useClockValue(at, onScreen, findNextDeskAgeChange, (now) => formatDeskAge(at, now));
