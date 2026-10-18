package dev.hercule.android.ui.markdown

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.widget.Toast
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.InlineTextContent
import androidx.compose.foundation.text.appendInlineContent
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.Placeholder
import androidx.compose.ui.text.PlaceholderVerticalAlign
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.style.BaselineShift
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextIndent
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import androidx.core.net.toUri
import dev.hercule.android.markdown.MarkdownInline
import dev.hercule.android.markdown.extractPlainText
import dev.hercule.android.theme.BoldWeight
import dev.hercule.android.ui.InlineCodeStyle
import dev.hercule.android.ui.appendCode
import dev.hercule.android.ui.drawCodeChips
import dev.hercule.android.ui.forEachLineOfRange

/*
 * The text of one block: a paragraph, a heading, a summary or a table cell. Its inlines are
 * built into one AnnotatedString, drawn by one BasicText, as markdown.tsx draws them:
 *
 * - strong is bold, emphasis is italic, a deletion is struck through;
 * - inline code is a rounded chip (see CodeText.kt);
 * - a link is underlined in `--line`, 3 dp under the baseline, and only an http or https link
 *   opens, in the browser ([openLink]), on a tap ([tapLinks]);
 * - an image is never loaded: it is a link to its address named by its alt text, or by the
 *   address when it has no alt text, and plain alt text when it has no address;
 * - a task item's box is drawn read-only before the item's text;
 * - a footnote reference is a raised number that leads to the footnote, and a footnote's back
 *   link "↩" leads back to the first reference (see [FootnoteNavigator]).
 */

/** One block's inlines, built for drawing by [buildBlockText]. */
@Immutable
internal class BlockText(
    val text: AnnotatedString,
    /** Whether the task box at the start of the text is ticked, or null when the text has none. */
    val checkbox: Boolean?,
    /** The footnotes whose first reference is in [text], each with the reference's offset. */
    val firstReferences: List<Pair<Int, Int>>,
    /** The footnotes whose back link is in [text]. */
    val backLinks: List<Int>,
    /** The links in [text] that do something when tapped. */
    val links: List<TextLink>,
)

/**
 * A link in a block's text, from [start] to [end], that does something when tapped: [follow]
 * opens it or goes to its footnote target. [label] names what it does for a screen reader, such
 * as "Open the docs".
 */
internal class TextLink(val start: Int, val end: Int, val label: String, val follow: () -> Unit)

/** What a tap on a message's link does: open it in the browser, or go to a footnote target. */
@Stable
internal class MarkdownActions(private val context: Context, val navigator: FootnoteNavigator) {
    fun openLink(href: String) = openLink(context, href)
}

/**
 * Opens [href] in the app that views it, normally the browser, when it is an http or https
 * address. Any other link does nothing, as on the desktop, where the window never navigates:
 *
 * - a relative link, or a `#` link that is not a footnote's, has no page to open;
 * - a mailto, irc or xmpp link passed the parser's safety check, but the desktop opens none.
 *
 * A phone with no app for the address shows a toast saying so, rather than failing.
 */
internal fun openLink(context: Context, href: String) {
    if (!isWebAddress(href)) return
    val uri = href.toUri()
    try {
        context.startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE))
    } catch (_: ActivityNotFoundException) {
        Toast.makeText(context, "No app on this phone can open ${uri.host ?: href}.", Toast.LENGTH_SHORT).show()
    }
}

/** Checks whether [href] is an http or https address, the only links a tap opens. */
internal fun isWebAddress(href: String): Boolean = href.toUri().scheme?.lowercase().let { it == "http" || it == "https" }

/**
 * Builds [inlines] into the text of one block, with inline code drawn by [codeStyle] (padded by a
 * space of [chipPadding], see [appendCode]) and links that act through [actions].
 *
 * This is the one place a message's text is built, so its cost can be measured here: it runs
 * once per block each time the block's inlines change, and never for a streamed token that
 * leaves the block as it was.
 */
