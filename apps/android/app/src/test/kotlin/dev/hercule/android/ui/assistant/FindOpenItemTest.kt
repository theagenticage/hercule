package dev.hercule.android.ui.assistant

import dev.hercule.android.wire.ItemKind
import dev.hercule.android.wire.ItemStatus
import dev.hercule.android.wire.ProviderEvent
import dev.hercule.android.wire.TranscriptRow
import kotlin.test.assertEquals
import kotlin.test.assertNull
import org.junit.Test

/**
 * Tests [findOpenItem], which finds the item still in progress, if any: the last `item.started`
 * with no matching `item.completed`. The cases are copied one for one from
 * packages/client-core/src/threads/open-item.test.ts.
 */
class FindOpenItemTest {
    private var position = 0L

    private fun buildRow(event: ProviderEvent) = TranscriptRow(++position, "2026-09-08T10:00:00.000Z", event)

    private fun buildStartedRow(itemId: String, kind: ItemKind) =
        buildRow(ProviderEvent.ItemStarted(turnId = "t1", itemId = itemId, kind = kind))

    private fun buildCompletedRow(itemId: String, kind: ItemKind) =
        buildRow(ProviderEvent.ItemCompleted(turnId = "t1", itemId = itemId, kind = kind, status = ItemStatus.Completed))

    @Test
    fun `returns null when there are no rows, or every item has completed`() {
        assertNull(findOpenItem(emptyList()))
        assertNull(findOpenItem(listOf(buildStartedRow("i1", ItemKind.ToolCall), buildCompletedRow("i1", ItemKind.ToolCall))))
    }

    @Test
    fun `returns the item whose item started has no item completed yet`() {
        val rows = listOf(buildStartedRow("i1", ItemKind.AssistantMessage), buildStartedRow("i2", ItemKind.ToolCall))

        assertEquals("i2", findOpenItem(rows))
    }

    @Test
    fun `ignores a user message - it is complete the moment it is sent`() {
        assertNull(findOpenItem(listOf(buildStartedRow("u1", ItemKind.UserMessage))))
    }

    @Test
    fun `falls back to an earlier still-open item once the most recent one completes`() {
        val rows = listOf(
            buildStartedRow("i1", ItemKind.ToolCall),
            buildStartedRow("i2", ItemKind.ToolCall),
            buildCompletedRow("i2", ItemKind.ToolCall),
        )

        assertEquals("i1", findOpenItem(rows))
    }
}
