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
        AlertSnapshot(sessions.toList(), emptyList(), emptyList(), onScreen)

    private fun assistant(session: Session? = null, vararg messages: Pair<Long, ConversationSenderRole>, onScreen: AlertKey? = null) =
        AlertSnapshot(
            threads = emptyList(),
            assistants = listOf(
                AssistantAlertSource(buildAssistant(), session, messages.map { (position, role) -> buildMessage(position, "message $position", role) }),
            ),
            followedTranscript = emptyList(),
            keyOnScreen = onScreen,
        )

    private fun AlertDecision.posts() = changes.filterIsInstance<AlertChange.Post>()
    private fun AlertDecision.refreshes() = changes.filterIsInstance<AlertChange.Refresh>()
    private fun AlertDecision.removes() = changes.filterIsInstance<AlertChange.Remove>().map { it.key }

    @Test
    fun `a thread alerts with sound when a new Request opens`() {
        val decision = decideInOrder(
            threads(buildSession("s1")),
            threads(buildSession("s1", openRequests = listOf(buildCommand("r1", "git push")))),
        )

        val post = decision.posts().single()
        assertTrue(post.withSound)
        val alert = assertIs<ThreadRequestAlert>(post.alert)
        assertEquals("Fix 3-D Secure checkout · Request", alert.heading)
        assertEquals("Run git push?", alert.message)
        assertEquals(ShownAlert("r1"), decision.memory.shownAlerts[thread.id])
    }

    @Test
    fun `a newer Request replaces the earlier alert, and the alert counts the others`() {
        val decision = decideInOrder(
            threads(buildSession("s1")),
            threads(buildSession("s1", openRequests = listOf(buildCommand("r1")))),
            threads(buildSession("s1", openRequests = listOf(buildCommand("r1"), buildQuestion("r2")))),
        )

        val alert = assertIs<ThreadRequestAlert>(decision.posts().single().alert)
        assertEquals("r2", alert.requestId)
        assertEquals("Fix 3-D Secure checkout · Question", alert.heading)
        assertEquals("Which region should the rollout start in?\n+1 more waiting", alert.message)
    }

    @Test
    fun `opening a thread removes its alert, and its Requests do not alert while it is on screen`() {
        val decision = decideInOrder(
            threads(buildSession("s1")),
            threads(buildSession("s1", openRequests = listOf(buildCommand("r1")))),
            threads(buildSession("s1", openRequests = listOf(buildCommand("r1"), buildCommand("r2"))), onScreen = thread),
        )

        assertEquals(listOf<AlertKey>(thread), decision.removes())
        assertTrue(decision.posts().isEmpty())
        assertFalse(decision.liveUpdate!!.alert)
    }

    @Test
    fun `an alert is removed when its Request closes, and no older Request takes its place`() {
        val decision = decideInOrder(
            threads(buildSession("s1", openRequests = listOf(buildCommand("r1")))),
            threads(buildSession("s1", openRequests = listOf(buildCommand("r1"), buildCommand("r2")))),
            threads(buildSession("s1", openRequests = listOf(buildCommand("r1")))),
        )

        assertEquals(listOf<AlertKey>(thread), decision.removes())
        assertTrue(decision.posts().isEmpty())
        assertNull(decision.memory.shownAlerts[thread.id])
    }

    @Test
    fun `the first list alerts for nothing but still removes an alert whose Request was answered`() {
        val first = decideAlerts(
            threads(buildSession("s1", openRequests = listOf(buildCommand("r1"))), buildSession("s2")),
            AlertMemory(shownAlerts = mapOf("thread:s2" to ShownAlert("old"))),
            isFirstList = true,
        )
        assertTrue(first.posts().isEmpty())
        assertEquals(listOf<AlertKey>(ThreadAlertKey("s2")), first.removes())

        val next = decideAlerts(threads(buildSession("s1", openRequests = listOf(buildCommand("r1")))), first.memory, isFirstList = false)
        assertTrue(next.changes.isEmpty(), "a Request recorded by the first list is not new")
    }

    @Test
    fun `a run session never alerts`() {
        val decision = decideInOrder(
            threads(buildSession("s1", runId = "run-1")),
            threads(buildSession("s1", runId = "run-1", openRequests = listOf(buildCommand("r1")))),
        )
        assertTrue(decision.changes.isEmpty())
    }

    @Test
    fun `a destination that leaves the lists loses its alert`() {
        val decision = decideInOrder(
            threads(buildSession("s1")),
            threads(buildSession("s1", openRequests = listOf(buildCommand("r1")))),
            threads(),
        )
        assertEquals(listOf<AlertKey>(thread), decision.removes())
    }

    @Test
    fun `the followed thread alerts once through its Live Update and has no alert of its own`() {
        val opened = threads(buildSession("s1"), onScreen = thread)
        val waiting = threads(buildSession("s1", openRequests = listOf(buildCommand("r1"))))

        val first = decideInOrder(opened, waiting)
        assertTrue(first.posts().isEmpty())
        assertEquals("s1", first.memory.followedSessionId)
        assertTrue(first.liveUpdate!!.alert)
        assertTrue(first.liveUpdate.isWaiting)

        val again = decideInOrder(opened, waiting, waiting)
        assertFalse(again.liveUpdate!!.alert, "the same Request alerts once")
    }

    @Test
    fun `the followed thread's Live Update does not alert while the thread is on screen`() {
        val decision = decideInOrder(
            threads(buildSession("s1"), onScreen = thread),
            threads(buildSession("s1", openRequests = listOf(buildCommand("r1"))), onScreen = thread),
        )
        assertFalse(decision.liveUpdate!!.alert)
    }

    @Test
    fun `the follow ends when the thread goes idle off screen, and lasts while it is on screen`() {
        val idle = decideInOrder(
            threads(buildSession("s1"), onScreen = thread),
            threads(buildSession("s1", status = SessionStatus.Idle)),
        )
        assertNull(idle.liveUpdate)
        assertNull(idle.memory.followedSessionId)

        val onScreen = decideInOrder(threads(buildSession("s1", status = SessionStatus.Idle), onScreen = thread))
        assertNull(onScreen.liveUpdate, "an idle thread has no Live Update, even on screen")
        assertEquals("s1", onScreen.memory.followedSessionId)
    }

    @Test
    fun `a thread on screen loses its Live Update when it goes idle and gets it back when it works again`() {
        val working = threads(buildSession("s1"), onScreen = thread)
        val idle = threads(buildSession("s1", status = SessionStatus.Idle), onScreen = thread)
        val exited = threads(buildSession("s1", status = SessionStatus.Exited), onScreen = thread)

        assertNull(decideInOrder(working, idle).liveUpdate)
        assertNull(decideInOrder(working, exited).liveUpdate)
        assertEquals("s1", decideInOrder(working, idle, working).liveUpdate?.sessionId)
    }

    @Test
    fun `a thread alert is shown again silently when an older Request closes, so its count stays true`() {
        val decision = decideInOrder(
            threads(buildSession("s1")),
            threads(buildSession("s1", openRequests = listOf(buildCommand("r1")))),
            threads(buildSession("s1", openRequests = listOf(buildCommand("r1"), buildCommand("r2", "git push")))),
            threads(buildSession("s1", openRequests = listOf(buildCommand("r2", "git push")))),
        )

        val alert = assertIs<ThreadRequestAlert>(decision.refreshes().single().alert)
        assertEquals("Run git push?", alert.message)
        assertTrue(decision.posts().isEmpty())
        assertEquals(ShownAlert("r2"), decision.memory.shownAlerts[thread.id])
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
    fun `a followed thread that still waits when the user opens another one gets a silent alert`() {
        val decision = decideInOrder(
            threads(buildSession("s1"), buildSession("s2"), onScreen = thread),
            threads(buildSession("s1", openRequests = listOf(buildCommand("r1"))), buildSession("s2")),
            threads(buildSession("s1", openRequests = listOf(buildCommand("r1"))), buildSession("s2"), onScreen = ThreadAlertKey("s2")),
        )

        val post = decision.posts().single()
        assertEquals(thread, post.key)
        assertFalse(post.withSound)
        assertEquals("s2", decision.liveUpdate?.sessionId)
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
        assertEquals(AlertActions.Reply("conversation-assistant-1"), alert.actions)

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
