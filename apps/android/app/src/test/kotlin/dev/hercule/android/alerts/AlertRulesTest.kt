package dev.hercule.android.alerts

import dev.hercule.android.wire.ConversationSenderRole
import dev.hercule.android.wire.Session
import dev.hercule.android.wire.SessionStatus
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.junit.Test

/** Tests the alert rules, one test per rule, by feeding [decideAlerts] one list after another. */
class AlertRulesTest {
    private val thread = ThreadAlertKey("s1")
    private val poirot = AssistantAlertKey("assistant-1")

    /** Feeds the lists in order, each with the memory the one before it left, and returns the last decision. */
    private fun decideInOrder(vararg snapshots: AlertSnapshot, isFirstList: Boolean = false): AlertDecision {
        var memory = AlertMemory()
        lateinit var decision: AlertDecision
        snapshots.forEachIndexed { index, snapshot ->
            decision = decideAlerts(snapshot, memory, isFirstList = isFirstList && index == 0)
            memory = decision.memory
        }
        return decision
    }

    private fun threads(vararg sessions: Session, onScreen: AlertKey? = null) =
        AlertSnapshot(sessions.toList(), emptyList(), emptyMap(), onScreen)

    private fun assistant(session: Session? = null, vararg messages: Pair<Long, ConversationSenderRole>, onScreen: AlertKey? = null) =
        AlertSnapshot(
            threads = emptyList(),
            assistants = listOf(
                AssistantAlertSource(buildAssistant(), session, messages.map { (position, role) -> buildMessage(position, "message $position", role) }),
            ),
            liveUpdateTranscripts = emptyMap(),
            keyOnScreen = onScreen,
        )

    private fun AlertDecision.posts() = changes.filterIsInstance<AlertChange.Post>()
    private fun AlertDecision.refreshes() = changes.filterIsInstance<AlertChange.Refresh>()
    private fun AlertDecision.removes() = changes.filterIsInstance<AlertChange.Remove>().map { it.key }
    private fun AlertDecision.liveUpdate(sessionId: String = "s1") = liveUpdates.single { it.sessionId == sessionId }

    @Test
    fun `a waiting thread's Live Update alerts once when a new Request opens, whether or not the thread is followed`() {
        val waiting = threads(buildSession("s1", openRequests = listOf(buildCommand("r1", "git push"))))

        val first = decideInOrder(threads(buildSession("s1")), waiting)
        assertTrue(first.changes.isEmpty(), "a thread has no alert besides its Live Update")
        assertNull(first.memory.followedSessionId)
        val update = first.liveUpdate()
        assertTrue(update.alert)
        assertTrue(update.isWaiting)
        assertEquals("r1", update.requestId)
        assertEquals("Waiting on you · Run git push?", update.text)
        assertEquals("Run?", update.shortText)

        assertFalse(decideInOrder(threads(buildSession("s1")), waiting, waiting).liveUpdate().alert, "the same Request alerts once")
    }

    @Test
    fun `a newer Request alerts again, and the Live Update counts the others`() {
        val decision = decideInOrder(
            threads(buildSession("s1")),
            threads(buildSession("s1", openRequests = listOf(buildCommand("r1")))),
            threads(buildSession("s1", openRequests = listOf(buildCommand("r1"), buildQuestion("r2")))),
        )

        val update = decision.liveUpdate()
        assertTrue(update.alert)
        assertEquals("r2", update.requestId)
        assertEquals("Waiting on you · Which region should the rollout start in?\n+1 more waiting", update.text)
    }

    @Test
    fun `a thread's Live Update does not name the subagent that asks`() {
        val decision = decideInOrder(
            threads(buildSession("s1")),
            threads(buildSession("s1", openRequests = listOf(buildCommand("r1", "git push", subagentId = "agent-1", subagentName = "Review the diff")))),
        )

        assertEquals("Waiting on you · Run git push?", decision.liveUpdate().text)
    }

    @Test
    fun `every waiting thread shows a Live Update, and so does the followed thread while it works`() {
        val decision = decideInOrder(
            threads(buildSession("s1"), buildSession("s2"), buildSession("s3"), buildSession("s4", status = SessionStatus.Idle), onScreen = thread),
            threads(
                buildSession("s1"),
                buildSession("s2", openRequests = listOf(buildCommand("r1"))),
                buildSession("s3", openRequests = listOf(buildCommand("r2"))),
                buildSession("s4", status = SessionStatus.Idle),
            ),
        )

        assertEquals(listOf("s1", "s2", "s3"), decision.liveUpdates.map { it.sessionId })
        assertFalse(decision.liveUpdate("s1").isWaiting)
        assertFalse(decision.liveUpdate("s1").alert, "a working thread does not alert")
        assertTrue(decision.liveUpdate("s2").alert)
        assertTrue(decision.liveUpdate("s3").alert)
    }

