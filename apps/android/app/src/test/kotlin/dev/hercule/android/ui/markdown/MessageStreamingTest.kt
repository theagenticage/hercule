package dev.hercule.android.ui.markdown

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.hercule.android.ui.BureauTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Checks how a message the agent is still writing is drawn: its finished paragraphs as
 * markdown, the paragraph being written as the plain text it is so far, both from the same text
 * in every frame, and the whole message as markdown once it ends.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "w390dp-h844dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class MessageStreamingTest {
    @get:Rule
    val compose = createComposeRule()

    private var text by mutableStateOf("")
    private var writing by mutableStateOf(true)

    @Test
    fun `draws finished paragraphs as markdown and the paragraph being written as plain text`() {
        draw("The **cause**.\n\nThe **fi")

        compose.onNodeWithText("The cause.").assertExists()
        compose.onNodeWithText("The **fi").assertExists()
    }

    @Test
    fun `draws a paragraph once, in the frame it finishes and after`() {
        draw("The **cause**.\n\nThe **fix**")
        compose.mainClock.autoAdvance = false

        text = "The **cause**.\n\nThe **fix**.\n\n"
        // One frame, the first that sees the new text.
        Snapshot.sendApplyNotifications()
        compose.mainClock.advanceTimeByFrame()

        compose.onAllNodesWithText("The fix", substring = true).assertCountEquals(1)
        compose.onAllNodesWithText("**fix**", substring = true).assertCountEquals(0)
        compose.mainClock.autoAdvance = true
    }

    @Test
    fun `draws the whole message as markdown once it ends`() {
        draw("The **cause**.\n\nThe **fix**.")

        writing = false

        compose.onNodeWithText("The fix.").assertExists()
        compose.onAllNodesWithText("**", substring = true).assertCountEquals(0)
    }

    @Test
    fun `keeps a details block open while the message grows, and shuts it when the text is replaced`() {
        draw("<details><summary>Log</summary>\n\nLine one.\n\n</details>\n\nAfter")
        compose.onNodeWithText("Log").performClick()
        compose.onNodeWithText("Line one.").assertExists()

        text += " that.\n\nMore"
        compose.onNodeWithText("Line one.").assertExists()

        // The streamed words were dropped and the stored text took their place.
        text = "Before.\n\n<details><summary>Log</summary>\n\nLine one.\n\n</details>\n\n"
        compose.onNodeWithText("Log").assertExists()
        compose.onNodeWithText("Line one.").assertDoesNotExist()
    }

    @Test
    fun `shuts a finished message's details blocks when its text is replaced`() {
        writing = false
        draw("<details><summary>Log</summary>\n\nLine one.\n\n</details>")
        compose.onNodeWithText("Log").performClick()
        compose.onNodeWithText("Line one.").assertExists()

        text = "<details><summary>Log</summary>\n\nLine one, corrected.\n\n</details>"

        compose.onNodeWithText("Log").assertExists()
        compose.onNodeWithText("Line one, corrected.").assertDoesNotExist()
    }

    @Test
    fun `shuts the details blocks of a message that ends with a corrected text`() {
        draw("<details><summary>Log</summary>\n\nLine one.\n\n</details>\n\nAfter")
        compose.onNodeWithText("Log").performClick()
        compose.onNodeWithText("Line one.").assertExists()

        text = "<details><summary>Log</summary>\n\nLine 1.\n\n</details>\n\nAfter that."
        writing = false

        compose.onNodeWithText("After that.").assertExists()
        compose.onNodeWithText("Line 1.").assertDoesNotExist()
    }

    @Test
    fun `keeps the details blocks of a message that ends with the text it streamed`() {
        draw("<details><summary>Log</summary>\n\nLine one.\n\n</details>\n\nAfter")
        compose.onNodeWithText("Log").performClick()

        text += " that."
        writing = false

        compose.onNodeWithText("Line one.").assertExists()
    }

    private fun draw(initial: String) {
        text = initial
        compose.setContent { BureauTheme(dark = false) { MessageMarkdown(text, MessageAuthor.Agent, writing = writing) } }
    }
}
