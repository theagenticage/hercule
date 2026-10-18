package dev.hercule.android.ui.markdown

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.style.ResolvedTextDirection
import androidx.compose.ui.unit.LayoutDirection
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.hercule.android.ui.BureauTheme
import kotlin.test.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Checks that a message's paragraph is laid out in the screen's direction whatever its first
 * letter, the direction the room for its chips is worked out in, as on the desktop.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "w390dp-h844dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class MessageDirectionTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun `lays Hebrew-first text out left to right on a left-to-right screen`() {
        assertEquals(ResolvedTextDirection.Ltr, readParagraphDirection("שלום (`git push`), עולם.", LayoutDirection.Ltr, "שלום"))
    }

    @Test
    fun `lays Latin-first text out right to left on a right-to-left screen`() {
        assertEquals(ResolvedTextDirection.Rtl, readParagraphDirection("Run (`git push`), then.", LayoutDirection.Rtl, "Run"))
    }

    /** Draws [text] on a screen of [direction] and returns the direction its paragraph was laid out in. */
    private fun readParagraphDirection(text: String, direction: LayoutDirection, holding: String): ResolvedTextDirection {
        compose.setContent {
            CompositionLocalProvider(LocalLayoutDirection provides direction) { BureauTheme(dark = false) { MessageMarkdown(text, MessageAuthor.Agent) } }
        }
        val results = mutableListOf<TextLayoutResult>()
        compose.onNodeWithText(holding, substring = true).fetchSemanticsNode().config[SemanticsActions.GetTextLayoutResult].action!!(results)
        return results.single().getParagraphDirection(0)
    }
}
