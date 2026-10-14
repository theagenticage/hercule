package dev.hercule.android.threads

import dev.hercule.android.wire.Session

/** How many Done threads the Done shelf shows when the user opens it. */
const val DONE_SHELF_LIMIT = 10

/** How many more Done threads each press of the shelf's "Show 25 more" row shows. */
const val DONE_SHELF_STEP = 25

/** The Done shelf at the bottom of the Threads list. */
data class DoneShelf(
    /** How many threads are marked Done: the number in the shelf's header. */
    val count: Int,
    /** The Done threads the shelf shows, the most recently marked Done first. */
    val threads: List<Session>,
    /** How many Done threads the open shelf hides behind its "more" row, or 0 for none. */
    val hiddenCount: Int,
)

/**
 * Returns the Done shelf: every thread in [threads] that is marked Done, the most recently
 * marked first, with ties in session id order.
 *
 * - [limit] is how many the shelf shows, or null while it is closed. A closed shelf shows none.
 * - [DoneShelf.hiddenCount] counts the threads past [limit]. A closed shelf hides them all behind
 *   its header, not behind a "more" row, so it is 0 then.
 *
 * Ported from `buildDoneShelf` in packages/client-core/src/threads/sidebar-sections.ts, without
 * its `selectedId`: the desktop always shows the thread it has open, and the phone list has no
 * open thread.
 */
fun buildDoneShelf(threads: List<Session>, limit: Int?): DoneShelf {
    val done = threads.filter(::isMarkedDone)
    if (limit == null) return DoneShelf(count = done.size, threads = emptyList(), hiddenCount = 0)
    val sorted = done.sortedWith(compareByDescending<Session> { it.done?.at }.thenBy { it.id })
    val shown = sorted.take(limit)
    return DoneShelf(count = sorted.size, threads = shown, hiddenCount = sorted.size - shown.size)
}
