package dev.hercule.android.ui

import dev.hercule.android.office.AT
import dev.hercule.android.office.MOSS_ID
import dev.hercule.android.office.buildCommandRequest
import dev.hercule.android.office.buildRunner
import dev.hercule.android.office.buildSession
import dev.hercule.android.threads.buildThreadList
import dev.hercule.android.wire.Session
import kotlin.test.assertEquals
import org.junit.Test

/** Tests [StoreLists.countWaitingThreads], the Waiting on you badge on the tab bar and the back button. */
class StoreListsTest {
    private val runners = listOf(buildRunner(MOSS_ID, "moss"))

    /** Returns [session] waiting on the user to approve `git push`. */
    private fun markWaiting(session: Session): Session =
        session.copy(openRequests = listOf(buildCommandRequest("q-${session.id}", "git push")))

    @Test
    fun `counts the threads the Threads list shows as waiting, and leaves out runs and assistants`() {
        val sessions = listOf(
            markWaiting(buildSession("s-fix")),
            buildSession("s-idle"),
            markWaiting(buildSession("s-run")).copy(runId = "run-1"),
            markWaiting(buildSession("s-ada")).copy(agentId = "a-ada"),
        )
        val lists = StoreLists(sessions, assistants = emptyList(), currentSessions = emptyMap(), runners = runners, projects = emptyList())

        assertEquals(1, lists.countWaitingThreads())
        assertEquals(buildThreadList(sessions, runners, emptyList(), AT, null).waiting.size, lists.countWaitingThreads())
    }
}
