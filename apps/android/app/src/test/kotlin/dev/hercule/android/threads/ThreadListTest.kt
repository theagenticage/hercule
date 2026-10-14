package dev.hercule.android.threads

import dev.hercule.android.office.AT
import dev.hercule.android.office.MOSS_ID
import dev.hercule.android.office.buildCommandRequest
import dev.hercule.android.office.buildProject
import dev.hercule.android.office.buildRunner
import dev.hercule.android.office.buildSession
import dev.hercule.android.office.listWaiting
import dev.hercule.android.wire.Session
import dev.hercule.android.wire.ThreadDone
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.hours
import kotlin.time.Duration.Companion.minutes
import kotlin.time.Instant
import org.junit.Test

/**
 * Tests [buildThreadList]: which section each thread lands in, the order of the sections and
 * their rows, and what each row shows. The grouping and sorting rules themselves are tested in
 * [ProjectThreadsTest] and [DoneShelfTest]; these cases check that the list puts them together.
 */
class ThreadListTest {
    private val webshop = buildProject("p-webshop", "webshop")
    private val ops = buildProject("p-ops", "ops")
    private val projects = listOf(webshop, ops)
    private val runners = listOf(buildRunner(MOSS_ID, "moss"))

    // Every age is measured from 10:00, an hour after the fixtures' 09:00.
    private val now = AT + 1.hours

    /** Returns a time [minute] minutes after 09:00, so a larger number is newer. */
    private fun buildTimestamp(minute: Int): Instant = AT + minute.minutes

    private fun buildThread(id: String, projectId: String?, createdMinute: Int = 0, activeMinute: Int = 0): Session =
        buildSession(id, projectId = projectId, lastActivityAt = buildTimestamp(activeMinute)).copy(createdAt = buildTimestamp(createdMinute))

    /** Returns [thread] waiting on the user to approve `git push`. */
    private fun markWaiting(thread: Session): Session =
        thread.copy(openRequests = listOf(buildCommandRequest("q-${thread.id}", "git push")))

    /** Returns [thread] marked Done by the user [minute] minutes after 09:00. */
    private fun markDone(thread: Session, minute: Int): Session = thread.copy(done = ThreadDone(buildTimestamp(minute), "user"))

    private fun build(sessions: List<Session>, doneLimit: Int? = null): ThreadList =
        buildThreadList(sessions, runners, projects, now, doneLimit)

    private fun listSectionIds(list: ThreadList): List<Pair<String?, List<String>>> =
        list.projects.map { section -> section.project?.id to section.rows.map { it.sessionId } }

    @Test
    fun `groups threads under their projects, and puts the threads of no project or an unlisted project last`() {
        val list = build(
            listOf(
                buildThread("s-cart", webshop.id, createdMinute = 4),
                buildThread("s-keys", ops.id, createdMinute = 3),
                buildThread("s-loose", null, createdMinute = 2),
                // A deleted project is never listed again, but its threads keep its id.
                buildThread("s-orphan", "p-deleted", createdMinute = 1),
            ),
        )

        assertEquals(
            listOf(webshop.id to listOf("s-cart"), ops.id to listOf("s-keys"), null to listOf("s-loose", "s-orphan")),
            listSectionIds(list),
        )
        assertEquals(listOf(webshop, ops, null, null), list.projects.flatMap { section -> section.rows.map { it.project } })
    }

    @Test
    fun `orders projects by their newest thread, and threads newest started first`() {
        val list = build(
            listOf(
                buildThread("s-old", webshop.id, createdMinute = 1),
                buildThread("s-keys", ops.id, createdMinute = 3),
                buildThread("s-new", webshop.id, createdMinute = 5),
            ),
        )

        assertEquals(listOf(webshop.id to listOf("s-new", "s-old"), ops.id to listOf("s-keys")), listSectionIds(list))
    }

