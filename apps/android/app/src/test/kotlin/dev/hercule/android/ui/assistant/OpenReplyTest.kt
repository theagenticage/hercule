package dev.hercule.android.ui.assistant

import dev.hercule.android.office.buildSession
import dev.hercule.android.wire.AssistantReply
import dev.hercule.android.wire.ConversationMessage
import dev.hercule.android.wire.ConversationSenderRole
import dev.hercule.android.wire.ExitReason
import dev.hercule.android.wire.ItemKind
import dev.hercule.android.wire.ItemStatus
import dev.hercule.android.wire.HarnessEvent
import dev.hercule.android.wire.Session
import dev.hercule.android.wire.SessionStatus
import dev.hercule.android.wire.StreamKind
import dev.hercule.android.wire.TranscriptRow
import dev.hercule.android.wire.TurnState
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.time.Instant
import org.junit.Test

/**
 * Tests [decideOpenReply] with the cases of client-core's `conversation-blocks.test.ts`, which
 * decides the same reply for the desktop, and [buildOpenReplyText], which adds the streaming
 * tail. The cases about the pose are left out, because the port takes no pose.
 *
 * The transcript fixtures follow the adapters' real shapes: an assistant text's words arrive
 * only in `content.delta` rows.
 */
class OpenReplyTest {
    private var position = 0L
    private var messagePosition = 0L

    private fun buildRow(event: HarnessEvent) = TranscriptRow(++position, TODAY, event)

    private fun turnStarted(turnId: String) = buildRow(HarnessEvent.TurnStarted(turnId = turnId))

    private fun turnCompleted(turnId: String, state: TurnState = TurnState.Completed) =
        buildRow(HarnessEvent.TurnCompleted(turnId = turnId, state = state))

    private fun itemStarted(turnId: String, itemId: String, kind: ItemKind = ItemKind.AssistantMessage) =
        buildRow(HarnessEvent.ItemStarted(turnId = turnId, itemId = itemId, kind = kind))

    private fun itemCompleted(
        turnId: String,
        itemId: String,
        status: ItemStatus = ItemStatus.Completed,
        kind: ItemKind = ItemKind.AssistantMessage,
    ) = buildRow(HarnessEvent.ItemCompleted(turnId = turnId, itemId = itemId, kind = kind, status = status))

    private fun text(turnId: String, itemId: String, delta: String) =
        buildRow(HarnessEvent.ContentDelta(turnId = turnId, itemId = itemId, streamKind = StreamKind.AssistantText, delta = delta))

    private fun sessionExited() = buildRow(HarnessEvent.SessionExited(ExitReason("crash")))

    private fun sessionStarted() = buildRow(HarnessEvent.SessionStarted)

    /** Returns the rows of a whole assistant text: its start, its words, and its end. */
    private fun assistantText(turnId: String, itemId: String, text: String) =
        listOf(itemStarted(turnId, itemId), text(turnId, itemId, text), itemCompleted(turnId, itemId))

    /** Returns the row of a tool call that has started and not completed. */
    private fun runningTool(turnId: String, itemId: String) = itemStarted(turnId, itemId, ItemKind.CommandExecution)

    private fun message(
        senderRole: ConversationSenderRole,
        turnId: String? = null,
        itemId: String? = null,
        text: String? = null,
        createdAt: String = TODAY,
    ): ConversationMessage {
        messagePosition += 1
        val isOwner = senderRole == ConversationSenderRole.Owner
        return ConversationMessage(
            id = "m$messagePosition",
            conversationId = "c1",
            containerKey = null,
            position = messagePosition,
            senderRole = senderRole,
            senderLabel = if (isOwner) "rogier" else "Ada",
            text = text ?: "message $messagePosition",
            sessionId = if (isOwner) null else "s1",
            turnId = turnId,
            itemId = itemId,
            actor = if (isOwner) "user" else "session:s1",
            createdAt = Instant.parse(createdAt),
        )
    }

    private fun owner(createdAt: String = TODAY) = message(ConversationSenderRole.Owner, createdAt = createdAt)

    /** Builds a reply stored for [turnId] that holds the text [itemId], or, with a null [itemId], the turn's texts joined. */
    private fun reply(turnId: String, itemId: String?, text: String = "stored") =
        message(ConversationSenderRole.Assistant, turnId, itemId, text)

    private fun decide(
        rows: List<TranscriptRow> = emptyList(),
        messages: List<ConversationMessage> = emptyList(),
        session: Session? = BUSY,
        mode: AssistantReply = AssistantReply.TurnEnd,
    ) = decideOpenReply(messages, rows, session, mode)

