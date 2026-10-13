package dev.hercule.android.ui

import dev.hercule.android.ui.connection.readHost
import kotlin.test.assertEquals
import org.junit.Test

/** Tests [splitMessageParts] and [readHost]. */
class MessagesTest {
    @Test
    fun `splits paragraphs at blank lines and keeps a paragraph's line breaks`() {
        assertEquals(
            listOf(MessagePart.Paragraph("one\ntwo"), MessagePart.Paragraph("three")),
            splitMessageParts("one\ntwo\n\n\nthree\n"),
        )
    }

    @Test
    fun `splits out a fenced code block, blank lines and all`() {
        assertEquals(
            listOf(
                MessagePart.Paragraph("Before:"),
                MessagePart.CodeBlock("if (a) {\n\n  b()\n}"),
                MessagePart.Paragraph("After."),
            ),
            splitMessageParts("Before:\n```ts\nif (a) {\n\n  b()\n}\n```\nAfter."),
        )
    }

    @Test
    fun `runs a code block left open to the end of the text`() {
        assertEquals(listOf(MessagePart.CodeBlock("x = 1")), splitMessageParts("```\nx = 1"))
    }

    @Test
    fun `reads the host of a controller address`() {
        assertEquals("studio-mac.local:7777", readHost("http://studio-mac.local:7777/"))
        assertEquals("example.com", readHost("https://example.com/api"))
        assertEquals("studio-mac.local", readHost("studio-mac.local"))
    }
}
