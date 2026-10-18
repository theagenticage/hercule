package dev.hercule.android.ui.markdown

import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.hercule.android.markdown.MarkdownBlock
import dev.hercule.android.markdown.MarkdownDocument
import dev.hercule.android.markdown.MarkdownInline
import dev.hercule.android.markdown.MarkdownTableCell
import dev.hercule.android.ui.BureauTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import kotlin.math.abs
import kotlin.test.assertTrue

/**
 * Checks how a table lays out its columns: as narrow as its text when that fits, sideways
 * scrolling when a cell cannot wrap, measured again for a new font scale, mirrored right to
 * left, and safe from a span wider than any table.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "w390dp-h844dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class MarkdownTableTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun `draws a table that fits as narrow as its text, not stretched to the message`() {
        draw(table(listOf("Left", "Right"), listOf("a", "b")))

        assertTrue(compose.onNodeWithText("Right").getUnclippedBoundsInRoot().right < 200.dp)
        assertNothingScrolls()
    }

    @Test
    fun `scrolls a table sideways when a cell holds a run that cannot wrap`() {
        val address = "https://example.com/" + "a".repeat(120)
        draw(table(listOf("Address", "Size"), listOf(address, "1 KB")))

        compose.onNode(hasScrollAction()).assertExists()
        val size = compose.onNodeWithText("Size").getUnclippedBoundsInRoot()
        assertTrue(size.left > MESSAGE_WIDTH, "The second column starts at ${size.left}")
    }

    @Test
    fun `measures the columns again when the font scale changes`() {
        var fontScale by mutableFloatStateOf(1f)
        compose.setContent {
            val density = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(density.density, fontScale)) { Message(table(listOf("Left", "Right"), listOf("a", "b"))) }
        }
        val before = compose.onNodeWithText("Right").getUnclippedBoundsInRoot()

        fontScale = 2f

        // The first column is its text and 12 dp after it, and Android scales large text by less than the font scale.
        val after = compose.onNodeWithText("Right").getUnclippedBoundsInRoot()
        assertTrue(after.left - 12.dp > (before.left - 12.dp) * 1.5f, "The second column moved from ${before.left} to ${after.left}")
    }

    @Test
    fun `lays the first column out on the right in a right-to-left layout`() {
        compose.setContent {
            CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Rtl) { Message(table(listOf("First", "Second"), listOf("a", "b"))) }
        }

        assertTrue(compose.onNodeWithText("First").getUnclippedBoundsInRoot().left > compose.onNodeWithText("Second").getUnclippedBoundsInRoot().left)
    }

    @Test
    fun `caps a cell's span at the parser's 64 columns`() {
        val wide = MarkdownTableCell(listOf(MarkdownInline.Text("Spans everything")), 100_000, null)
        draw(MarkdownBlock.Table(emptyList(), listOf(listOf(wide), listOf(cell("a"), cell("b")))))

        compose.onNodeWithText("Spans everything").assertExists()
        compose.onNodeWithText("b").assertExists()
    }

    @Test
    fun `keeps every column of a markdown table wider than any colspan`() {
        val columns = 1..65
        val text = listOf(
            columns.joinToString(" | ", "| ", " |") { "h$it" },
            columns.joinToString(" | ", "| ", " |") { "---" },
            columns.joinToString(" | ", "| ", " |") { "v$it" },
        ).joinToString("\n")
        compose.setContent { BureauTheme(dark = false) { MessageMarkdown(text, MessageAuthor.Agent, Modifier.width(MESSAGE_WIDTH)) } }

        val last = compose.onNodeWithText("v65").getUnclippedBoundsInRoot()
        val beforeLast = compose.onNodeWithText("v64").getUnclippedBoundsInRoot()
        assertTrue(last.left >= beforeLast.right, "v65 starts at ${last.left}, inside v64, which ends at ${beforeLast.right}")
    }

    @Test
    fun `aligns a cell that fits on one line in a centred or right-aligned column`() {
        compose.setContent {
            BureauTheme(dark = false) {
                MessageMarkdown("| Food | Centred heading | Right heading |\n|---|:---:|---:|\n| Eggs | b | c |", MessageAuthor.Agent, Modifier.width(MESSAGE_WIDTH))
            }
        }

        val heading = readGlyphBox("Centred heading", "Centred heading")
        val centred = readGlyphBox("b", "b")
        assertTrue(abs(centred.second - heading.second) < 2f, "The centred cell's middle is ${centred.second}, the heading's ${heading.second}")
        val right = readGlyphBox("c", "c")
        val rightHeading = readGlyphBox("Right heading", "Right heading")
        assertTrue(abs(right.third - rightHeading.third) < 2f, "The right-aligned cell ends at ${right.third}, its heading at ${rightHeading.third}")
    }

    /** Returns the root position of the [part] of the text node [node]: its left, its middle and its right, in px. */
    private fun readGlyphBox(node: String, part: String): Triple<Float, Float, Float> {
        val interaction = compose.onNodeWithText(node)
        val results = mutableListOf<TextLayoutResult>()
        val semantics = interaction.fetchSemanticsNode()
        semantics.config[SemanticsActions.GetTextLayoutResult].action!!(results)
        val layout = results.single()
        val start = layout.layoutInput.text.text.indexOf(part)
        val left = layout.getBoundingBox(start).left + semantics.positionInRoot.x
        val right = layout.getBoundingBox(start + part.length - 1).right + semantics.positionInRoot.x
        return Triple(left, (left + right) / 2f, right)
    }

    private fun draw(block: MarkdownBlock) = compose.setContent { Message(block) }

    @Composable
    private fun Message(block: MarkdownBlock) = BureauTheme(dark = false) {
        Markdown(MarkdownDocument(listOf(block), emptyList()), Modifier.width(MESSAGE_WIDTH))
    }

    /** Asserts that nothing on screen can scroll sideways. */
    private fun assertNothingScrolls() {
        compose.onAllNodes(hasScrollAction()).fetchSemanticsNodes().forEach { node ->
            val range = node.config[SemanticsProperties.HorizontalScrollAxisRange]
            assertTrue(range.maxValue() == 0f, "The table scrolls by ${range.maxValue()}")
        }
    }
}

/** The width of the message in these tests, the phone's 390 dp less the transcript's padding. */
private val MESSAGE_WIDTH = 358.dp

private fun cell(text: String) = MarkdownTableCell(listOf(MarkdownInline.Text(text)), 1, null)

private fun table(header: List<String>, row: List<String>) = MarkdownBlock.Table(header.map(::cell), listOf(row.map(::cell)))
