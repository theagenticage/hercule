package dev.hercule.android.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasScrollToIndexAction
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import kotlin.test.assertTrue
import androidx.compose.ui.test.hasScrollToNodeAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performScrollToNode
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.hercule.android.ui.fixtures.buildBookThreadState
import dev.hercule.android.ui.thread.AgentBlock
import dev.hercule.android.ui.thread.ThreadScreen
import kotlin.time.Instant
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Checks the Thread while the agent's message streams, and its footnote links:
 *
 * - a paragraph that finishes turns from plain text into markdown and can change the message's
 *   height, which must not move a reader who has scrolled up, and must keep the newest words in
 *   view for a reader at the bottom;
 * - an open message with no words yet is the "Writing…" line, with no byline;
 * - a footnote link brings its target fully into the transcript, above the composer, from a
 *   far column of a wide table and from inside a shut details block.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "w390dp-h844dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ThreadStreamingTest {
    @get:Rule
    val compose = createComposeRule()

    private var writing by mutableStateOf("Looking at the logs.\n\nThe **first** finding")

    private val older = (1..20).map { AgentBlock("m-$it", "Older message $it.", Instant.parse("2026-09-29T09:00:00Z"), null) }

    @Test
    fun `keeps a reader who scrolled up in place when a paragraph finishes`() {
        drawThread()
        compose.onNode(hasScrollToNodeAction()).performScrollToNode(hasText("Older message 3."))
        compose.onNodeWithText("Older message 3.").assertIsDisplayed()

        writing += ", in a table:\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```\nlong\nlines\n```\n\nNext"

        compose.onNodeWithText("Older message 3.").assertIsDisplayed()
    }

    @Test
    fun `keeps the newest words in view for a reader at the bottom`() {
        drawThread()

        writing += ".\n\n" + (1..12).joinToString("\n\n") { "Paragraph $it." } + "\n\nThe newest words"

        compose.onNodeWithText("The newest words").assertIsDisplayed()
    }

    @Test
    fun `draws the Writing line until the first word arrives, then the message`() {
        writing = ""
        drawThread()
        compose.onNodeWithText("Writing…").assertIsDisplayed()

        writing = "The first words"

        compose.onNodeWithText("Writing…").assertDoesNotExist()
        compose.onNodeWithText("The first words").assertIsDisplayed()
    }

    @Test
    fun `brings a reference in a far column of a wide table fully into view, above the composer`() {
        val wide = (1..8).joinToString(" | ", "| ", " |") { "Column $it with a long heading" }
        val rule = (1..8).joinToString(" | ", "| ", " |") { "---" }
        val row = (1..7).joinToString(" | ", "| ", " | ") { "cell $it" } + "Far cell[^1] |"
        writing = "$wide\n$rule\n$row\n\n" + filler() + "\n\n[^1]: The source."
        drawThread(finished = true)

        compose.onNodeWithContentDescription("Back to reference 1").performClick()

        assertFullyInTranscript("Far cell")
    }

    @Test
    fun `brings a reference inside a shut details block fully into view, above the composer`() {
        writing = "<details><summary>Sources</summary>\n\nA hidden claim.[^1]\n\n</details>\n\n" + filler() + "\n\n[^1]: The source."
        drawThread(finished = true)

        compose.onNodeWithContentDescription("Back to reference 1").performClick()

        assertFullyInTranscript("A hidden claim.")
    }

    /**
     * Asserts that the text node holding [text] is drawn whole inside the transcript, which ends
     * above the composer and starts under the bar, and inside the screen's width.
     */
    private fun assertFullyInTranscript(text: String) {
        val target = compose.onNodeWithText(text, substring = true).getUnclippedBoundsInRoot()
        val transcript = compose.onNode(hasScrollToIndexAction()).getBoundsInRoot()
        val composer = compose.onNodeWithText("Reply or steer…").getBoundsInRoot()
        assertTrue(transcript.bottom <= composer.top, "The transcript ends at ${transcript.bottom}, under the composer at ${composer.top}")
        assertTrue(target.top >= transcript.top && target.bottom <= transcript.bottom, "$text runs from ${target.top} to ${target.bottom}, outside ${transcript.top} to ${transcript.bottom}")
        assertTrue(target.left >= transcript.left && target.right <= transcript.right, "$text runs from ${target.left} to ${target.right}, outside ${transcript.left} to ${transcript.right}")
    }

    private fun drawThread(finished: Boolean = false) {
        compose.setContent {
            BureauTheme(dark = false) {
                val book = buildBookThreadState()
                ThreadScreen(
                    book.copy(blocks = older + AgentBlock("m-open", writing, Instant.parse("2026-09-29T09:10:00Z"), null, open = !finished), openRequest = null),
                    onBack = {},
                    backLabel = "Back to the Office",
                    onDecide = { _, _ -> },
                    onAnswer = { _, _ -> },
                    onSend = { _, _ -> },
                )
            }
        }
    }
}

/** Returns enough paragraphs to fill more than a screen. */
private fun filler() = (1..30).joinToString("\n\n") { "Filler paragraph $it, long enough to take a line of its own." }
