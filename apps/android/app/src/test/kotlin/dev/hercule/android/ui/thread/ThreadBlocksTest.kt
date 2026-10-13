package dev.hercule.android.ui.thread

import dev.hercule.android.ui.fixtures.buildBookThreadState
import dev.hercule.android.wire.ItemKind
import dev.hercule.android.wire.ItemStatus
import dev.hercule.android.wire.ProviderEvent
import dev.hercule.android.wire.TranscriptRow
import kotlin.test.assertEquals
import kotlin.time.Duration.Companion.hours
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.Duration.Companion.minutes
import kotlin.time.Duration.Companion.seconds
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Test

/**
 * Tests [buildThreadBlocks] on the book's Fix thread and on items whose detail is missing, and
 * the divider's words. The [summarizeWork] and [formatDuration] cases are ported from
 * packages/client-core/src/threads/work-summary.test.ts and duration.test.ts.
 */
class ThreadBlocksTest {
    @Test
    fun `builds the Fix thread as the book draws it`() {
        val blocks = buildBookThreadState().blocks

        val shapes = blocks.map { block ->
            when (block) {
                is UserBlock -> "user"
                is AgentBlock -> "agent"
                is WaitingBlock -> "waiting ${block.requestId}"
                is WorkBlock -> "work ${summarizeWork(block.items).joinToString(", ")} in " +
                    formatDuration(block.endedAt!! - block.startedAt)
                else -> block.toString()
            }
        }
        assertEquals(
            listOf(
                "user",
                "work read 6 files, ran 1 command in 2m 14s",
                "agent",
                "work edited 3 files, ran 1 command in 4m 51s",
                "agent",
                "waiting rq-fix-push",
            ),
            shapes,
        )
    }

    @Test
    fun `builds a work item with an empty target when the detail is missing or the kind is unknown`() {
        val at = "2026-09-29T09:00:00Z"
        val rows = listOf(
            ProviderEvent.TurnStarted(turnId = "t", model = null),
            ProviderEvent.ItemStarted(turnId = "t", itemId = "a", kind = ItemKind.CommandExecution, detail = null),
            ProviderEvent.ItemStarted(turnId = "t", itemId = "b", kind = ItemKind("a_kind_from_the_future"), detail = buildJsonObject { put("other", 1) }),
            ProviderEvent.ItemStarted(turnId = "t", itemId = "c", kind = ItemKind.FileRead, detail = buildJsonObject { put("paths", 3) }),
        ).mapIndexed { index, event -> TranscriptRow(index + 1L, at, event) }

        val work = buildThreadBlocks(rows, emptyList()).single() as WorkBlock

        assertEquals(listOf("", "", ""), work.items.map { it.target })
        assertEquals(listOf<ItemStatus?>(null, null, null), work.items.map { it.status })
        assertEquals(listOf("ran 1 command", "did 1 other step", "read 1 file"), summarizeWork(work.items))
    }

    @Test
    fun `counts each kind of item, in the words of the divider`() {
        val cases = listOf(
            Triple(ItemKind.CommandExecution, 1, "ran 1 command"),
            Triple(ItemKind.CommandExecution, 2, "ran 2 commands"),
            Triple(ItemKind.FileChange, 1, "edited 1 file"),
            Triple(ItemKind.FileChange, 3, "edited 3 files"),
            Triple(ItemKind.FileRead, 1, "read 1 file"),
            Triple(ItemKind.FileRead, 6, "read 6 files"),
            Triple(ItemKind.FileSearch, 1, "searched once"),
            Triple(ItemKind.FileSearch, 3, "searched 3 times"),
            Triple(ItemKind.WebSearch, 1, "searched the web"),
            Triple(ItemKind.WebSearch, 2, "searched the web 2 times"),
            Triple(ItemKind.ToolCall, 1, "used 1 tool"),
            Triple(ItemKind.ToolCall, 6, "used 6 tools"),
            Triple(ItemKind.Subagent, 1, "ran 1 subagent"),
            Triple(ItemKind.Subagent, 2, "ran 2 subagents"),
            Triple(ItemKind.Plan, 1, "made a plan"),
            Triple(ItemKind.Plan, 2, "made 2 plans"),
            Triple(ItemKind.ContextCompaction, 1, "compacted the context"),
            Triple(ItemKind.ContextCompaction, 2, "compacted the context 2 times"),
            Triple(ItemKind.Error, 1, "hit 1 error"),
            Triple(ItemKind.Error, 2, "hit 2 errors"),
            Triple(ItemKind.Unknown, 1, "did 1 other step"),
            Triple(ItemKind.Unknown, 2, "did 2 other steps"),
        )
        cases.forEach { (kind, count, phrase) ->
            assertEquals(listOf(phrase), summarizeWork(List(count) { buildItem(kind) }), "$count ${kind.wire}")
        }
    }

    @Test
    fun `lists the kinds in the order each first appears, and leaves reasoning out`() {
        val items = listOf(
            buildItem(ItemKind.ToolCall),
            buildItem(ItemKind.Reasoning),
            buildItem(ItemKind.CommandExecution),
            buildItem(ItemKind.ToolCall),
            buildItem(ItemKind.FileChange, "a.ts"),
            buildItem(ItemKind.CommandExecution),
        )

        assertEquals(listOf("used 2 tools", "ran 2 commands", "edited 1 file"), summarizeWork(items))
    }

    @Test
    fun `counts distinct files, and each change that names none`() {
        val items = listOf(
            buildItem(ItemKind.FileChange, "a.ts", "b.ts"),
            buildItem(ItemKind.FileChange, "a.ts"),
            buildItem(ItemKind.FileChange),
            buildItem(ItemKind.FileChange, "c.ts"),
            buildItem(ItemKind.FileRead, "a.ts"),
            buildItem(ItemKind.FileRead, "a.ts"),
            buildItem(ItemKind.FileRead, "d.ts"),
        )

        assertEquals(listOf("edited 4 files", "read 2 files"), summarizeWork(items))
    }

    @Test
    fun `formats a duration as seconds, minutes and seconds, or hours and minutes`() {
        assertEquals("31s", formatDuration(31.seconds))
        assertEquals("0s", formatDuration(0.seconds))
        assertEquals("0s", formatDuration((-5).seconds))
        assertEquals("12m 4s", formatDuration(12.minutes + 4.seconds))
        assertEquals("1m 0s", formatDuration(1.minutes))
        assertEquals("1h 4m", formatDuration(1.hours + 4.minutes + 9.seconds))
        assertEquals("59m 59s", formatDuration(3_599_499.milliseconds))
        assertEquals("1h 0m", formatDuration(3_599_500.milliseconds))
    }

    private var itemSeq = 0

    /** Builds a completed item of [kind] that names [paths], as a file change or a file read does. */
    private fun buildItem(kind: ItemKind, vararg paths: String) =
        WorkItem("i${itemSeq++}", kind, "", false, paths.toList(), ItemStatus.Completed)
}