    /** Returns the open reply's items as "<itemId>:<rowText>". */
    private fun describeItems(reply: OpenReply?) = reply?.items.orEmpty().map { "${it.itemId}:${it.rowText}" }

    // In turn-end mode.

    @Test
    fun `turn-end - shows the text being written, with its id as the open item`() {
        val reply = decide(listOf(turnStarted("t1"), itemStarted("t1", "a1"), text("t1", "a1", "Look")))

        assertEquals("t1", reply?.turnId)
        assertEquals("a1", reply?.openItemId)
        assertEquals(listOf("a1:Look"), describeItems(reply))
    }

    @Test
    fun `turn-end - shows a text whose words came before its start`() {
        val rows = listOf(turnStarted("t1"), text("t1", "a1", "Look"), itemStarted("t1", "a1"))

        assertEquals(listOf("a1:Look"), describeItems(decide(rows)))
    }

    @Test
    fun `turn-end - puts the turn's second text in the first one's place`() {
        val rows = listOf(turnStarted("t1")) + assistantText("t1", "a1", "Let me look.") + listOf(
            itemStarted("t1", "tool1", ItemKind.CommandExecution),
            itemCompleted("t1", "tool1", kind = ItemKind.CommandExecution),
            itemStarted("t1", "a2"),
            text("t1", "a2", "Found"),
        )

        val reply = decide(rows)

        assertEquals(listOf("a2:Found"), describeItems(reply))
        assertEquals("a2", reply?.openItemId)
    }

    @Test
    fun `turn-end - keeps the first text while a tool runs after it, with no open item`() {
        val rows = listOf(turnStarted("t1")) + assistantText("t1", "a1", "Let me look.") + runningTool("t1", "tool1")

        val reply = decide(rows)

        assertEquals(listOf("a1:Let me look."), describeItems(reply))
        assertNull(reply?.openItemId)
    }

    @Test
    fun `turn-end - keeps the last text after the turn ends, until its reply is stored`() {
        val rows = listOf(turnStarted("t1")) + assistantText("t1", "a1", "Done.") + turnCompleted("t1")

        val waiting = decide(rows, session = IDLE)
        assertEquals(listOf("a1:Done."), describeItems(waiting))
        assertNull(waiting?.openItemId)

        assertNull(decide(rows, listOf(reply("t1", "a1")), session = IDLE))
    }

    @Test
    fun `turn-end - hides the stored text before the turn's end arrives, and shows nothing written until it does`() {
        // A stored reply that holds one text does not end the turn: it may be a segment stored
        // before the reply mode changed to turn-end, while the turn still runs.
        val rows = listOf(turnStarted("t1")) + assistantText("t1", "a1", "Done.")
        val messages = listOf(reply("t1", "a1"))

        assertEquals(OpenReply("t1", emptyList(), null), decide(rows, messages))
        assertNull(decide(rows + turnCompleted("t1"), messages))
    }

    @Test
    fun `turn-end - shows the text being written after segments stored before the mode changed`() {
        val rows = listOf(turnStarted("t1")) + assistantText("t1", "a1", "First.") + assistantText("t1", "a2", "Second.") +
            listOf(itemStarted("t1", "a3"), text("t1", "a3", "Thi"))
        val messages = listOf(reply("t1", "a1", "First."), reply("t1", "a2", "Second."))

        val reply = decide(rows, messages)

        assertEquals(listOf("a3:Thi"), describeItems(reply))
        assertEquals("a3", reply?.openItemId)
    }

    @Test
    fun `turn-end - ignores a stored reply of another turn`() {
        val rows = listOf(turnStarted("t2")) + assistantText("t2", "a2", "Again.")

        assertEquals(listOf("a2:Again."), describeItems(decide(rows, listOf(reply("t1", "a2")))))
    }

    @Test
    fun `turn-end - shows nothing for a turn that ended with an empty last text`() {
        val rows = listOf(turnStarted("t1")) + assistantText("t1", "a1", "") + turnCompleted("t1")

        assertNull(decide(rows, session = IDLE))
    }

    @Test
    fun `turn-end - ignores the texts of the turn before the running one`() {
        val rows = listOf(turnStarted("t0")) + assistantText("t0", "a0", "Old answer.") + turnCompleted("t0") + turnStarted("t1")

        assertEquals(emptyList(), decide(rows)?.items)
    }

