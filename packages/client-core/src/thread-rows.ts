/**
 * How much a thread row in the sidebar shows.
 *
 * The setting is absent until the user changes it, and an absent setting is not
 * a defaulted one: the default lives here, in the one place that reads the key,
 * so the sidebar never carries a `?? "meta"` of its own.
 */
import type { ThreadRows } from "@hercule/contract";

/** What a thread row shows when the user has not said otherwise. */
export const THREAD_ROWS_DEFAULT: ThreadRows = "meta";

export const resolveThreadRowsMode = (stored: ThreadRows | undefined): ThreadRows =>
  stored ?? THREAD_ROWS_DEFAULT;
