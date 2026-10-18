package dev.hercule.android.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
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
 * Checks that the Thread keeps the reader where they are while the agent's message streams: a
 * paragraph that finishes turns from plain text into markdown and can change the message's
 * height, which must not move a reader who has scrolled up, and must keep the newest words in
 * view for a reader at the bottom.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "w390dp-h844dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ThreadStreamingScrollTest {
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

    private fun drawThread() {
        compose.setContent {
            BureauTheme(dark = false) {
                val book = buildBookThreadState()
                ThreadScreen(
                    book.copy(blocks = older + AgentBlock("m-open", writing, Instant.parse("2026-09-29T09:10:00Z"), null, open = true), openRequest = null),
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