    @Test
    fun `turn-end - keeps the last text that holds text when a later text completes empty`() {
        val rows = listOf(turnStarted("t1")) + assistantText("t1", "a1", "Answer.") +
            listOf(itemStarted("t1", "a2"), itemCompleted("t1", "a2"))

        assertEquals(listOf("a1:Answer."), describeItems(decide(rows)))
        assertEquals(listOf("a1:Answer."), describeItems(decide(rows + turnCompleted("t1"), session = IDLE)))
    }

    @Test
    fun `turn-end - shows the text whose first text row came last, as the controller stores it`() {
        val rows = listOf(
            turnStarted("t1"),
            itemStarted("t1", "a1"),
            itemStarted("t1", "a2"),
            text("t1", "a2", "Second."),
            itemCompleted("t1", "a2"),
            text("t1", "a1", "First."),
            itemCompleted("t1", "a1"),
            turnCompleted("t1"),
        )

        assertEquals(listOf("a1:First."), describeItems(decide(rows, session = IDLE)))
    }

    @Test
    fun `turn-end - skips text rows that name another turn`() {
        val rows = listOf(turnStarted("t1"), itemStarted("t1", "a1"), text("t1", "a1", "Mine."), text("t0", "a1", " Not mine."))

        assertEquals(listOf("a1:Mine."), describeItems(decide(rows)))
    }

    @Test
    fun `turn-end - shows every text that holds text after a failed turn, as the controller joins them`() {
        val rows = listOf(turnStarted("t1")) + assistantText("t1", "a1", "First.") + assistantText("t1", "a2", "") +
            listOf(itemStarted("t1", "a3"), text("t1", "a3", "Half"), turnCompleted("t1", TurnState.Failed))

        val reply = decide(rows, session = IDLE)

        assertEquals(listOf("a1:First.", "a3:Half"), describeItems(reply))
        assertNull(reply?.openItemId)
    }

    @Test
    fun `turn-end - shows nothing once the joined reply of a stopped turn is stored`() {
        val rows = listOf(turnStarted("t1")) + assistantText("t1", "a1", "First.") +
            listOf(itemStarted("t1", "a2"), text("t1", "a2", "Half"), turnCompleted("t1", TurnState.Interrupted))
        val messages = listOf(reply("t1", null, "First.\n\nHalf"))

        assertNull(decide(rows, messages))
        assertNull(decide(rows, messages, session = IDLE))
    }

    @Test
    fun `turn-end - hides a segment stored before the mode changed, and the rest once the stopped turn's joined reply is stored`() {
        val rows = listOf(turnStarted("t1")) + assistantText("t1", "a1", "First.") +
            listOf(itemStarted("t1", "a2"), text("t1", "a2", "Half"), turnCompleted("t1", TurnState.Interrupted))
        val segment = reply("t1", "a1", "First.")

        assertEquals(listOf("a2:Half"), describeItems(decide(rows, listOf(segment), session = IDLE)))
        assertNull(decide(rows, listOf(segment, reply("t1", null, "Half")), session = IDLE))
    }

    @Test
    fun `turn-end - shows nothing for a stopped turn whose every text was stored before the mode changed`() {
        val rows = listOf(turnStarted("t1")) + assistantText("t1", "a1", "First.") + turnCompleted("t1", TurnState.Interrupted)

        assertNull(decide(rows, listOf(reply("t1", "a1", "First.")), session = IDLE))
    }

    @Test
    fun `turn-end - ends the turn at its joined reply, even before the turn's end arrives`() {
        val rows = listOf(turnStarted("t1"), itemStarted("t1", "a1"), text("t1", "a1", "Half"))

        assertNull(decide(rows, listOf(reply("t1", null, "Half"))))
    }

    @Test
    fun `turn-end - shows nothing under the notice when the session exited mid-turn`() {
        val rows = listOf(turnStarted("t1"), itemStarted("t1", "a1"), text("t1", "a1", "Half"), sessionExited())

        assertNull(decide(rows))
        assertNull(decide(rows, session = IDLE))
    }

    @Test
    fun `turn-end - shows nothing when the session started again mid-turn`() {
        val rows = listOf(turnStarted("t1")) + assistantText("t1", "a1", "Lost.") + sessionStarted()

        assertNull(decide(rows))
    }

    // In segments mode.

    @Test
    fun `segments - shows the texts after the ones already stored`() {
        val rows = listOf(turnStarted("t1")) + assistantText("t1", "a1", "First.") + assistantText("t1", "a2", "Second.")

        assertEquals(listOf("a2:Second."), describeItems(decide(rows, listOf(reply("t1", "a1")), mode = SEGMENTS)))
    }

