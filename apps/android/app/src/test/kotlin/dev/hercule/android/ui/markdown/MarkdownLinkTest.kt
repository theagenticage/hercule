package dev.hercule.android.ui.markdown

import android.content.Intent
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.TouchInjectionScope
import androidx.compose.ui.test.performTouchInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.hercule.android.markdown.MarkdownBlock
import dev.hercule.android.markdown.MarkdownDocument
import dev.hercule.android.markdown.MarkdownInline
import dev.hercule.android.ui.BureauTheme
import kotlin.test.assertEquals
import kotlin.test.assertNull
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
    fun `offers each link that opens to a screen reader as an action`() {
        drawParagraph(
            MarkdownInline.Link("https://example.com/docs", null, listOf(MarkdownInline.Text("the docs"))),
            MarkdownInline.Text(" and "),
            MarkdownInline.Link("mailto:a@example.com", null, listOf(MarkdownInline.Text("mail"))),
        )

        val actions = readCustomActions("the docs and mail")
        assertEquals(listOf("Open the docs"), actions.map { it.label })
        compose.runOnIdle { actions.single().action() }

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
        assertEquals(emptyList(), readCustomActionsOrNone("Press here now."))
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

    /** Returns the actions a screen reader is offered on the text node [text]. */
    private fun readCustomActions(text: String): List<CustomAccessibilityAction> =
        compose.onNodeWithText(text).fetchSemanticsNode().config[SemanticsActions.CustomActions]

    /** Returns the actions a screen reader is offered on the text node [text], or none when it is offered none. */
    private fun readCustomActionsOrNone(text: String): List<CustomAccessibilityAction> {
        val config = compose.onNodeWithText(text).fetchSemanticsNode().config
        return if (SemanticsActions.CustomActions in config) config[SemanticsActions.CustomActions] else emptyList()
    }

    private fun drawParagraph(vararg inlines: MarkdownInline) = drawDocument(MarkdownBlock.Paragraph(inlines.toList()))

    private fun drawDocument(vararg blocks: MarkdownBlock) {
        val document = MarkdownDocument(blocks.toList(), emptyList())
        compose.setContent { BureauTheme(dark = false) { Markdown(document) } }
    }
}

