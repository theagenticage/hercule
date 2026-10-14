package dev.hercule.android.threads

import dev.hercule.android.office.AT
import dev.hercule.android.office.buildSession
import dev.hercule.android.wire.Session
import dev.hercule.android.wire.ThreadDone
import kotlin.test.assertEquals
import kotlin.time.Duration.Companion.minutes
import org.junit.Test

/**
 * Tests [buildDoneShelf]. The cases are copied from the `buildDoneShelf` cases in
 * packages/client-core/src/threads/sidebar-sections.test.ts. The source's case "always shows
 * the selected done thread, closed or past the limit, in its place" is left out, because the
 * port has no selected thread.
 */
class DoneShelfTest {
    /** Returns a thread marked Done [minutes] after 09:00, or not Done when [minutes] is null. */
    private fun buildDone(id: String, minutes: Int?): Session =
        buildSession(id).copy(done = minutes?.let { ThreadDone(AT + it.minutes, "user") })

    // 14 Done threads, s-done-13 marked last, and 2 open ones.
    private val threads =
        listOf(buildDone("s-open-a", null)) + (0 until 14).map { buildDone("s-done-$it", it) } + buildDone("s-open-b", null)

    @Test
    fun `counts every done thread, and shows none while closed`() {
        assertEquals(DoneShelf(count = 14, threads = emptyList(), hiddenCount = 0), buildDoneShelf(threads, limit = null))
    }

    @Test
    fun `shows the most recently marked done first, up to the limit, and counts the rest`() {
        val shelf = buildDoneShelf(threads, limit = DONE_SHELF_LIMIT)

        assertEquals(listOf(13, 12, 11, 10, 9, 8, 7, 6, 5, 4).map { "s-done-$it" }, shelf.threads.map { it.id })
        assertEquals(4, shelf.hiddenCount)
    }

    @Test
    fun `breaks a tie in done time by session id, whatever order the threads come in`() {
        val tied = listOf("s-c", "s-a", "s-b").map { buildDone(it, 5) }

        assertEquals(listOf("s-a", "s-b", "s-c"), buildDoneShelf(tied, limit = 10).threads.map { it.id })
    }
}
