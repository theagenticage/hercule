/**
 * Moves the page's stopped clock to Wednesday 14 October 2026, 09:41 UTC, for
 * the Discussions and Wiki specimens.
 *
 * The Bureau book's Discussions and Wiki pages show "Mon", "Tue" and "Sun"
 * beside "09:41" and "3 Oct". A list draws a weekday only for the six days
 * before today, so those times fit a Wednesday and no other day of the
 * specimens' default week. The book's history also says "Yesterday" for a
 * Tuesday, which is why the clock stands on the Wednesday after it.
 *
 * Import it right after `./fixed-clock` and before anything that loads the
 * app, because the app's age clock reads the time as soon as its module loads.
 */
import { stopSpecimenClockAt } from "./fixed-clock";

/** The moment the Discussions and Wiki specimens' clock stands at. */
const LIST_WEEK_NOW = Date.UTC(2026, 9, 14, 9, 41, 0);

stopSpecimenClockAt(LIST_WEEK_NOW);