    @Test
    fun `segments - shows every text not stored yet, the one being written last`() {
        val rows = listOf(turnStarted("t1")) + assistantText("t1", "a1", "First.") + listOf(itemStarted("t1", "a2"), text("t1", "a2", "Sec"))

        val reply = decide(rows, mode = SEGMENTS)

        assertEquals(listOf("a1:First.", "a2:Sec"), describeItems(reply))
        assertEquals("a2", reply?.openItemId)
    }

    @Test
    fun `segments - hides the texts that completed before a stored one, as the controller stored them first`() {
        val rows = listOf(
            turnStarted("t1"),
            itemStarted("t1", "a1"),
            text("t1", "a1", "First."),
            itemStarted("t1", "a2"),
            text("t1", "a2", "Second."),
            itemCompleted("t1", "a2"),
            itemCompleted("t1", "a1"),
        )

        assertEquals(listOf("a1:First."), describeItems(decide(rows, listOf(reply("t1", "a2")), mode = SEGMENTS)))
        // a1 completed after a2, so a stored a1 means a2 was stored before it.
        assertEquals(emptyList(), decide(rows, listOf(reply("t1", "a1")), mode = SEGMENTS)?.items)
    }

    @Test
    fun `segments - shows no text of a turn whose first replies are on a page not read yet`() {
        val texts = (1..51).map { "a$it" }
        val rows = listOf(turnStarted("t1")) + texts.flatMap { assistantText("t1", it, "Text $it.") }
        val messages = texts.drop(1).map { reply("t1", it, "Text $it.") }

        assertEquals(emptyList(), decide(rows, messages, mode = SEGMENTS)?.items)
        assertNull(decide(rows + turnCompleted("t1"), messages, session = IDLE, mode = SEGMENTS))
    }

    @Test
    fun `segments - never shows a text the controller will not store`() {
        val rows = listOf(
            turnStarted("t1"),
            itemStarted("t1", "a1"),
            text("t1", "a1", "Half"),
            itemCompleted("t1", "a1", ItemStatus.Failed),
        ) + assistantText("t1", "a2", "") + assistantText("t1", "a3", "Third.")

        assertEquals(listOf("a3:Third."), describeItems(decide(rows, mode = SEGMENTS)))
    }

    @Test
    fun `segments - drops a text the turn's end cut off, which is never stored`() {
        val rows = listOf(turnStarted("t1")) + assistantText("t1", "a1", "First.") +
            listOf(itemStarted("t1", "a2"), text("t1", "a2", "Cut"), turnCompleted("t1", TurnState.Interrupted))

        assertNull(decide(rows, listOf(reply("t1", "a1")), session = IDLE, mode = SEGMENTS))
    }

    @Test
    fun `segments - skips text rows before the text's start, as the controller does`() {
        val rows = listOf(
            turnStarted("t1"),
            text("t1", "a1", "Early "),
            itemStarted("t1", "a1"),
            text("t1", "a1", "Late."),
            itemCompleted("t1", "a1"),
        )

        assertEquals(listOf("a1:Late."), describeItems(decide(rows, mode = SEGMENTS)))
    }

    @Test
    fun `segments - never shows a text with no start, which the controller never stores`() {
        val rows = listOf(turnStarted("t1"), text("t1", "a1", "Orphan."), itemCompleted("t1", "a1"))

        assertEquals(emptyList(), decide(rows, mode = SEGMENTS)?.items)
    }

    @Test
    fun `segments - shows nothing under the notice when the session exited mid-text`() {
        val rows = listOf(turnStarted("t1")) + assistantText("t1", "a1", "Stored.") +
            listOf(itemStarted("t1", "a2"), text("t1", "a2", "Half"), sessionExited())

        assertNull(decide(rows, listOf(reply("t1", "a1", "Stored.")), mode = SEGMENTS))
    }

    @Test
    fun `segments - shows no text once every text is stored and the turn still runs`() {
        val rows = listOf(turnStarted("t1")) + assistantText("t1", "a1", "First.") + runningTool("t1", "tool1")

        assertEquals(OpenReply("t1", emptyList(), null), decide(rows, listOf(reply("t1", "a1")), mode = SEGMENTS))
    }

    // With no text to show.

    @Test
    fun `shows a reply with no text while the session is busy and the turn has no text yet`() {
        assertEquals(OpenReply("t1", emptyList(), null), decide(listOf(turnStarted("t1"), runningTool("t1", "tool1"))))
    }

    @Test
    fun `shows a reply with no text before the running turn's first row arrives`() {
        assertEquals(OpenReply(null, emptyList(), null), decide())
    }