    @Test
    fun `a thread on screen does not alert`() {
        val decision = decideInOrder(
            threads(buildSession("s1")),
            threads(buildSession("s1", openRequests = listOf(buildCommand("r1"))), onScreen = thread),
        )
        assertFalse(decision.liveUpdate().alert)
    }

    @Test
    fun `a Live Update ends when its thread's last Request closes, unless the thread is followed and works`() {
        val waiting = threads(buildSession("s1", openRequests = listOf(buildCommand("r1"))))
        val answered = threads(buildSession("s1"))

        assertTrue(decideInOrder(waiting, answered).liveUpdates.isEmpty())
        assertFalse(decideInOrder(threads(buildSession("s1"), onScreen = thread), waiting, answered).liveUpdate().isWaiting)
    }

    @Test
    fun `the first list alerts for nothing, and forgets a thread's alert an earlier version of the app remembered`() {
        val first = decideAlerts(
            threads(buildSession("s1", openRequests = listOf(buildCommand("r1"))), buildSession("s2")),
            AlertMemory(shownAlerts = mapOf("thread:s2" to ShownAlert("old"))),
            isFirstList = true,
        )
        assertTrue(first.changes.isEmpty())
        assertTrue(first.memory.shownAlerts.isEmpty())
        assertFalse(first.liveUpdate().alert)

        val next = decideAlerts(threads(buildSession("s1", openRequests = listOf(buildCommand("r1")))), first.memory, isFirstList = false)
        assertFalse(next.liveUpdate().alert, "a Request recorded by the first list is not new")
    }

    @Test
    fun `a run session shows no Live Update`() {
        val decision = decideInOrder(
            threads(buildSession("s1", runId = "run-1")),
            threads(buildSession("s1", runId = "run-1", openRequests = listOf(buildCommand("r1")))),
        )
        assertTrue(decision.liveUpdates.isEmpty())
    }

    @Test
    fun `a thread that leaves the list loses its Live Update`() {
        val decision = decideInOrder(
            threads(buildSession("s1")),
            threads(buildSession("s1", openRequests = listOf(buildCommand("r1")))),
            threads(),
        )
        assertTrue(decision.liveUpdates.isEmpty())
    }

    @Test
    fun `the follow ends when the thread goes idle off screen, and lasts while it is on screen`() {
        val idle = decideInOrder(
            threads(buildSession("s1"), onScreen = thread),
            threads(buildSession("s1", status = SessionStatus.Idle)),
        )
        assertTrue(idle.liveUpdates.isEmpty())
        assertNull(idle.memory.followedSessionId)

        val onScreen = decideInOrder(threads(buildSession("s1", status = SessionStatus.Idle), onScreen = thread))
        assertTrue(onScreen.liveUpdates.isEmpty(), "an idle thread has no Live Update, even on screen")
        assertEquals("s1", onScreen.memory.followedSessionId)
    }

    @Test
    fun `a thread on screen loses its Live Update when it goes idle and gets it back when it works again`() {
        val working = threads(buildSession("s1"), onScreen = thread)
        val idle = threads(buildSession("s1", status = SessionStatus.Idle), onScreen = thread)
        val exited = threads(buildSession("s1", status = SessionStatus.Exited), onScreen = thread)

        assertTrue(decideInOrder(working, idle).liveUpdates.isEmpty())
        assertTrue(decideInOrder(working, exited).liveUpdates.isEmpty())
        assertEquals("s1", decideInOrder(working, idle, working).liveUpdate().sessionId)
    }

    @Test
    fun `a followed thread that still waits when the user opens another one keeps its Live Update, silently`() {
        val decision = decideInOrder(
            threads(buildSession("s1"), buildSession("s2"), onScreen = thread),
            threads(buildSession("s1", openRequests = listOf(buildCommand("r1"))), buildSession("s2")),
            threads(buildSession("s1", openRequests = listOf(buildCommand("r1"))), buildSession("s2"), onScreen = ThreadAlertKey("s2")),
        )

        assertEquals(listOf("s1", "s2"), decision.liveUpdates.map { it.sessionId })
        assertFalse(decision.liveUpdate("s1").alert)
        assertEquals("s2", decision.memory.followedSessionId)
    }

    @Test
    fun `an assistant alert is shown again silently when an older Request closes, so its count stays true`() {
        val both = buildSession("as1", openRequests = listOf(buildCommand("r1"), buildCommand("r2", "git push")))
        val decision = decideInOrder(
            assistant(null),
            assistant(buildSession("as1", openRequests = listOf(buildCommand("r1")))),
            assistant(both),
            assistant(buildSession("as1", openRequests = listOf(buildCommand("r2", "git push")))),
        )

        val alert = assertIs<AssistantAlert>(decision.refreshes().single().alert)
        assertEquals("Run git push?", alert.messages.last().text)
        assertTrue(decision.posts().isEmpty())
    }