internal fun buildBlockText(
    inlines: List<MarkdownInline>,
    codeStyle: InlineCodeStyle,
    chipPadding: TextUnit,
    actions: MarkdownActions,
): BlockText {
    val firstReferences = mutableListOf<Pair<Int, Int>>()
    val backLinks = mutableListOf<Int>()
    val links = mutableListOf<TextLink>()
    val leading = inlines.firstOrNull() as? MarkdownInline.Checkbox
    val text = buildAnnotatedString {
        fun appendLink(href: String, name: String, append: () -> Unit) {
            val start = length
            append()
            addStringAnnotation(UNDERLINE_TAG, "", start, length)
            if (isWebAddress(href)) links += TextLink(start, length, "Open $name") { actions.openLink(href) }
        }
        fun appendInlines(children: List<MarkdownInline>) {
            children.forEach { inline ->
                when (inline) {
                    is MarkdownInline.Text -> append(inline.text)
                    is MarkdownInline.Strong -> withStyle(SpanStyle(fontWeight = BoldWeight)) { appendInlines(inline.children) }
                    is MarkdownInline.Emphasis -> withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { appendInlines(inline.children) }
                    is MarkdownInline.Strikethrough ->
                        withStyle(SpanStyle(textDecoration = TextDecoration.LineThrough)) { appendInlines(inline.children) }
                    is MarkdownInline.InlineCode -> appendCode(inline.text, codeStyle, chipPadding)
                    MarkdownInline.Break -> append('\n')
                    is MarkdownInline.Link -> appendLink(inline.href, extractPlainText(inline.children)) { appendInlines(inline.children) }
                    is MarkdownInline.Image -> {
                        val name = inline.alt.ifEmpty { inline.src }
                        if (inline.src.isEmpty()) append(inline.alt) else appendLink(inline.src, name) { append(name) }
                    }
                    // The parser puts a task box only at the start of an item's first paragraph,
                    // where it is drawn in the text's indent; see MarkdownText.
                    is MarkdownInline.Checkbox -> Unit
                    is MarkdownInline.FootnoteReference -> {
                        val start = length
                        if (inline.isFirstReference) firstReferences += inline.number to start
                        withStyle(SpanStyle(fontSize = SUPERSCRIPT_SIZE.em, baselineShift = BaselineShift.Superscript)) { append(inline.number.toString()) }
                        addStringAnnotation(UNDERLINE_TAG, RAISED, start, length)
                        links += TextLink(start, length, "Footnote ${inline.number}") { actions.navigator.goTo(FootnoteTarget.Note(inline.number)) }
                    }
                    is MarkdownInline.FootnoteBackReference -> {
                        backLinks += inline.number
                        append(' ')
                        val start = length
                        appendInlineContent(buildBackLinkId(inline.number), BACK_LINK)
                        addStringAnnotation(UNDERLINE_TAG, "", start, length)
                        links += TextLink(start, length, "Back to reference ${inline.number}") { actions.navigator.goTo(FootnoteTarget.Reference(inline.number)) }
                    }
                }
            }
        }
        appendInlines(if (leading != null) inlines.drop(1) else inlines)
    }
    return BlockText(text, leading?.checked, firstReferences, backLinks, links)
}

/**
 * Draws one block's [text] in [style], with its chips, its links' underlines, its task box and
 * its back links, as markdown.tsx and markdown.css draw them. [decorate] draws more behind the
 * text once it is laid out, such as a details block's chevron.
 *
 * The first references in [text] register with the message's [FootnoteNavigator] while they are
 * drawn, so a back link can bring them into view.
 */