    @Test
    fun `shows nothing when the session is not busy and nothing is left to show`() {
        assertNull(decide(session = IDLE))
        assertNull(decide(session = null))
    }

    @Test
    fun `shows nothing for a turn that ended with no text, while the session still reads busy`() {
        assertNull(decide(listOf(turnStarted("t1"), turnCompleted("t1"))))
    }

    // After the owner sends the next message.

    @Test
    fun `next message - shows a reply with no text for the next turn once the last turn completed (turn-end)`() {
        val rows = listOf(turnStarted("t1")) + assistantText("t1", "a1", "Done.") + turnCompleted("t1")
        val messages = listOf(owner(), reply("t1", "a1", "Done."), owner(createdAt = LATER))

        assertEquals(NEXT_TURN, decide(rows, messages))
    }

    @Test
    fun `next message - shows a reply with no text when the joined reply ended the turn before its end row`() {
        val rows = listOf(turnStarted("t1"), itemStarted("t1", "a1"), text("t1", "a1", "Half"))
        val messages = listOf(owner(), reply("t1", null, "Half"), owner())

        assertEquals(NEXT_TURN, decide(rows, messages))
    }

    @Test
    fun `next message - stays on the running turn when a single-text reply arrived before the end row`() {
        val rows = listOf(turnStarted("t1")) + assistantText("t1", "a1", "Done.")
        val messages = listOf(owner(), reply("t1", "a1", "Done."), owner())

        assertEquals(OpenReply("t1", emptyList(), null), decide(rows, messages))
    }

    @Test
    fun `next message - shows a reply with no text for the next turn once the last turn completed (segments)`() {
        val rows = listOf(turnStarted("t1")) + assistantText("t1", "a1", "Done.") + turnCompleted("t1")
        val messages = listOf(reply("t1", "a1", "Done."), owner(createdAt = LATER))

        assertEquals(NEXT_TURN, decide(rows, messages, mode = SEGMENTS))
    }

    @Test
    fun `next message - stands for the next turn rather than the ended turn's text not stored yet`() {
        val rows = listOf(turnStarted("t1")) + assistantText("t1", "a1", "Done.") + turnCompleted("t1")

        assertEquals(NEXT_TURN, decide(rows, listOf(owner(createdAt = LATER)), mode = SEGMENTS))
    }

    @Test
    fun `next message - shows nothing for an owner message sent before the turn ended, while busy reads stale`() {
        val rows = listOf(turnStarted("t1")) + assistantText("t1", "a1", "Done.") + turnCompleted("t1")
        val messages = listOf(owner(), reply("t1", "a1", "Done."))

        assertNull(decide(rows, messages))
        assertNull(decide(rows, messages, mode = SEGMENTS))
    }

    @Test
    fun `next message - shows nothing for an owner message after the end while the session is not busy`() {
        val rows = listOf(turnStarted("t1"), turnCompleted("t1"))

        assertNull(decide(rows, listOf(owner(createdAt = LATER)), session = IDLE))
    }

    // The text the screen draws.

    @Test
    fun `the text puts the tail after the item being written, and a blank line between items`() {
        val reply = OpenReply("t1", listOf(OpenReplyItem("a1", "First."), OpenReplyItem("a2", "Sec")), openItemId = "a2")

        assertEquals("First.\n\nSecond.", buildOpenReplyText(reply, mapOf("a2" to "ond.")))
    }

    @Test
    fun `the text is the tail alone while no row holds the item's words`() {
        val reply = OpenReply("t1", listOf(OpenReplyItem("a1", "")), openItemId = "a1")

        assertEquals("Hel", buildOpenReplyText(reply, mapOf("a1" to "Hel")))
    }

    @Test
    fun `there is no text while the reply holds none`() {
        assertNull(buildOpenReplyText(OpenReply("t1", listOf(OpenReplyItem("a1", "")), openItemId = "a1"), emptyMap()))
        assertNull(buildOpenReplyText(OpenReply(null, emptyList(), null), emptyMap()))
        assertNull(buildOpenReplyText(null, emptyMap()))
    }

    private companion object {
        const val TODAY = "2026-10-07T09:00:00Z"
        const val LATER = "2026-10-07T09:10:00Z"
        val BUSY = buildSession(id = "s1", status = SessionStatus.Busy, conversationId = "c1")
        val IDLE = buildSession(id = "s1", status = SessionStatus.Idle, conversationId = "c1")
        val SEGMENTS = AssistantReply.Segments
        val NEXT_TURN = OpenReply(turnId = null, items = emptyList(), openItemId = null)
    }
}
