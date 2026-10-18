package dev.hercule.android.ui.markdown

import android.content.ClipboardManager
import android.content.Context
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.key.Key
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
 * Checks that a message's text can be selected from one block to another and copied as the
 * desktop copies it: inline code without its chip's padding, a task without its box, a list
 * without its markers.
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
        compose.onRoot().performKeyInput { withKeyDown(Key.CtrlLeft) { pressKey(Key.C) } }

        // A table's cells copy one to a line, in reading order: Compose joins the texts it
        // selects with a newline, where the desktop separates a row's cells with a tab.
        assertEquals("Run git push now.1\nDone task\nBullet\nval x = 1\nA\nB\n1\n2\nNote. ↩", readClipboard())
    }

    private fun draw(text: String) {
        compose.setContent {
            BureauTheme(dark = false) {
                MessageMarkdown(text, MessageAuthor.Agent)
            }
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
