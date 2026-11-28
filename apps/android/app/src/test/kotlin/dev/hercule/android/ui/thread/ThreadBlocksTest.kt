package dev.hercule.android.ui.thread

import dev.hercule.android.ui.fixtures.buildBookThreadState
import dev.hercule.android.wire.ExitReason
import dev.hercule.android.wire.ItemKind
import dev.hercule.android.wire.ItemStatus
import dev.hercule.android.wire.HarnessEvent
import dev.hercule.android.wire.Question
import dev.hercule.android.wire.QuestionOption
import dev.hercule.android.wire.QuestionRequest
import dev.hercule.android.wire.StreamKind
import dev.hercule.android.wire.TranscriptRow
import dev.hercule.android.wire.TurnState
import kotlin.test.assertEquals
import kotlin.test.assertSame
import kotlin.time.Duration.Companion.hours
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.Duration.Companion.minutes
import kotlin.time.Duration.Companion.seconds
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Test

/**
 * Tests [buildThreadBlocks] and [ThreadBlockBuilder] on the book's Fix thread and on items whose detail is missing, and
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
            HarnessEvent.TurnStarted(turnId = "t", model = null),
            HarnessEvent.ItemStarted(turnId = "t", itemId = "a", kind = ItemKind.CommandExecution, detail = null),
            HarnessEvent.ItemStarted(turnId = "t", itemId = "b", kind = ItemKind("a_kind_from_the_future"), detail = buildJsonObject { put("other", 1) }),
            HarnessEvent.ItemStarted(turnId = "t", itemId = "c", kind = ItemKind.FileRead, detail = buildJsonObject { put("paths", 3) }),
        ).mapIndexed { index, event -> TranscriptRow(index + 1L, at, event) }

        val work = buildThreadBlocks(rows, emptyList()).single() as WorkBlock

        assertEquals(listOf("", "", ""), work.items.map { it.target })
        assertEquals(listOf<ItemStatus?>(null, null, null), work.items.map { it.status })
        assertEquals(listOf("ran 1 command", "did 1 other step", "read 1 file"), summarizeWork(work.items))
    }

    @Test
    fun `skips a row whose time does not parse and keeps the rest`() {
        val rows = listOf(
            TranscriptRow(1, "2026-09-29T09:00:00Z", HarnessEvent.TurnStarted(turnId = "t", model = null)),
            TranscriptRow(2, "not-a-date", HarnessEvent.ItemStarted(turnId = "t", itemId = "a", kind = ItemKind.FileRead, detail = null)),
            TranscriptRow(3, "2026-09-29T09:00:01Z", HarnessEvent.ItemStarted(turnId = "t", itemId = "b", kind = ItemKind.CommandExecution, detail = null)),
        )

        val work = buildThreadBlocks(rows, emptyList()).single() as WorkBlock

        assertEquals(listOf("ran 1 command"), summarizeWork(work.items))
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

    @Test
    fun `marks an agent message open while it is the open item of the running turn`() {
        val writing = listOf(
            HarnessEvent.TurnStarted(turnId = "t", model = null),
            HarnessEvent.ItemStarted(turnId = "t", itemId = "m", kind = ItemKind.AssistantMessage),
            HarnessEvent.ContentDelta(turnId = "t", itemId = "m", streamKind = StreamKind.AssistantText, delta = "Hello"),
        )
        val completed = HarnessEvent.ItemCompleted(turnId = "t", itemId = "m", kind = ItemKind.AssistantMessage, status = ItemStatus.Completed)

        assertEquals(listOf(true), readOpen(writing))
        assertEquals(listOf(false), readOpen(writing + completed))
        // A message whose end never arrived is not open once its turn has ended, however it ended.
        assertEquals(listOf(false), readOpen(writing + HarnessEvent.TurnCompleted(turnId = "t", state = TurnState.Interrupted)))
        assertEquals(listOf(false), readOpen(writing + HarnessEvent.SessionExited(ExitReason.ProcessExit)))
        assertEquals(listOf(false), readOpen(writing + HarnessEvent.SessionStarted))
        assertEquals(listOf(false), readOpen(writing + HarnessEvent.TurnStarted(turnId = "t2", model = null)))
    }

    @Test
    fun `keeps an open agent message with no text yet, and drops one that ended with none`() {
        val started = listOf(
            HarnessEvent.TurnStarted(turnId = "t", model = null),
            HarnessEvent.ItemStarted(turnId = "t", itemId = "m", kind = ItemKind.AssistantMessage),
        )
        val completed = HarnessEvent.ItemCompleted(turnId = "t", itemId = "m", kind = ItemKind.AssistantMessage, status = ItemStatus.Completed)

        assertEquals(listOf(true), readOpen(started))
        assertEquals(emptyList(), readOpen(started + completed))
    }

    @Test
    fun `keeps an ended agent message whose text is only spaces, as client-core does`() {
        val rows = listOf(
            HarnessEvent.TurnStarted(turnId = "t", model = null),
            HarnessEvent.ItemStarted(turnId = "t", itemId = "m", kind = ItemKind.AssistantMessage),
            HarnessEvent.ContentDelta(turnId = "t", itemId = "m", streamKind = StreamKind.AssistantText, delta = " "),
            HarnessEvent.ItemCompleted(turnId = "t", itemId = "m", kind = ItemKind.AssistantMessage, status = ItemStatus.Completed),
        )

        assertEquals(listOf(false), readOpen(rows))
    }

    @Test
    fun `names the session whose agent sent a message, and none for the user's own`() {
        val rows = listOf(
            HarnessEvent.TurnStarted(turnId = "t", model = null),
            HarnessEvent.ItemStarted(turnId = "t", itemId = "a", kind = ItemKind.UserMessage, detail = buildJsonObject { put("text", "From the user") }),
            HarnessEvent.ItemStarted(
                turnId = "t",
                itemId = "b",
                kind = ItemKind.UserMessage,
                detail = buildJsonObject {
                    put("text", "From an agent")
                    put("senderSessionId", "s-runbook")
                },
            ),
        )

        val senders = buildThreadBlocks(toRows(rows), emptyList()).filterIsInstance<UserBlock>().map { it.senderSessionId }

        assertEquals(listOf(null, "s-runbook"), senders)
    }

    @Test
    fun `builds the same blocks as a full build, token by token, and keeps every block a token did not change`() {
        val events = mutableListOf<HarnessEvent>(
            HarnessEvent.TurnStarted(turnId = "t", model = null),
            HarnessEvent.ItemStarted(turnId = "t", itemId = "u", kind = ItemKind.UserMessage, detail = buildJsonObject { put("text", "Write it") }),
            HarnessEvent.ItemStarted(turnId = "t", itemId = "m1", kind = ItemKind.AssistantMessage),
            HarnessEvent.ContentDelta(turnId = "t", itemId = "m1", streamKind = StreamKind.AssistantText, delta = "First message."),
            HarnessEvent.ItemCompleted(turnId = "t", itemId = "m1", kind = ItemKind.AssistantMessage, status = ItemStatus.Completed),
            HarnessEvent.ItemStarted(turnId = "t", itemId = "c", kind = ItemKind.CommandExecution),
            HarnessEvent.ItemStarted(turnId = "t", itemId = "m2", kind = ItemKind.AssistantMessage),
        )
        val builder = ThreadBlockBuilder()
        var rows = toRows(events)
        var tail = ""
        var before = builder.build(rows, emptyList(), emptyMap())
        val reply = (1..60).joinToString(" ") { "word$it" }
        for ((index, token) in reply.chunked(5).withIndex()) {
            tail += token
            // Every 20 tokens a row stores the tail, as the controller stores it every 4 KB.
            if (index % 20 == 19) {
                events += HarnessEvent.ContentDelta(turnId = "t", itemId = "m2", streamKind = StreamKind.AssistantText, delta = tail)
                rows = toRows(events)
                tail = ""
            }
            val tails = if (tail.isEmpty()) emptyMap() else mapOf("m2" to tail)
            val blocks = builder.build(rows, emptyList(), tails)

            assertEquals(buildThreadBlocks(rows, emptyList(), tails), blocks)
            // Every block but the message being written is the instance built before.
            blocks.zip(before).filter { (block, _) -> block.key != "m2" }.forEach { (block, old) -> assertSame(old, block) }
            before = blocks
        }
    }

    @Test
    fun `draws a tail of an ended message that the rows alone draw no block for`() {
        val events = listOf(
            HarnessEvent.TurnStarted(turnId = "t", model = null),
            HarnessEvent.ItemStarted(turnId = "t", itemId = "m", kind = ItemKind.AssistantMessage),
            HarnessEvent.ItemStarted(turnId = "t", itemId = "c", kind = ItemKind.CommandExecution),
        )
        val tails = mapOf("m" to "Streamed before the command")

        assertEquals(buildThreadBlocks(toRows(events), emptyList(), tails), ThreadBlockBuilder().build(toRows(events), emptyList(), tails))
    }

    @Test
    fun `an async question adds no waiting note and does not end the work stretch, a blocking one does`() {
        fun buildBlocks(async: Boolean?): List<ThreadBlock> {
            val request = QuestionRequest(
                "rq",
                "it-question",
                QuestionRequest.Detail(listOf(Question("Which storage?", "Question", listOf(QuestionOption("Local")), multiSelect = false))),
                async = async,
            )
            val events = listOf(
                HarnessEvent.TurnStarted(turnId = "t", model = null),
                HarnessEvent.ItemStarted(turnId = "t", itemId = "a", kind = ItemKind.CommandExecution),
                HarnessEvent.RequestOpened(request = request),
                HarnessEvent.ItemStarted(turnId = "t", itemId = "b", kind = ItemKind.FileRead),
            )
            return buildThreadBlocks(toRows(events), listOf(request))
        }

        val async = buildBlocks(async = true)
        assertEquals(listOf(listOf("a", "b")), async.map { block -> (block as WorkBlock).items.map { it.itemId } })
        assertEquals(null, (async.single() as WorkBlock).endedAt)

        val blocking = buildBlocks(async = null)
        assertEquals(listOf("WorkBlock", "WaitingBlock", "WorkBlock"), blocking.map { it::class.simpleName })
    }

    @Test
    fun `builds a notice for a runtime notice and for an event this build does not know`() {
        val canonical = buildJsonObject {
            put("_tag", "unknown")
            put("originalType", "some.future.event")
        }
        val raw = buildJsonObject { put("_tag", "another.future.event") }
        val ofSubagent = buildJsonObject {
            put("_tag", "unknown")
            put("originalType", "some.future.event")
            put("subagentId", "a1")
        }
        val blocks = buildThreadBlocks(
            toRows(
                listOf(
                    HarnessEvent.RuntimeNotice(message = "Conversation was cleared"),
                    HarnessEvent.Unknown(canonical),
                    HarnessEvent.Unknown(raw),
                    HarnessEvent.Unknown(ofSubagent),
                    HarnessEvent.RuntimeNotice(subagentId = "a1", message = "Of a subagent"),
                ),
            ),
            emptyList(),
        )
        assertEquals(
            listOf("Conversation was cleared", "Unknown event: some.future.event", "Unknown event: another.future.event"),
            blocks.map { (it as NoticeBlock).message },
        )
    }

    @Test
    fun `builds an error with its message, or with its class when it has none`() {
        val blocks = buildThreadBlocks(
            toRows(
                listOf(
                    HarnessEvent.RuntimeError(errorClass = "rate_limit", message = "Too many requests"),
                    HarnessEvent.RuntimeError(errorClass = "rate_limit"),
                ),
            ),
            emptyList(),
        )
        assertEquals(listOf("Too many requests", "rate_limit"), blocks.map { (it as ErrorBlock).message })
    }

    /** Returns whether each agent message the transcript of [events] holds is open. */
    private fun readOpen(events: List<HarnessEvent>): List<Boolean> =
        buildThreadBlocks(toRows(events), emptyList()).filterIsInstance<AgentBlock>().map { it.open }

    private fun toRows(events: List<HarnessEvent>) = events.mapIndexed { index, event -> TranscriptRow(index + 1L, "2026-09-29T09:00:0${index % 10}Z", event) }

    private var itemSeq = 0

    /** Builds a completed item of [kind] that names [paths], as a file change or a file read does. */
    private fun buildItem(kind: ItemKind, vararg paths: String) =
        WorkItem("i${itemSeq++}", kind, "", false, paths.toList(), ItemStatus.Completed)
}
