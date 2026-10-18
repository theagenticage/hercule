package dev.hercule.android.ui.markdown

import android.content.ClipboardManager
import android.content.Context
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performMouseInput
import androidx.compose.ui.test.pressKey
import androidx.compose.ui.test.withKeyDown
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.hercule.android.ui.BureauTheme
import kotlin.test.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Checks that a message's text can be selected from one block to another and copied holding
 * only what the message says: no character for the padding of inline code, the caret, a task's
 * box or a list's markers, and every character the text holds.
 *
 * The selection is made with a mouse drag and copied with Ctrl+C. A selection made by a long
 * press is not tested: Robolectric fails when the magnifier it shows is dismissed.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "w390dp-h844dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class MessageSelectionTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun `copies a selection across blocks as the text reads`() {
        draw(
            """
            Run `git push` now.[^1]

            - [x] Done task
            - Bullet

            ```
            val x = 1
            ```

            | A | B |
            |---|---|
            | 1 | 2 |

            [^1]: Note.
            """.trimIndent(),
        )

        selectFrom("Run", to = "Note.")
        copySelection()

        // A table's cells copy one to a line: Compose joins the texts it selects with newlines.
        assertEquals("Run git push now.1\nDone task\nBullet\nval x = 1\nA\nB\n1\n2\nNote. ↩", readClipboard())
    }

    @Test
    fun `keeps every space the text holds, in prose and in code`() {
        val text = "Spaces: a\u2007b, c\u00A0d, `e\u2007f` and `g\u00A0h`."
        draw(text)

        selectFrom("Spaces", to = "Spaces")
        copySelection()

        assertEquals("Spaces: a\u2007b, c\u00A0d, e\u2007f and g\u00A0h.", readClipboard())
    }

    @Test
    fun `copies exactly the characters selected inside a code chip`() {
        draw("Run `git push origin` now.")

        selectCharacters("git push origin", from = "it", to = "pus")
        copySelection()

        assertEquals("it pus", readClipboard())
    }

    @Test
    fun `copies the paragraph being written without its caret`() {
        compose.setContent { BureauTheme(dark = false) { MessageMarkdown("Done.\n\nWriting now", MessageAuthor.Agent, writing = true, caret = Color.Blue) } }

        selectFrom("Done", to = "Writing now")
        copySelection()

        assertEquals("Done.\nWriting now", readClipboard())
    }

    private fun draw(text: String) {
        compose.setContent { BureauTheme(dark = false) { MessageMarkdown(text, MessageAuthor.Agent) } }
    }

    private fun copySelection() = compose.onRoot().performKeyInput { withKeyDown(Key.CtrlLeft) { pressKey(Key.C) } }

    /**
     * Selects, with a mouse, the characters of the text node holding [node] from the first
     * character of [from] to the last character of [to].
     */
    private fun selectCharacters(node: String, from: String, to: String) {
        val results = mutableListOf<TextLayoutResult>()
        val interaction = compose.onNodeWithText(node, substring = true)
        interaction.fetchSemanticsNode().config[SemanticsActions.GetTextLayoutResult].action!!(results)
        val layout = results.single()
        val drawn = layout.layoutInput.text.text
        val start = layout.getBoundingBox(drawn.indexOf(from))
        val end = layout.getBoundingBox(drawn.indexOf(to) + to.length - 1)
        interaction.performMouseInput {
            moveTo(Offset(start.left + 1f, start.center.y))
            press()
            moveTo(Offset(end.right - 1f, end.center.y))
            release()
        }
    }

    /** Selects from the start of the text holding [from] to past the end of the text holding [to], with a mouse. */
    private fun selectFrom(from: String, to: String) {
        val start = compose.onNodeWithText(from, substring = true).getUnclippedBoundsInRoot()
        val end = compose.onNodeWithText(to, substring = true).getUnclippedBoundsInRoot()
        compose.onRoot().performMouseInput {
            moveTo(Offset(start.left.toPx() + 1f, start.top.toPx() + 5f))
            press()
            moveTo(Offset(end.right.toPx() + 40f, end.bottom.toPx() - 5f))
            release()
        }
    }

    private fun readClipboard(): String? =
        ApplicationProvider.getApplicationContext<Context>().getSystemService(ClipboardManager::class.java).primaryClip?.getItemAt(0)?.text?.toString()
}
