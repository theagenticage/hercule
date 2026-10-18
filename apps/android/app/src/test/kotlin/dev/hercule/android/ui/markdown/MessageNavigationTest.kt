package dev.hercule.android.ui.markdown

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotDisplayed
import androidx.compose.ui.test.hasScrollToIndexAction
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToIndex
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.hercule.android.markdown.MarkdownBlock
import dev.hercule.android.markdown.MarkdownDocument
import dev.hercule.android.markdown.MarkdownFootnote
import dev.hercule.android.markdown.MarkdownInline
import dev.hercule.android.ui.BureauTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Checks how a drawn message moves the reader and keeps its details blocks: footnote links bring
 * their targets into view within the list around the message, opening a shut details block on
 * the way, and an opened details block stays open while the document is parsed again.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "w390dp-h844dp-xhdpi")
// Without native graphics, Robolectric lays text out with no width, so no tap would land on it.
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class MessageNavigationTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun `brings the footnote into view from its reference, and the reference back from the footnote`() {
        drawMessages(
            listOf(
                MarkdownDocument(
                    listOf(paragraph(text("A claim."), MarkdownInline.FootnoteReference(1, isFirstReference = true))) + filler(),
                    listOf(MarkdownFootnote(1, listOf(paragraph(text("The source."), MarkdownInline.FootnoteBackReference(1))))),
                ),
            ),
        )
        // The list starts at the bottom of the message, as the transcript does.
        compose.onNodeWithText("The source.", substring = true).assertIsDisplayed()
        compose.onNodeWithText("A claim.", substring = true).assertIsNotDisplayed()

        compose.onNodeWithContentDescription("Back to reference 1").performClick()
        compose.onNodeWithText("A claim.", substring = true).assertIsDisplayed()
        compose.onNodeWithText("The source.", substring = true).assertIsNotDisplayed()

        compose.onNodeWithText("A claim.", substring = true).tapOnText("1")
        compose.onNodeWithText("The source.", substring = true).assertIsDisplayed()
    }

    @Test
    fun `opens the details block that holds the first reference before bringing it into view`() {
        drawMessages(
            listOf(
                MarkdownDocument(
                    listOf(
                        MarkdownBlock.Details(listOf(text("Sources")), listOf(paragraph(text("A hidden claim."), MarkdownInline.FootnoteReference(1, isFirstReference = true))) + filler()),
                        paragraph(text("A later claim."), MarkdownInline.FootnoteReference(1, isFirstReference = false)),
                    ),
                    listOf(MarkdownFootnote(1, listOf(paragraph(text("The source."), MarkdownInline.FootnoteBackReference(1))))),
                ),
            ),
        )
        compose.onNodeWithText("A hidden claim.", substring = true).assertDoesNotExist()

        compose.onNodeWithContentDescription("Back to reference 1").performClick()

        compose.onNodeWithText("A hidden claim.", substring = true).assertIsDisplayed()
    }

    @Test
    fun `keeps a details block open when a paragraph settles after it`() {
        var document by mutableStateOf(MarkdownDocument(listOf(paragraph(text("Before.")), details("Log", "Line one.")), emptyList()))
        drawMessages(listOf(document)) { listOf(document) }
        compose.onNodeWithText("Log").performClick()
        compose.onNodeWithText("Line one.").assertIsDisplayed()

        document = MarkdownDocument(document.blocks + paragraph(text("After.")), emptyList())

        compose.onNodeWithText("After.").assertIsDisplayed()
        compose.onNodeWithText("Line one.").assertIsDisplayed()
    }

    @Test
    fun `keeps an unfinished details block open as the rest of it streams in and it closes`() {
        var document by mutableStateOf(MarkdownDocument(listOf(paragraph(text("Before.")), details("Log", "Line one.")), emptyList()))
        drawMessages(listOf(document)) { listOf(document) }
        compose.onNodeWithText("Log").performClick()

        document = MarkdownDocument(
            listOf(
                paragraph(text("Before.")),
                MarkdownBlock.Details(listOf(text("Log")), listOf(paragraph(text("Line one.")), paragraph(text("Line two.")))),
                paragraph(text("After.")),
            ),
            emptyList(),
        )

        compose.onNodeWithText("Line two.").assertIsDisplayed()
    }

    @Test
    fun `opens only the details block tapped when two have the same summary`() {
        drawMessages(listOf(MarkdownDocument(listOf(details("Log", "First log."), details("Log", "Second log.")), emptyList())))

        compose.onAllNodesWithText("Log")[1].performClick()

        compose.onNodeWithText("Second log.").assertIsDisplayed()
        compose.onNodeWithText("First log.").assertDoesNotExist()
    }

    @Test
    fun `keeps each message's details to itself as rows leave the screen and come back`() {
        val messages = (0 until 40).map { MarkdownDocument(listOf(details("Log $it", "Body $it")), emptyList()) }
        drawMessages(messages)
        compose.onNodeWithText("Log 0").performClick()

        compose.onNode(hasScrollToIndexAction()).performScrollToIndex(39)
        compose.onNodeWithText("Log 39").assertIsDisplayed()
        compose.onAllNodesWithText("Body", substring = true).assertCountEquals(0)

        compose.onNode(hasScrollToIndexAction()).performScrollToIndex(0)
        compose.onNodeWithText("Body 0").assertIsDisplayed()
    }

    /**
     * Draws [messages] as the transcript draws its rows: one message per item of a reverse-layout
     * lazy list, all of one content type, with the newest, the first, at the bottom.
     */
    private fun drawMessages(messages: List<MarkdownDocument>, read: () -> List<MarkdownDocument> = { messages }) {
        compose.setContent {
            BureauTheme(dark = false) {
                LazyColumn(Modifier.fillMaxSize(), rememberLazyListState(), reverseLayout = true) {
                    items(read().indices.toList(), key = { it }, contentType = { "message" }) { index -> Markdown(read()[index]) }
                }
            }
        }
    }
}

private fun text(value: String) = MarkdownInline.Text(value)

private fun paragraph(vararg inlines: MarkdownInline) = MarkdownBlock.Paragraph(inlines.toList())

private fun details(summary: String, body: String) = MarkdownBlock.Details(listOf(text(summary)), listOf(paragraph(text(body))))

/** Returns enough paragraphs to fill more than a screen. */
private fun filler() = (1..40).map { paragraph(text("Filler paragraph $it, long enough to take a line of its own.")) }
