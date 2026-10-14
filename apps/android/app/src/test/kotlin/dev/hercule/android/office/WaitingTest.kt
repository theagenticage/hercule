package dev.hercule.android.office

import dev.hercule.android.wire.Question
import dev.hercule.android.wire.QuestionOption
import dev.hercule.android.wire.QuestionRequest
import kotlin.test.assertEquals
import kotlin.time.Instant
import org.junit.Test

/**
 * Tests [listWaiting]. The cases are copied one for one from the `listWaiting` cases in
 * packages/client-core/src/waiting.test.ts. The source passes assistant rows; here each
 * assistant's session is its entry in the map of current sessions instead.
 */
class WaitingTest {
    private val early = Instant.parse("2026-09-10T09:00:00.000Z")
    private val middle = Instant.parse("2026-09-10T09:05:00.000Z")
    private val late = Instant.parse("2026-09-10T09:10:00.000Z")

    private val ada = buildAssistant("a-ada", "Ada")

    @Test
    fun `lists the threads with an open Request, with their question`() {
        val waiting = listWaiting(
            listOf(
                buildSession("s-1", title = "Fix the login bug", lastActivityAt = late, openRequests = listOf(buildCommandRequest("r-1", "git push"))),
                buildSession("s-2", title = "Idle thread"),
                buildSession("s-3", title = "Write the release notes", lastActivityAt = early, openRequests = listOf(buildCommandRequest("r-3", "pnpm test"))),
            ),
            emptyList(),
            emptyMap(),
        )
        assertEquals(
            listOf(
                WaitingThread("s-1", "r-1", "Fix the login bug", "Run git push?", "r-1", listOf("r-1"), "Run git push?", late),
                WaitingThread("s-3", "r-3", "Write the release notes", "Run pnpm test?", "r-3", listOf("r-3"), "Run pnpm test?", early),
            ),
            waiting,
        )
    }

    @Test
    fun `lists the assistants whose session has an open Request, and skips the rest`() {
        val asking = buildSession("s-ada", lastActivityAt = middle, openRequests = listOf(buildCommandRequest("r-ada", "git push")))
        val waiting = listWaiting(
            emptyList(),
            listOf(ada, buildAssistant("a-bob", "Bob"), buildAssistant("a-cy", "Cy")),
            mapOf("a-ada" to asking, "a-bob" to buildSession("s-bob")),
        )
        assertEquals(
            listOf(WaitingAssistant("a-ada", "Ada", "s-ada", "r-ada", "Run git push?", "r-ada", listOf("r-ada"), "Run git push?", middle)),
            waiting,
        )
    }

    @Test
    fun `mixes threads and assistants, the most recently active first`() {
        val waiting = listWaiting(
            listOf(
                buildSession("s-old", lastActivityAt = early, openRequests = listOf(buildCommandRequest("r-old", "ls"))),
                buildSession("s-new", lastActivityAt = late, openRequests = listOf(buildCommandRequest("r-new", "ls"))),
            ),
            listOf(ada),
            mapOf("a-ada" to buildSession("s-ada", lastActivityAt = middle, openRequests = listOf(buildCommandRequest("r-ada", "ls")))),
        )
        assertEquals(listOf("s-new", "s-ada", "s-old"), waiting.map { it.sessionId })
    }

    @Test
    fun `orders entries active at the same moment by session id, whatever the order of the lists`() {
        fun buildAsking(id: String) = buildSession(id, lastActivityAt = middle, openRequests = listOf(buildCommandRequest("r-$id", "ls")))
        val waiting = listWaiting(listOf(buildAsking("s-c"), buildAsking("s-a")), listOf(ada), mapOf("a-ada" to buildAsking("s-b")))
        assertEquals(listOf("s-a", "s-b", "s-c"), waiting.map { it.sessionId })
    }

    @Test
    fun `shows the oldest of a session's open Requests in the row, whichever agent asked it`() {
        val waiting = listWaiting(
            listOf(
                buildSession(
                    "s-1",
                    title = "Fix the login bug",
                    openRequests = listOf(buildCommandRequest("r-1", "git push", subagentId = "agent-1"), buildCommandRequest("r-2", "pnpm test")),
                ),
            ),
            emptyList(),
            emptyMap(),
        ).single()
        assertEquals("r-1", waiting.requestId)
        assertEquals("Run git push?", waiting.question)
    }

    @Test
    fun `shows the newest of a session's open Requests in the alert, and counts the others`() {
        val waiting = listWaiting(
            listOf(
                buildSession(
                    "s-1",
                    openRequests = listOf(
                        buildCommandRequest("r-1", "git push"),
                        buildCommandRequest("r-2", "pnpm test"),
                        buildCommandRequest("r-3", "make deploy"),
                    ),
                ),
            ),
            emptyList(),
            emptyMap(),
        ).single()
        assertEquals("r-3", waiting.newestRequestId)
        assertEquals(listOf("r-1", "r-2", "r-3"), waiting.openRequestIds)
        assertEquals("Run make deploy?\n+2 more waiting", waiting.alertBody)
    }

    @Test
    fun `starts the alert with the subagent's name when a subagent asked the newest Request`() {
        val session = buildSession(
            "s-ada",
            openRequests = listOf(
                buildCommandRequest("r-1", "git push"),
                buildCommandRequest("r-2", "pnpm test", subagentId = "agent-1", subagentName = "Review the diff"),
            ),
        )
        val waiting = listWaiting(emptyList(), listOf(ada), mapOf("a-ada" to session)).single()
        assertEquals("r-1", waiting.requestId)
        assertEquals("Run git push?", waiting.question)
        assertEquals("r-2", waiting.newestRequestId)
        assertEquals("Review the diff asks: Run pnpm test?\n+1 more waiting", waiting.alertBody)
    }

    @Test
    fun `starts the alert with A subagent asks when the subagent has no name yet`() {
        val waiting = listWaiting(
            listOf(buildSession("s-1", openRequests = listOf(buildCommandRequest("r-1", "pnpm test", subagentId = "agent-1")))),
            emptyList(),
            emptyMap(),
        ).single()
        assertEquals("A subagent asks: Run pnpm test?", waiting.alertBody)
    }

    @Test
    fun `lists a thread parked on a question, with its first question as its line`() {
        val question = QuestionRequest(
            "r-1",
            "tool-1",
            QuestionRequest.Detail(
                listOf(
                    Question(
                        "Which storage should drafts use?",
                        "Storage",
                        listOf(QuestionOption("localStorage", ""), QuestionOption("IndexedDB", "")),
                        multiSelect = false,
                    ),
                    Question("Which features should ship?", "Features", listOf(QuestionOption("Sync", "")), multiSelect = true),
                ),
            ),
        )
        assertEquals(
            listOf(
                WaitingThread(
                    "s-1",
                    "r-1",
                    "Save drafts",
                    "Which storage should drafts use?",
                    "r-1",
                    listOf("r-1"),
                    "Which storage should drafts use?",
                    early,
                ),
            ),
            listWaiting(listOf(buildSession("s-1", title = "Save drafts", openRequests = listOf(question))), emptyList(), emptyMap()),
        )
    }
}
