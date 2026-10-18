package dev.hercule.android.ui.markdown

import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.hercule.android.ui.BureauTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Checks that a message nested as deep as the parser draws, and deeper, is drawn without
 * failing: each level of a quote or a list is a few composables deep.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "w390dp-h844dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class MessageDepthTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun `draws quotes and lists nested a hundred deep`() {
        val quotes = ">".repeat(99) + " The deepest quote."
        val lists = (0 until 99).joinToString("\n") { "  ".repeat(it) + "- Level $it" }
        compose.setContent { BureauTheme(dark = false) { MessageMarkdown("$quotes\n\n$lists", MessageAuthor.Agent) } }

        compose.onNodeWithText("The deepest quote.", substring = true).assertExists()
        compose.onNodeWithText("Level 98", substring = true).assertExists()
    }

    @Test
    fun `draws a message nested deeper than the parser reads as its plain text`() {
        compose.setContent { BureauTheme(dark = false) { MessageMarkdown(">".repeat(5_000) + " Too deep.", MessageAuthor.Agent) } }

        compose.onNodeWithText("Too deep.", substring = true).assertExists()
    }
}
