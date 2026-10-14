package dev.hercule.android.threads

import dev.hercule.android.office.AT
import dev.hercule.android.office.buildProject
import dev.hercule.android.office.buildSession
import dev.hercule.android.wire.Session
import kotlin.test.assertEquals
import kotlin.time.Duration.Companion.minutes
import kotlin.time.Instant
import org.junit.Test

/**
 * Tests [pickLastStartedAt] and [groupThreadsByProject]. The cases are copied from:
 *
 * - the `listProjectRows` and `sortProjectsByNewestThread` cases in
 *   packages/client-core/src/threads/project-rows.test.ts that check order, leaving out the
 *   row details, workspaces and draft the port does not have;
 * - the `buildThreadGroups` cases in packages/client-core/src/threads/groups.test.ts about
 *   which group a thread joins and where the threads of no project go.
 */
class ProjectThreadsTest {
    private val webshop = buildProject("p-webshop", "webshop")
    private val ops = buildProject("p-ops", "ops")
    private val projects = listOf(webshop, ops)

    /** Returns a time [minute] minutes after 09:00, so a larger number is newer. */
    private fun buildTimestamp(minute: Int): Instant = AT + minute.minutes

    private fun buildThread(id: String, projectId: String?, createdMinute: Int, activeMinute: Int): Session =
        buildSession(id, projectId = projectId, lastActivityAt = buildTimestamp(activeMinute)).copy(createdAt = buildTimestamp(createdMinute))

    // webshop's threads were created in the opposite order to their latest activity, so a list
    // sorted by activity would differ from one sorted by creation.
    private val sessions = listOf(
        buildThread("s-flaky", webshop.id, createdMinute = 1, activeMinute = 9),
        buildThread("s-bun", webshop.id, createdMinute = 3, activeMinute = 4),
        buildThread("s-promotion-b", webshop.id, createdMinute = 5, activeMinute = 2),
        buildThread("s-promotion-a", webshop.id, createdMinute = 5, activeMinute = 1),
        buildThread("s-keys", ops.id, createdMinute = 6, activeMinute = 3),
        buildThread("s-loose", null, createdMinute = 8, activeMinute = 8),
    )

    private fun listIds(threads: List<Session>, projectId: String?): List<String> =
        groupThreadsByProject(threads, projects).single { it.projectId == projectId }.threads.map { it.id }

    private fun listProjectIds(groups: List<ProjectThreads>): List<String?> = groups.map { it.projectId }

    @Test
    fun `lists a project's threads in one list, newest created first, ties by session id`() {
        assertEquals(listOf("s-promotion-a", "s-promotion-b", "s-bun", "s-flaky"), listIds(sessions, webshop.id))
    }

    @Test
    fun `puts a reopened thread where its reopening puts it, and ignores a reopening older than the thread`() {
        val reopened = sessions.map {
            when (it.id) {
                "s-flaky" -> it.copy(reopenedAt = buildTimestamp(7))
                // A reopening stamped before the thread was created leaves its place alone.
                "s-bun" -> it.copy(reopenedAt = buildTimestamp(0))
                else -> it
            }
        }
        val webshopThreads = groupThreadsByProject(reopened, projects).single { it.projectId == webshop.id }.threads

        assertEquals(
            listOf(
                "s-flaky" to buildTimestamp(7),
                "s-promotion-a" to buildTimestamp(5),
                "s-promotion-b" to buildTimestamp(5),
                "s-bun" to buildTimestamp(3),
            ),
            webshopThreads.map { it.id to pickLastStartedAt(it) },
        )
    }

    @Test
    fun `sorts projects by their newest created thread, with the threads of no project last`() {
        // By latest activity webshop comes first; by creation ops does.
        assertEquals(listOf(ops.id, webshop.id, null), listProjectIds(groupThreadsByProject(sessions, projects)))
    }

    @Test
    fun `sorts projects whose newest threads were created at the same moment by project id, whatever order they came in`() {
        // ops's newest thread is now as new as webshop's.
        val tied = sessions.filter { it.projectId != null }.map { if (it.id == "s-keys") it.copy(createdAt = buildTimestamp(5)) else it }
        val byId = listOf(ops.id, webshop.id)

        assertEquals(byId, listProjectIds(groupThreadsByProject(tied, projects)))
        assertEquals(byId, listProjectIds(groupThreadsByProject(tied.reversed(), projects)))
        assertEquals(byId, listProjectIds(groupThreadsByProject(tied, projects.reversed())))
    }

    @Test
    fun `heads each project with its threads, with the threads in no project last`() {
        assertEquals(
            listOf(ops.id to 1, webshop.id to 4, null to 1),
            groupThreadsByProject(sessions, projects).map { it.projectId to it.threads.size },
        )
    }

    // A deleted project is never listed again, but its threads keep its id. A group for it would
    // have no name to title it.
    @Test
    fun `puts a thread whose project is not in the project list with the threads in no project`() {
        val groups = groupThreadsByProject(sessions + buildThread("s-orphan", "p-deleted", createdMinute = 9, activeMinute = 0), projects)

        assertEquals(listOf(ops.id to 1, webshop.id to 4, null to 2), groups.map { it.projectId to it.threads.size })
        assertEquals(listOf("s-orphan", "s-loose"), groups.last().threads.map { it.id })
    }

    @Test
    fun `returns no groups when there are no threads`() {
        assertEquals(emptyList(), groupThreadsByProject(emptyList(), projects))
    }
}
