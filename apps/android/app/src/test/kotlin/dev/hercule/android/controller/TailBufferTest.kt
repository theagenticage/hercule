package dev.hercule.android.controller

import dev.hercule.android.wire.ItemKind
import dev.hercule.android.wire.ItemStatus
import dev.hercule.android.wire.ProviderEvent
import dev.hercule.android.wire.StreamKind
import dev.hercule.android.wire.TapItem
import dev.hercule.android.wire.TranscriptRow
import kotlin.test.assertEquals
import org.junit.Test

/**
 * Tests [TailBuffer]: taps build an item's tail, stream rows remove the text they hold from
 * its front, and an item that may have missed a tap is skipped until it completes. The cases
 * are those of `packages/client-core/src/threads/tail-buffer.test.ts`, so both stay in step.
 */
class TailBufferTest {
    private var position = 0L

    private fun buildTap(itemId: String, delta: String, streamKind: StreamKind = StreamKind.AssistantText) =
        TapItem(turnId = "t1", itemId = itemId, streamKind = streamKind, delta = delta)

    private fun buildRow(event: ProviderEvent) = TranscriptRow(++position, "2026-09-30T09:00:00.000Z", event)

    private fun buildTextRow(itemId: String, delta: String) =
        buildRow(ProviderEvent.ContentDelta(turnId = "t1", itemId = itemId, streamKind = StreamKind.AssistantText, delta = delta))

    private fun buildItemStarted(itemId: String) =
        buildRow(ProviderEvent.ItemStarted(turnId = "t1", itemId = itemId, kind = ItemKind.AssistantMessage))

    private fun buildItemCompleted(itemId: String) = buildRow(
        ProviderEvent.ItemCompleted(turnId = "t1", itemId = itemId, kind = ItemKind.AssistantMessage, status = ItemStatus.Completed),
    )

    @Test
    fun `appends an item's assistant text taps to its tail, one tail per item`() {
        val tails = TailBuffer()

        tails.appendTap(buildTap("a1", "Hel"))
        tails.appendTap(buildTap("a2", "Other"))
        tails.appendTap(buildTap("a1", "lo"))

        assertEquals(mapOf("a1" to "Hello", "a2" to "Other"), tails.copyTails())
    }

    @Test
    fun `ignores reasoning and command output taps`() {
        val tails = TailBuffer()

        tails.appendTap(buildTap("a1", "thinking", StreamKind.ReasoningText))
        tails.appendTap(buildTap("a1", "$ ls", StreamKind.CommandOutput))

        assertEquals("", tails.readTail("a1"))
    }

    @Test
    fun `removes a row's text from the front of the tail and keeps the text after the row's cut`() {
        val tails = TailBuffer()
        val cut = "x".repeat(4 * 1024)
        tails.appendTap(buildTap("a1", cut))
        tails.appendTap(buildTap("a1", ", and more"))

        tails.applyRows(listOf(buildTextRow("a1", cut)))

        assertEquals(", and more", tails.readTail("a1"))
    }

    @Test
    fun `skips an item whose tail does not start with a row's text, until the item completes`() {
        val tails = TailBuffer()
        tails.appendTap(buildTap("a1", "lo world"))

        tails.applyRows(listOf(buildTextRow("a1", "Hello world")))
        tails.appendTap(buildTap("a1", ", again"))
        assertEquals("", tails.readTail("a1"))

        tails.applyRows(listOf(buildItemCompleted("a1")))
        tails.appendTap(buildTap("a1", "kept"))
        assertEquals("kept", tails.readTail("a1"))
    }

    @Test
    fun `skips the items open in the rows when the tap is subscribed mid-item`() {
        val tails = TailBuffer()

        tails.skipOpenItems(listOf(buildItemStarted("done"), buildItemCompleted("done"), buildItemStarted("a1")))
        tails.appendTap(buildTap("a1", "rest of a sentence"))
        tails.appendTap(buildTap("a2", "Fresh"))

        assertEquals("", tails.readTail("a1"))
        assertEquals("Fresh", tails.readTail("a2"))
    }

    @Test
    fun `skips every item it holds a tail for when the tap is subscribed again`() {
        val tails = TailBuffer()
        tails.appendTap(buildTap("a1", "Before the gap"))

        tails.skipOpenItems(emptyList())
        tails.appendTap(buildTap("a1", " after the gap"))

        assertEquals("", tails.readTail("a1"))
    }

    @Test
    fun `keeps a long reply's tail equal to the text no row holds yet, token by token`() {
        val tails = TailBuffer()
        val reply = (1..2_000).joinToString(" ") { "word$it" }
        val tokens = reply.chunked(7)
        var stored = 0
        var tapped = 0
        for ((index, token) in tokens.withIndex()) {
            tails.appendTap(buildTap("a1", token))
            tapped += token.length
            // Every 300 tokens a row stores the text tapped so far, cut inside a token.
            if (index % 300 == 299) {
                val cut = tapped - 3
                tails.applyRows(listOf(buildTextRow("a1", reply.substring(stored, cut))))
                stored = cut
            }
            assertEquals(reply.substring(stored, tapped), tails.readTail("a1"))
        }
        assertEquals(mapOf("a1" to reply.substring(stored)), tails.copyTails())
    }
}
