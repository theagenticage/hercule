package dev.hercule.android.ui.markdown

import android.content.Intent
import androidx.activity.ComponentActivity
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.TouchInjectionScope
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasNoClickAction
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.pressKey
import androidx.compose.ui.test.requestFocus
import androidx.compose.ui.text.AnnotatedString
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.hercule.android.markdown.MarkdownBlock
import dev.hercule.android.markdown.MarkdownDocument
import dev.hercule.android.markdown.MarkdownInline
import dev.hercule.android.ui.BureauTheme
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.GraphicsMode
import org.robolectric.shadows.ShadowToast

/**
 * Checks what a tap on a message's link does: only an http or https address opens, in the app
 * that views it, and a phone with no such app shows a toast rather than failing.
 */
@RunWith(AndroidJUnit4::class)
// Without native graphics, Robolectric lays text out with no width, so no tap would land on it.
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class MarkdownLinkTest {
    @get:Rule
    val compose = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun `opens an https link in the browser`() {
        tapLink("https://example.com/docs?a=1")

        val intent = shadowOf(compose.activity).nextStartedActivity
        assertEquals(Intent.ACTION_VIEW, intent.action)
        assertEquals("https://example.com/docs?a=1", intent.dataString)
        assertEquals(setOf(Intent.CATEGORY_BROWSABLE), intent.categories)
    }

    @Test
    fun `opens an http link whose scheme is written in capitals`() {
        tapLink("HTTP://example.com/")

        assertEquals("HTTP://example.com/", shadowOf(compose.activity).nextStartedActivity.dataString)
    }

    @Test
    fun `does nothing for a link of any other scheme, a relative link or a fragment`() {
        val hrefs = listOf("mailto:a@example.com", "xmpp:a@example.com", "docs/readme.md", "#section")
        drawDocument(MarkdownBlock.Paragraph(hrefs.flatMap { listOf(MarkdownInline.Link(it, null, listOf(MarkdownInline.Text(it))), MarkdownInline.Text(" ")) }))

        hrefs.forEach { href ->
            compose.onNodeWithText(hrefs.joinToString(" "), substring = true).tapOnText(href)
            assertNull(shadowOf(compose.activity).nextStartedActivity, href)
        }
    }

    @Test
    fun `opens an image's address as a link named by its alt text, and never loads it`() {
        drawParagraph(MarkdownInline.Image("https://example.com/log.png", "The build log", null))

        compose.onNodeWithText("The build log").tapOnText("build")

        assertEquals("https://example.com/log.png", shadowOf(compose.activity).nextStartedActivity.dataString)
    }

    @Test
    fun `names an image with no alt text by its address`() {
        drawParagraph(MarkdownInline.Image("https://example.com/log.png", "", null))

        compose.onNodeWithText("https://example.com/log.png").tapOnText("example")

        assertEquals("https://example.com/log.png", shadowOf(compose.activity).nextStartedActivity.dataString)
    }

    @Test
    fun `gives each link a node of its own, named by its text and its title, that a screen reader can follow`() {
        drawParagraph(
            MarkdownInline.Link("https://example.com/docs", "The setup guide", listOf(MarkdownInline.Text("the docs"))),
            MarkdownInline.Text(" and "),
            MarkdownInline.Link("mailto:a@example.com", null, listOf(MarkdownInline.Text("mail"))),
        )

        compose.onNodeWithContentDescription("the docs, The setup guide").assert(hasClickAction()).performSemanticsAction(SemanticsActions.OnClick)

        assertEquals("https://example.com/docs", shadowOf(compose.activity).nextStartedActivity.dataString)
        // A link that does nothing is still a link to read, with nothing to do.
        compose.onNodeWithContentDescription("mail").assert(hasNoClickAction())
    }

    @Test
    fun `marks the links in the text a screen reader reads, for its link navigation`() {
        drawParagraph(
            MarkdownInline.Link("https://example.com/docs", null, listOf(MarkdownInline.Text("the docs"))),
            MarkdownInline.Text(" and "),
            MarkdownInline.FootnoteReference(1, isFirstReference = true),
        )

        val text = compose.onNodeWithText("the docs and 1").fetchSemanticsNode().config[SemanticsProperties.Text].single()

        assertEquals(listOf("the docs", "1"), text.getLinkAnnotations(0, text.length).map { text.substring(it.start, it.end) })
    }

    @Test
    fun `lays a link that wraps over lines on its first line only, not over the text between`() {
        drawParagraph(
            MarkdownInline.Text("A sentence long enough that the link "),
            MarkdownInline.Link("https://example.com/", null, listOf(MarkdownInline.Text("starts near the end of a line and goes on over the next one"))),
            MarkdownInline.Text("."),
        )

        val link = compose.onNodeWithContentDescription("starts near the end of a line and goes on over the next one").getUnclippedBoundsInRoot()
        val paragraph = compose.onNodeWithText("A sentence", substring = true).getUnclippedBoundsInRoot()

        val linkHeight = link.bottom - link.top
        val paragraphHeight = paragraph.bottom - paragraph.top
        assertTrue(linkHeight < paragraphHeight / 2, "The link's node is $linkHeight tall, of a paragraph $paragraphHeight tall")
        assertTrue(link.left > paragraph.left, "The link's node starts at the paragraph's start, over the text before it")
    }

    @Test
    fun `gives a message's text the actions Android's text translation uses`() {
        drawParagraph(MarkdownInline.Text("Read "), MarkdownInline.Link("https://example.com/docs", null, listOf(MarkdownInline.Text("the docs"))))
        val text = compose.onNodeWithText("Read the docs")

        text.performSemanticsAction(SemanticsActions.SetTextSubstitution) { it(AnnotatedString("Lees de docs")) }
        text.performSemanticsAction(SemanticsActions.ShowTextSubstitution) { it(true) }

        text.assert(SemanticsMatcher.expectValue(SemanticsProperties.TextSubstitution, AnnotatedString("Lees de docs")))
        text.assert(SemanticsMatcher.expectValue(SemanticsProperties.IsShowingTextSubstitution, true))
        text.performSemanticsAction(SemanticsActions.ClearTextSubstitution)
        text.assert(SemanticsMatcher.keyNotDefined(SemanticsProperties.TextSubstitution))
    }

    @Test
    fun `follows a link focused from the keyboard with Enter`() {
        drawParagraph(MarkdownInline.Text("Read "), MarkdownInline.Link("https://example.com/docs", null, listOf(MarkdownInline.Text("the docs"))))
        val link = compose.onNodeWithContentDescription("the docs")

        link.requestFocus().assertIsFocused()
        link.performKeyInput { pressKey(Key.Enter) }

        assertEquals("https://example.com/docs", shadowOf(compose.activity).nextStartedActivity.dataString)
    }

    @Test
    fun `opens nothing on a long press on a link`() {
        tapLink("https://example.com/", press = { down(center); advanceEventTime(1_000); up() })

        assertNull(shadowOf(compose.activity).nextStartedActivity)
    }

    @Test
    fun `opens nothing for a script address hidden behind a character reference, from parse to tap`() {
        compose.setContent { BureauTheme(dark = false) { MessageMarkdown("Press [here](jav&#x61;script:alert(1)) now.", MessageAuthor.Agent) } }

        compose.onNodeWithText("Press here now.").tapOnText("here")

        assertNull(shadowOf(compose.activity).nextStartedActivity)
        // The parser kept the link's text and dropped the link.
        compose.onNodeWithContentDescription("here").assertDoesNotExist()
    }

    @Test
    fun `shows a toast when no app can open the link`() {
        shadowOf(compose.activity.application).checkActivities(true)

        tapLink("https://example.com/")

        assertEquals("No app on this phone can open example.com.", ShadowToast.getTextOfLatestToast())
    }

    /**
     * Draws a paragraph with one link to [href] named "the link", and taps it, or touches it the
     * way [press] does, from the link's middle.
     */
    private fun tapLink(href: String, press: (TouchInjectionScope.(center: Offset) -> Unit)? = null) {
        drawParagraph(MarkdownInline.Text("Read "), MarkdownInline.Link(href, null, listOf(MarkdownInline.Text("the link"))), MarkdownInline.Text("."))
        val node = compose.onNodeWithText("Read the link.")
        if (press == null) node.tapOnText("the link") else node.performTouchInput { press(Offset(width * 0.5f, centerY)) }
    }

    private fun drawParagraph(vararg inlines: MarkdownInline) = drawDocument(MarkdownBlock.Paragraph(inlines.toList()))

    private fun drawDocument(vararg blocks: MarkdownBlock) {
        val document = MarkdownDocument(blocks.toList(), emptyList())
        compose.setContent { BureauTheme(dark = false) { Markdown(document) } }
    }
}