    @Test
    fun `lists a waiting thread both in Waiting on you and in its project, and counts it in the project`() {
        val list = build(listOf(markWaiting(buildThread("s-push", webshop.id)), buildThread("s-quiet", webshop.id), buildThread("s-keys", ops.id)))

        val waitingRow = list.waiting.single()
        assertEquals("s-push", waitingRow.sessionId)
        assertEquals(ThreadRowStatus.Age, waitingRow.status)
        assertEquals("Run git push?", waitingRow.detail)

        val webshopSection = list.projects.single { it.project == webshop }
        val projectRow = webshopSection.rows.single { it.sessionId == "s-push" }
        assertEquals(ThreadRowStatus.Approval, projectRow.status)
        assertEquals("Run git push?", projectRow.detail)
        assertEquals(1, webshopSection.waitingCount)
        assertEquals(0, list.projects.single { it.project == ops }.waitingCount)
    }

    @Test
    fun `sorts Waiting on you most recently active first, as listWaiting sorts it`() {
        val sessions = listOf(
            markWaiting(buildThread("s-a", webshop.id, activeMinute = 2)),
            markWaiting(buildThread("s-b", ops.id, activeMinute = 9)),
            markWaiting(buildThread("s-c", null, activeMinute = 5)),
        )
        val waitingIds = build(sessions).waiting.map { it.sessionId }

        assertEquals(listOf("s-b", "s-c", "s-a"), waitingIds)
        assertEquals(listWaiting(sessions, emptyList(), emptyMap()).map { it.sessionId }, waitingIds)
    }

    @Test
    fun `keeps a waiting thread marked Done in Waiting on you, and moves it from its project to the Done shelf`() {
        val list = build(listOf(markDone(markWaiting(buildThread("s-push", webshop.id)), 10)), doneLimit = DONE_SHELF_LIMIT)

        assertEquals(listOf("s-push"), list.waiting.map { it.sessionId })
        assertEquals(emptyList(), list.projects)
        assertEquals(listOf("s-push"), list.doneRows.map { it.sessionId })
    }

    @Test
    fun `leaves Done threads out of the projects, and shows them only while the shelf is open`() {
        val sessions = listOf(
            buildThread("s-open", webshop.id),
            markDone(buildThread("s-done-early", webshop.id), 10),
            markDone(buildThread("s-done-late", ops.id), 20),
        )

        val closed = build(sessions, doneLimit = null)
        assertEquals(listOf(webshop.id to listOf("s-open")), listSectionIds(closed))
        assertEquals(2, closed.doneCount)
        assertEquals(emptyList(), closed.doneRows)
        assertEquals(0, closed.hiddenDoneCount)

        val open = build(sessions, doneLimit = 1)
        assertEquals(2, open.doneCount)
        assertEquals(1, open.hiddenDoneCount)
        val row = open.doneRows.single()
        assertEquals("s-done-late", row.sessionId)
        assertEquals(ThreadRowStatus.Age, row.status)
        // Marked Done at 09:20, read at 10:00; its last activity, 09:00, would read "1h".
        assertEquals("40m", row.age)
    }

    @Test
    fun `leaves run sessions and an agent's sessions out of every section`() {
        val list = build(
            listOf(
                buildThread("s-mine", webshop.id),
                markWaiting(buildSession("s-run-waiting", projectId = webshop.id, runId = "run-1")),
                markDone(buildSession("s-run-done", projectId = webshop.id, runId = "run-1"), 10),
                markWaiting(buildSession("s-agent-waiting", projectId = webshop.id, agentId = "a-triage")),
                markDone(buildSession("s-agent-done", projectId = webshop.id, agentId = "a-triage"), 10),
            ),
            doneLimit = DONE_SHELF_LIMIT,
        )

        assertEquals(emptyList(), list.waiting)
        assertEquals(listOf(webshop.id to listOf("s-mine")), listSectionIds(list))
        assertEquals(0, list.doneCount)
        assertEquals(emptyList(), list.doneRows)
    }

    @Test
    fun `shows an idle thread's pose words, and its age since it was last active`() {
        val row = build(listOf(buildThread("s-idle", webshop.id, activeMinute = 15))).projects.single().rows.single()

        assertEquals(ThreadRowStatus.Age, row.status)
        assertEquals("idle", row.detail)
        assertEquals("45m", row.age)
    }

    @Test
    fun `is empty with no sessions, and not empty when every thread is Done`() {
        assertTrue(build(emptyList()).isEmpty())
        assertFalse(build(listOf(markDone(buildThread("s-done", webshop.id), 10))).isEmpty())
    }
}