@Composable
internal fun MarkdownText(
    text: BlockText,
    style: TextStyle,
    look: MarkdownLook,
    actions: MarkdownActions,
    modifier: Modifier = Modifier,
    decorate: (DrawScope.(TextLayoutResult) -> Unit)? = null,
) {
    var layout by remember { mutableStateOf<TextLayoutResult?>(null) }
    val codeStyle = look.buildCodeStyle(style.color)
    val density = LocalDensity.current
    // The desktop draws a space between the box and the item's text. It is part of the indent
    // here, so a copy of the item's text does not start with it.
    val drawnStyle = if (text.checkbox == null) {
        style
    } else {
        style.copy(textIndent = with(density) { TextIndent(firstLine = (CHECKBOX_INDENT.toSp().value + style.fontSize.value * SPACE_WIDTH).sp) })
    }
    val requester = remember { BringIntoViewRequester() }
    if (text.firstReferences.isNotEmpty()) {
        DisposableEffect(text, actions) {
            val registered = text.firstReferences.map { (number, offset) ->
                val bringIntoView: suspend () -> Unit = { layout?.let { requester.bringIntoView(buildLineRect(it, offset)) } }
                FootnoteTarget.Reference(number).also { actions.navigator.register(it, bringIntoView) } to bringIntoView
            }
            onDispose { registered.forEach { (target, bringIntoView) -> actions.navigator.unregister(target, bringIntoView) } }
        }
    }
    val inlineContent = remember(text, style) {
        text.backLinks.associate { number -> buildBackLinkId(number) to buildBackLink(number, style) }
    }
    BasicText(
        text.text,
        modifier
            .then(if (text.firstReferences.isEmpty()) Modifier else Modifier.bringIntoViewRequester(requester))
            .then(if (text.checkbox == null) Modifier else Modifier.semantics { stateDescription = if (text.checkbox) "Checked" else "Not checked" })
            .tapLinks(text.links) { layout }
            .drawBehind {
                val laidOut = layout ?: return@drawBehind
                drawCodeChips(laidOut, text.text, codeStyle)
                drawLinkUnderlines(laidOut, text.text, look.line, style.fontSize)
                text.checkbox?.let { drawCheckbox(laidOut, it, look) }
                decorate?.invoke(this, laidOut)
            },
        style = drawnStyle,
        onTextLayout = { layout = it },
        inlineContent = inlineContent,
    )
}

/** The tag of the ranges [drawLinkUnderlines] underlines, with [RAISED] as the value of a raised one. */
private const val UNDERLINE_TAG = "underline"

private const val RAISED = "raised"

/** A footnote reference's size, the browser's `font-size: smaller` on a `<sup>`. */
private const val SUPERSCRIPT_SIZE = 0.83f

/** What a copy of the text holds in place of a back link, the desktop's link text. */
private const val BACK_LINK = "↩"

private fun buildBackLinkId(number: Int) = "back-$number"

/**
 * Builds the back link of footnote [number]'s arrow: a hook, the desktop's "↩", in the colour
 * of [style]. The surrounding text underlines it and takes its taps, as for any link.
 *
 * It is drawn as inline content, so a screen reader reads it as "Back to reference 1", as the
 * desktop's `aria-label` does, rather than reading out the arrow. The arrow is drawn, not set in
 * type, because no bundled font has the character and the phone's fallback font draws it at a
 * size of its own.
 */
private fun buildBackLink(number: Int, style: TextStyle) =
    InlineTextContent(Placeholder(1.em, 1.em, PlaceholderVerticalAlign.TextCenter)) {
        Box(
            Modifier
                .fillMaxSize()
                .semantics { contentDescription = "Back to reference $number" }
                .drawBehind { drawBackArrow(style.color) },
        )
    }

/** Draws the back link's arrow, "↩", filling the square it is drawn in: a shaft pointing left that hooks up at its right end. */
private fun DrawScope.drawBackArrow(color: Color) {
    val side = size.minDimension
    val stroke = Stroke(side * 0.075f, cap = StrokeCap.Round, join = StrokeJoin.Round)
    val arrow = Path().apply {
        // The hook, from its top end, around to the shaft.
        moveTo(side * 0.56f, side * 0.3f)
        lineTo(side * 0.62f, side * 0.3f)
        cubicTo(side * 0.86f, side * 0.3f, side * 0.86f, side * 0.66f, side * 0.62f, side * 0.66f)
        lineTo(side * 0.14f, side * 0.66f)
        // The head.
        moveTo(side * 0.32f, side * 0.5f)
        lineTo(side * 0.14f, side * 0.66f)
        lineTo(side * 0.32f, side * 0.82f)
    }
    drawPath(arrow, color, style = stroke)
}

/** The underline's distance below the baseline, the desktop's `text-underline-offset: 3px`. */
private val UNDERLINE_OFFSET = 3.dp

private val UNDERLINE_THICKNESS = 1.dp

/**
 * Underlines every link in [text] in [color], one line per line of text the link covers. A raised
 * footnote reference in text of [fontSize] is underlined under its own raised baseline.
 */
