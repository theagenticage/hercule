/**
 * How much a thread row in the sidebar shows.
 *
 * The setting is absent until the user changes it. The default lives here, in
 * the only place that reads the setting, so the sidebar never needs its own
 * `?? "meta"`.
 */
import type { ThreadRows } from "@hercule/contract";

/** What a thread row shows when the user has not chosen a setting. */
export const THREAD_ROWS_DEFAULT: ThreadRows = "meta";

/** Returns the stored setting, or the default when none is stored. */
export const resolveThreadRowsMode = (stored: ThreadRows | undefined): ThreadRows =>
  stored ?? THREAD_ROWS_DEFAULT;
