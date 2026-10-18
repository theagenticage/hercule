package dev.hercule.android.ui.thread

import dev.hercule.android.office.AT
import dev.hercule.android.office.buildAssistant
import dev.hercule.android.office.buildSession
import dev.hercule.android.threads.MessageSender
import dev.hercule.android.threads.SenderLink
import dev.hercule.android.ui.StoreLists
import dev.hercule.android.wire.Session
import kotlin.test.assertEquals
import org.junit.Test

/**
 * Tests [decideMessageSenders]: where each sender's session comes from, and which senders are
 * still to be read. How a session is named is tested in SenderTest.
 */
class MessageSendersTest {
    private val ada = buildAssistant("a-ada", "Ada")
    private val lists = StoreLists(
        threads = listOf(buildSession("s-fix", title = "Fix EU checkout")),
        assistants = listOf(ada),
        currentSessions = mapOf(ada.id to buildSession("s-ada", agentId = ada.id, conversationId = ada.mainConversationId)),
        runners = emptyList(),
        projects = emptyList(),
    )

    private fun buildMessage(key: String, senderSessionId: String?) = UserBlock(key, "Done.", AT, senderSessionId)

    /** Returns the name each sender shows, or "unread" for one still to be read. */
    private fun decideNames(senderSessionIds: List<String?>, senderSessions: Map<String, Session?> = emptyMap()) =
        decideMessageSenders(senderSessionIds.mapIndexed { index, id -> buildMessage("m$index", id) }, lists, senderSessions)
            .mapValues { (_, sender) -> if (sender is MessageSender.Agent) sender.reading.name else "unread" }

    @Test
    fun `leaves the owner's messages out`() {
        assertEquals(emptyMap(), decideNames(listOf(null, null)))
    }

    @Test
    fun `names a listed thread and an assistant's current session from the lists, reading nothing`() {
        assertEquals(mapOf("s-fix" to "Fix EU checkout", "s-ada" to "Ada"), decideNames(listOf("s-fix", "s-ada", "s-fix")))
    }

    @Test
    fun `links a listed thread to its thread`() {
        val sender = decideMessageSenders(listOf(buildMessage("m1", "s-fix")), lists, emptyMap()).getValue("s-fix")
        assertEquals(SenderLink.Thread("s-fix"), (sender as MessageSender.Agent).reading.link)
    }

    @Test
    fun `prefers the lists over a session read before, so a new title shows at once`() {
        val earlier = buildSession("s-fix", title = "")
        assertEquals(mapOf("s-fix" to "Fix EU checkout"), decideNames(listOf("s-fix"), mapOf("s-fix" to earlier)))
        assertEquals(mapOf("s-fix" to "Fix EU checkout"), decideNames(listOf("s-fix"), mapOf("s-fix" to null)))
    }

    @Test
    fun `names a session no list holds from its read, and leaves it unread until the read answers`() {
        val step = buildSession("s-step", title = "Review the diff", agentId = "ag-reviewer", runId = "run-1")
        assertEquals(mapOf("s-step" to "unread"), decideNames(listOf("s-step")))
        assertEquals(mapOf("s-step" to "Review the diff"), decideNames(listOf("s-step"), mapOf("s-step" to step)))
        assertEquals(mapOf("s-step" to "Another agent"), decideNames(listOf("s-step"), mapOf("s-step" to null)))
    }
}
