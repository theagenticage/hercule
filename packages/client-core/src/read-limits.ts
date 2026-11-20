/**
 * How many records the reads of the first screen ask for. Each limit is tied
 * to what a screen shows, so the screen and its read agree.
 *
 * The web app's route loaders import these, so they live in a module of their
 * own. Next to the code that draws the screen they would pull that code, and
 * everything it imports, into the first screen's JavaScript.
 */

/** The largest count the sidebar shows as a number; above it, the count reads "99+". */
export const MAX_SHOWN_COUNT = 99;

/**
 * How many notifications the sidebar reads to count the new ones: one more
 * than the largest count it shows as a number, so it can tell 99 from more.
 */
export const UNSEEN_COUNT_READ_LIMIT = MAX_SHOWN_COUNT + 1;

/**
 * How many held events a trigger's row lists. The rest are counted in one
 * line, because the count, not the list, tells the user how many events wait,
 * and the oldest few show what the trigger matched.
 */
export const HELD_EVENT_PREVIEW_LIMIT = 3;