private fun DrawScope.drawLinkUnderlines(layout: TextLayoutResult, text: AnnotatedString, color: Color, fontSize: TextUnit) {
    val thickness = UNDERLINE_THICKNESS.toPx()
    text.getStringAnnotations(UNDERLINE_TAG, 0, text.length).forEach { range ->
        val raise = if (range.item == RAISED) fontSize.toPx() * SUPERSCRIPT_SIZE * 0.5f else 0f
        forEachLineOfRange(layout, range.start, range.end) { left, right, line ->
            val y = layout.getLineBaseline(line) - raise + UNDERLINE_OFFSET.toPx()
            drawLine(color, Offset(left, y), Offset(right, y), thickness)
        }
    }
}

/**
 * The room a task box takes before the item's text: Chromium's checkbox, 13 px with a margin of
 * 4 px before it and 3 px after it.
 */
private val CHECKBOX_INDENT = 20.dp

private val CHECKBOX_SIZE = 13.dp

/** Bricolage Grotesque's space, as a fraction of the font size. */
private const val SPACE_WIDTH = 0.253f

/**
 * Draws a read-only task box in the first line's indent, [checked] or not, as Chromium draws a
 * disabled checkbox: a 13 dp box with 2 dp corners standing on the baseline, empty inside a
 * rim when it is not ticked, and filled with a tick when it is, in Chromium's greys.
 */
private fun DrawScope.drawCheckbox(layout: TextLayoutResult, checked: Boolean, look: MarkdownLook) {
    val box = CHECKBOX_SIZE.toPx()
    val start = 4.dp.toPx()
    val left = if (layoutDirection == LayoutDirection.Rtl) size.width - start - box else start
    val top = layout.firstBaseline - box
    val radius = CornerRadius(2.dp.toPx())
    val colors = look.checkbox
    if (!checked) {
        val stroke = 1.dp.toPx()
        drawRoundRect(colors.empty, Offset(left, top), Size(box, box), radius)
        drawRoundRect(colors.rim, Offset(left + stroke / 2, top + stroke / 2), Size(box - stroke, box - stroke), radius, Stroke(stroke))
        return
    }
    drawRoundRect(colors.fill, Offset(left, top), Size(box, box), radius)
    val tick = Path().apply {
        moveTo(left + box * 0.24f, top + box * 0.52f)
        lineTo(left + box * 0.42f, top + box * 0.7f)
        lineTo(left + box * 0.76f, top + box * 0.32f)
    }
    drawPath(tick, colors.tick, style = Stroke(1.6.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round))
}

/** Returns the box of the line that holds the character at [offset], the whole line high. */
private fun buildLineRect(layout: TextLayoutResult, offset: Int): Rect {
    val line = layout.getLineForOffset(offset)
    val box = layout.getBoundingBox(offset)
    return Rect(box.left, layout.getLineTop(line), box.right, layout.getLineBottom(line))
}

/**
 * Follows the link of [links] that a short tap lands on, in the text [layout] returns, and offers
 * each link to a screen reader as an action named by its label.
 *
 * Only a tap follows a link. A press held as long as a long press is left to the selection
 * around the message, which selects the word under it, so a long press never opens a link. The
 * press is never consumed, so the selection sees every press. Compose's own text links follow a
 * link at the end of any press, a long one too, which is why they are not used.
 */
private fun Modifier.tapLinks(links: List<TextLink>, layout: () -> TextLayoutResult?): Modifier {
    if (links.isEmpty()) return this
    return this
        .semantics { customActions = links.map { link -> CustomAccessibilityAction(link.label) { link.follow(); true } } }
        .pointerInput(links) {
            awaitEachGesture {
                val down = awaitFirstDown(requireUnconsumed = false)
                val laidOut = layout() ?: return@awaitEachGesture
                val link = links.firstOrNull { isOnLink(laidOut, it, down.position) } ?: return@awaitEachGesture
                val up = withTimeoutOrNull(viewConfiguration.longPressTimeoutMillis) { waitForUpOrCancellation() }
                if (up != null) {
                    up.consume()
                    link.follow()
                }
            }
        }
}

/** Checks whether [position] falls on the characters of [link], on any line it covers in [layout]. */
private fun isOnLink(layout: TextLayoutResult, link: TextLink, position: Offset): Boolean {
    var hit = false
    forEachLineOfRange(layout, link.start, link.end) { left, right, line ->
        if (position.x in left..right && position.y in layout.getLineTop(line)..layout.getLineBottom(line)) hit = true
    }
    return hit
}