    @Test
    fun `an assistant alerts with sound on a new message from it, and not on the owner's own`() {
        val decision = decideInOrder(
            assistant(null, 1L to ConversationSenderRole.Owner),
            assistant(null, 1L to ConversationSenderRole.Owner, 2L to ConversationSenderRole.Assistant),
        )
        val post = decision.posts().single()
        assertTrue(post.withSound)
        val alert = assertIs<AssistantAlert>(post.alert)
        assertEquals(listOf(true, false), alert.messages.map { it.fromOwner })
        assertEquals(AlertActions.Reply("conversation-assistant-1", 2L), alert.actions)

        val owner = decideInOrder(
            assistant(null, 1L to ConversationSenderRole.Assistant),
            assistant(null, 1L to ConversationSenderRole.Assistant, 2L to ConversationSenderRole.Owner),
        )
        assertTrue(owner.posts().isEmpty())
    }

    @Test
    fun `an assistant alert shows its last six messages and its open Request as the newest`() {
        val messages = (1L..8L).map { it to ConversationSenderRole.Assistant }.toTypedArray()
        val session = buildSession("as1", openRequests = listOf(buildCommand("r1", "ls")))
        val decision = decideInOrder(assistant(null), assistant(session, *messages))

        val alert = assertIs<AssistantAlert>(decision.posts().single().alert)
        assertEquals((3..8).map { "message $it" } + "Run ls?", alert.messages.map { it.text })
        assertEquals("r1", alert.requestId)
        assertIs<AlertActions.Approve>(alert.actions)
    }

    @Test
    fun `an assistant alert posted again keeps the owner's messages between the assistant's, whoever sent them`() {
        // The owner's messages 3 and 5 came from another client, and the user swiped the alert
        // away after message 4. Each new reply posts the alert again with every turn in order.
        val owner = ConversationSenderRole.Owner
        val ada = ConversationSenderRole.Assistant
        val decision = decideInOrder(
            assistant(null, 1L to owner, 2L to ada),
            assistant(null, 1L to owner, 2L to ada, 3L to owner, 4L to ada),
            assistant(null, 1L to owner, 2L to ada, 3L to owner, 4L to ada, 5L to owner, 6L to ada),
        )

        val alert = assertIs<AssistantAlert>(decision.posts().single().alert)
        assertEquals((1..6).map { "message $it" }, alert.messages.map { it.text })
        assertEquals(listOf(true, false, true, false, true, false), alert.messages.map { it.fromOwner })
    }

    @Test
    fun `an assistant alert is shown again silently with Reply when its Request closes`() {
        val waiting = buildSession("as1", openRequests = listOf(buildCommand("r1")))
        val decision = decideInOrder(assistant(null), assistant(waiting), assistant(buildSession("as1")))

        // A refresh, not a post: an alert the user swiped away stays away.
        assertTrue(decision.posts().isEmpty())
        assertIs<AlertActions.Reply>(decision.refreshes().single().alert.actions)
        assertEquals(ShownAlert(null), decision.memory.shownAlerts[poirot.id])
    }

    @Test
    fun `an assistant on screen does not alert`() {
        val decision = decideInOrder(
            assistant(null),
            assistant(buildSession("as1", openRequests = listOf(buildCommand("r1"))), 1L to ConversationSenderRole.Assistant, onScreen = poirot),
        )
        assertTrue(decision.posts().isEmpty())
        assertEquals(1L, decision.memory.lastMessagePositions[poirot.assistantId])
    }

    @Test
    fun `opening an assistant removes its alert, and answering its Request there posts nothing`() {
        val waiting = buildSession("as1", openRequests = listOf(buildCommand("r1")))
        val opened = decideInOrder(assistant(null), assistant(waiting), assistant(waiting, onScreen = poirot))
        assertEquals(listOf<AlertKey>(poirot), opened.removes())

        val answered = decideInOrder(assistant(null), assistant(waiting), assistant(buildSession("as1"), onScreen = poirot))
        assertTrue(answered.posts().isEmpty())
        assertNull(answered.memory.shownAlerts[poirot.id])
    }

    @Test
    fun `follows the thread on screen, or else the one followed before`() {
        assertEquals("s2", decideFollowedSessionId(AlertMemory(followedSessionId = "s1"), ThreadAlertKey("s2")))
        assertEquals("s1", decideFollowedSessionId(AlertMemory(followedSessionId = "s1"), poirot))
        assertNull(decideFollowedSessionId(AlertMemory(), null))
    }
}
