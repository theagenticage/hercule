package dev.hercule.android.markdown

import kotlin.test.assertEquals
import org.junit.Test

/**
 * Tests [splitStreamingText]. The cases are copied one for one from
 * packages/client-core/src/threads/streaming-text.test.ts.
 */
class StreamingTextTest {
    @Test
    fun `leaves a text with no blank line wholly open`() {
        assertEquals(StreamingText(settled = "", open = "The configu"), splitStreamingText("The configu"))
    }

    @Test
    fun `splits after the last blank line`() {
        assertEquals(StreamingText(settled = "One.\n\nTwo.\n\n", open = "The configu"), splitStreamingText("One.\n\nTwo.\n\nThe configu"))
    }

    @Test
    fun `settles everything when the text ends with a blank line`() {
        assertEquals(StreamingText(settled = "One.\n\n", open = ""), splitStreamingText("One.\n\n"))
    }

    @Test
    fun `counts a line of spaces as blank`() {
        assertEquals(StreamingText(settled = "One.\n  \n", open = "Two"), splitStreamingText("One.\n  \nTwo"))
    }

    @Test
    fun `keeps a code block being written whole in the open part`() {
        assertEquals(StreamingText(settled = "Run:\n\n", open = "```sh\nmake\n\nmake te"), splitStreamingText("Run:\n\n```sh\nmake\n\nmake te"))
    }

    @Test
    fun `splits after a closed code block`() {
        assertEquals(StreamingText(settled = "```sh\nmake\n\n```\n\n", open = "Then"), splitStreamingText("```sh\nmake\n\n```\n\nThen"))
    }

    @Test
    fun `closes a fence only with a bare marker of the same character, at least as long`() {
        val text = "````md\n```\n\n~~~~\n\n```ts\n\n````\n\nDone"
        assertEquals(StreamingText(settled = text.dropLast(4), open = "Done"), splitStreamingText(text))
    }

    @Test
    fun `does not treat a fence still being typed on the last line as closed`() {
        assertEquals(StreamingText(settled = "", open = "```\ncode\n\n``"), splitStreamingText("```\ncode\n\n``"))
    }

    @Test
    fun `continues the scan after an earlier settled part`() {
        assertEquals(StreamingText(settled = "One.\n\nTwo.\n\n", open = "Three"), splitStreamingText("One.\n\nTwo.\n\nThree", "One.\n\n"))
    }

    @Test
    fun `keeps the earlier settled part when no paragraph has finished since`() {
        assertEquals(StreamingText(settled = "One.\n\n", open = "Tw"), splitStreamingText("One.\n\nTw", "One.\n\n"))
    }

    @Test
    fun `starts again from the beginning when the text no longer starts with the earlier settled part`() {
        assertEquals(StreamingText(settled = "One.\n\n", open = "Tw"), splitStreamingText("One.\n\nTw", "One.\n\nTwo.\n\n"))
    }
}
