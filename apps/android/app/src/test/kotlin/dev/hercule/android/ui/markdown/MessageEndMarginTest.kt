package dev.hercule.android.ui.markdown

import androidx.compose.ui.unit.dp
import dev.hercule.android.markdown.parseMarkdown
import kotlin.test.assertEquals
import org.junit.Test

/**
 * Tests [computeEndMargin], the space the desktop leaves under a message's last block: none of
 * the block's own margin, but whatever the blocks inside it leave below them.
 */
class MessageEndMarginTest {
    @Test
    fun `leaves nothing under a message that ends in a paragraph, a code block or a tight list`() {
        listOf("Text.", "```\ncode\n```", "- one\n- two").forEach { assertEquals(0.dp, computeEndMargin(parseMarkdown(it), flushLastParagraph = true), it) }
    }

    @Test
    fun `leaves the margin of what ends a quote under the message`() {
        assertEquals(10.dp, computeEndMargin(parseMarkdown("> - one\n> - two"), flushLastParagraph = true))
        assertEquals(8.dp, computeEndMargin(parseMarkdown("> ```\n> code\n> ```"), flushLastParagraph = true))
    }

    @Test
    fun `leaves a closing paragraph's margin in a bubble, which keeps the margin of a last paragraph`() {
        assertEquals(0.dp, computeEndMargin(parseMarkdown("> Quoted."), flushLastParagraph = true))
        assertEquals(10.dp, computeEndMargin(parseMarkdown("> Quoted."), flushLastParagraph = false))
        assertEquals(0.dp, computeEndMargin(parseMarkdown("- one\n\n- two"), flushLastParagraph = true))
        assertEquals(10.dp, computeEndMargin(parseMarkdown("- one\n\n- two"), flushLastParagraph = false))
    }
}
