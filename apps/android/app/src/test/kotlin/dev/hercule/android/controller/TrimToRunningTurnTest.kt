package dev.hercule.android.controller

import dev.hercule.android.wire.ItemKind
import dev.hercule.android.wire.ItemStatus
import dev.hercule.android.wire.ProviderEvent
import dev.hercule.android.wire.StreamKind
import dev.hercule.android.wire.TranscriptRow
import dev.hercule.android.wire.TurnState
import kotlin.test.assertEquals
import kotlin.test.assertSame
import org.junit.Test

/**
 * Tests [trimToRunningTurn]. The cases are copied one for one from the `trimToRunningTurn` cases
 * in packages/client-core/src/assistants/conversation-blocks.test.ts.
 */
class TrimToRunningTurnTest {
    private var position = 0L

    private fun buildRow(event: ProviderEvent) = TranscriptRow(++position, "2026-10-07T09:00:00.000Z", event)

    private fun buildTurnStarted(turnId: String) = buildRow(ProviderEvent.TurnStarted(turnId = turnId))

    private fun buildTurnCompleted(turnId: String) =
        buildRow(ProviderEvent.TurnCompleted(turnId = turnId, state = TurnState.Completed))

    private fun buildItemStarted(turnId: String, itemId: String) =
        buildRow(ProviderEvent.ItemStarted(turnId = turnId, itemId = itemId, kind = ItemKind.AssistantMessage))

    private fun buildItemCompleted(turnId: String, itemId: String) = buildRow(
        ProviderEvent.ItemCompleted(turnId = turnId, itemId = itemId, kind = ItemKind.AssistantMessage, status = ItemStatus.Completed),
    )

    private fun buildTextDelta(turnId: String, itemId: String, delta: String) =
        buildRow(ProviderEvent.ContentDelta(turnId = turnId, itemId = itemId, streamKind = StreamKind.AssistantText, delta = delta))

    /** Returns the rows of a whole assistant text: its start, its words, and its end. */
    private fun buildAssistantText(turnId: String, itemId: String, text: String) =
        listOf(buildItemStarted(turnId, itemId), buildTextDelta(turnId, itemId, text), buildItemCompleted(turnId, itemId))

    @Test
    fun `drops the rows before the newest turn started`() {
        val older = listOf(buildTurnStarted("t0")) + buildAssistantText("t0", "a0", "old")
        val ended = buildTurnCompleted("t0")
        val running = listOf(buildTurnStarted("t1"), buildItemStarted("t1", "a1"))

        assertEquals(running, trimToRunningTurn(older + ended + running))
    }

    @Test
    fun `returns the rows themselves when they start with the newest turn started`() {
        val rows = listOf(buildTurnStarted("t1"), buildItemStarted("t1", "a1"))

        assertSame(rows, trimToRunningTurn(rows))
    }

    @Test
    fun `returns the rows themselves when they hold no turn started`() {
        val rows = listOf(buildItemStarted("t1", "a1"), buildTextDelta("t1", "a1", "hi"))

        assertSame(rows, trimToRunningTurn(rows))
    }
}
