package dev.hercule.android.ui.markdown

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.widget.Toast
import androidx.compose.foundation.focusable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
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
import androidx.compose.ui.focus.onFocusChanged
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
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsPropertyReceiver
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.clearTextSubstitution
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.getTextLayoutResult
import androidx.compose.ui.semantics.isShowingTextSubstitution
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.setTextSubstitution
import androidx.compose.ui.semantics.showTextSubstitution
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.text
import androidx.compose.ui.semantics.textSubstitution
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
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
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import androidx.core.net.toUri
import dev.hercule.android.markdown.MarkdownInline
import dev.hercule.android.markdown.extractPlainText
import dev.hercule.android.theme.StrongWeight
import dev.hercule.android.ui.InlineCodeStyle
import dev.hercule.android.ui.appendCode
import dev.hercule.android.ui.bureauColors
import dev.hercule.android.ui.drawCodeChips
import dev.hercule.android.ui.forEachLineOfRange
import kotlin.math.roundToInt

/*
 * The text of one block: a paragraph, a heading, a summary or a table cell. Its inlines are
 * built into one AnnotatedString, drawn by one BasicText, as markdown.tsx draws them:
 *
 * - strong is bold, emphasis is italic, a deletion is struck through;
 * - inline code is a rounded chip (see CodeText.kt), padded by spacing its neighbours apart
 *   rather than by characters, so a selection never holds a character nobody wrote (see
 *   [makeRoomForChips]);
 * - a link is underlined in `--line`, 3 dp under the baseline, and only an http or https link
 *   opens, in the browser ([openLink]); see [LinkNode] for how a link is tapped, focused and
 *   read out;
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
    /** The links in [text], in reading order, footnote links among them. */
    val links: List<TextLink>,
    /** Whether [text] starts with inline code, whose padding the first line's indent makes room for. */
    val startsWithChip: Boolean = false,
)

/**
 * A link in a block's text, from [start] to [end]. [description] is what a screen reader reads
 * for it: its text, then its title when it has one, as a browser reads a link's `title`. [follow]
 * opens it or goes to its footnote target, and is null for a link that does nothing (see
 * [openLink]).
 */
internal class TextLink(val start: Int, val end: Int, val description: String, val follow: (() -> Unit)?)

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
 * Builds [inlines] into the text of one block, with inline code drawn by [codeStyle], padded by
 * [chipPadding] (see [makeRoomForChips]), and links that act through [actions].
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
    val chips = mutableListOf<IntRange>()
    val leading = inlines.firstOrNull() as? MarkdownInline.Checkbox
    val text = buildAnnotatedString {
        fun appendLink(href: String, name: String, title: String?, append: () -> Unit) {
            val start = length
            append()
            addStringAnnotation(UNDERLINE_TAG, "", start, length)
            val follow = if (isWebAddress(href)) ({ actions.openLink(href) }) else null
            links += TextLink(start, length, if (title.isNullOrEmpty()) name else "$name, $title", follow)
        }
        fun appendInlines(children: List<MarkdownInline>) {
            children.forEach { inline ->
                when (inline) {
                    is MarkdownInline.Text -> append(inline.text)
                    is MarkdownInline.Strong -> withStyle(SpanStyle(fontWeight = StrongWeight)) { appendInlines(inline.children) }
                    is MarkdownInline.Emphasis -> withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { appendInlines(inline.children) }
                    is MarkdownInline.Strikethrough ->
                        withStyle(SpanStyle(textDecoration = TextDecoration.LineThrough)) { appendInlines(inline.children) }
                    is MarkdownInline.InlineCode -> {
                        val start = length
                        appendCode(inline.text, codeStyle, paddingSize = null)
                        chips += start until length
                    }
                    MarkdownInline.Break -> append('\n')
                    is MarkdownInline.Link -> appendLink(inline.href, extractPlainText(inline.children), inline.title) { appendInlines(inline.children) }
                    is MarkdownInline.Image -> {
                        val name = inline.alt.ifEmpty { inline.src }
                        if (inline.src.isEmpty()) append(inline.alt) else appendLink(inline.src, name, inline.title) { append(name) }
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
    return BlockText(makeRoomForChips(text, chips, chipPadding), leading?.checked, firstReferences, backLinks, links, startsWithChip = chips.firstOrNull()?.first == 0)
}

/**
 * Returns [text] with room made for the padding of each of its code [chips] (the ranges of
 * their characters): [padding] on each side, as the book's `padding: 1px 5px`, taken from the
 * characters beside the chip rather than from characters added to the text.
 *
 * A letter spacing on a character puts half of it before the character and half after it, and
 * none at the start of a line. Spacing is added up per character, and only where a character
 * has ink does its place show, so a space can take any spacing. For each side of a chip:
 *
 * - When the character beside it is a space, that space gets [padding]: the chip, or the text
 *   after it, moves by [padding], and the gap between the chip's box and the next word stays
 *   one space wide, exactly as the desktop draws it.
 * - When it is another character, such as a comma or a bracket, that character gets twice
 *   [padding], half of which pads the chip, and the space on its far side gets minus [padding],
 *   which takes the other half back. Without a space there, as in "`a`).", the far side of the
 *   character keeps [padding] more room than on the desktop.
 * - A chip that starts the text gets its room from the first line's indent
 *   ([BlockText.startsWithChip]), and one that ends it needs none.
 *
 * A chip that starts or ends a wrapped line has no room on that side, as the spacing of a space
 * at a line's edge is not drawn: its box reaches [padding] past the line's edge.
 */
private fun makeRoomForChips(text: AnnotatedString, chips: List<IntRange>, padding: TextUnit): AnnotatedString {
    if (chips.isEmpty()) return text
    val spacing = HashMap<Int, Float>()
    fun add(index: Int, amount: Float) = spacing.merge(index, amount, Float::plus)
    // Makes room on one side of a chip from the character at [beside], with [far] the index of
    // the character past it, away from the chip.
    fun makeRoom(beside: Int, far: Int) {
        if (text[beside].isWhitespace()) {
            add(beside, padding.value)
            return
        }
        add(beside, padding.value * 2)
        if (far in text.indices && text[far].isWhitespace()) add(far, -padding.value)
    }
    chips.forEach { chip ->
        if (chip.first > 0) makeRoom(chip.first - 1, chip.first - 2)
        if (chip.last + 1 < text.length) makeRoom(chip.last + 1, chip.last + 2)
    }
    return AnnotatedString.Builder(text).apply {
        spacing.forEach { (index, amount) -> if (amount != 0f) addStyle(SpanStyle(letterSpacing = amount.sp), index, index + 1) }
    }.toAnnotatedString()
}

/** Returns the padding of a message's code chips in [codeStyle], in sp, for [buildBlockText]. */
@Composable
internal fun rememberChipPadding(codeStyle: InlineCodeStyle): TextUnit {
    val density = LocalDensity.current
    return remember(density, codeStyle.padding) { with(density) { codeStyle.padding.toSp() } }
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
    val chipPadding = rememberChipPadding(codeStyle)
    // The desktop draws a space between a task box and the item's text, and a chip that starts
    // the text has its padding before it. Both are part of the indent here, so the text holds
    // no character for them.
    val boxIndent = if (text.checkbox == null) 0f else with(density) { CHECKBOX_INDENT.toSp().value } + style.fontSize.value * SPACE_WIDTH
    val chipIndent = if (text.startsWithChip) chipPadding.value else 0f
    val drawnStyle = if (boxIndent + chipIndent == 0f) style else style.copy(textIndent = TextIndent(firstLine = (boxIndent + chipIndent).sp))
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
    val inlineContent = remember(text, style) { text.backLinks.associate { number -> buildBackLinkId(number) to buildBackLink(style) } }
    val semanticText = remember(text) { buildSemanticText(text) }
    val translation = remember { TextTranslation() }
    Box(modifier) {
        BasicText(
            translation.shown ?: text.text,
            Modifier
                .then(if (text.firstReferences.isEmpty()) Modifier else Modifier.bringIntoViewRequester(requester))
                // The text is read out with its links marked as links, which TalkBack's link
                // navigation moves between; the inline content inside it is read through the
                // link nodes below rather than on its own. The semantics a text has of its own
                // are replaced, so the translation actions Android's text translation uses are
                // given again.
                .clearAndSetSemantics {
                    this.text = semanticText
                    text.checkbox?.let { stateDescription = if (it) "Checked" else "Not checked" }
                    getTextLayoutResult { results -> layout?.let { results += it } != null }
                    translation.describe(this)
                }
                .tapLinks(text.links) { layout }
                .drawBehind {
                    // A translation is drawn as plain text: the chips and links belong to the original.
                    if (translation.shown != null) return@drawBehind
                    val laidOut = layout ?: return@drawBehind
                    drawCodeChips(laidOut, text.text, codeStyle, outset = chipPadding.toPx())
                    drawLinkUnderlines(laidOut, text.text, look.line, style.fontSize)
                    text.checkbox?.let { drawCheckbox(laidOut, it, look) }
                    decorate?.invoke(this, laidOut)
                },
            style = drawnStyle,
            onTextLayout = { layout = it },
            inlineContent = inlineContent,
        )
        if (translation.shown == null) layout?.let { laidOut -> text.links.forEach { LinkNode(it, laidOut) } }
    }
}

/**
 * Returns the text a screen reader is given for [text]: the same characters, with each link
 * marked as a link that follows it, so TalkBack lists the links and opens one as a tap would.
 */
private fun buildSemanticText(text: BlockText): AnnotatedString {
    if (text.links.isEmpty()) return text.text
    return AnnotatedString.Builder(text.text).apply {
        text.links.forEachIndexed { index, link -> addLink(LinkAnnotation.Clickable("link-$index") { link.follow?.invoke() }, link.start, link.end) }
    }.toAnnotatedString()
}

/**
 * Draws the node of one [link] over its characters in [layout]: what a screen reader focuses
 * and reads, by the link's description, and what the keyboard focuses with Tab and follows with
 * Enter. While it has focus, it rings each line's piece of the link, and it draws nothing else.
 *
 * A link broken over lines has one piece per line, and none takes in the text between them. The
 * node itself lies over the first piece, where a screen reader's focus starts.
 *
 * The node takes no touch: a tap on the link reaches the text, which follows it ([tapLinks]),
 * and a long press reaches the selection around the message, which selects the word. Compose's
 * own links in a text take every press on them, so a long press there opens the link and never
 * selects; that is why the links are drawn this way.
 */
@Composable
private fun LinkNode(link: TextLink, layout: TextLayoutResult) {
    val pieces = remember(layout, link) { listLinkPieces(layout, link) }
    val first = pieces.firstOrNull() ?: return
    var focused by remember { mutableStateOf(false) }
    val focusColor = bureauColors.focus
    val density = LocalDensity.current
    Box(
        Modifier
            .offset { IntOffset(first.left.roundToInt(), first.top.roundToInt()) }
            .size(with(density) { first.width.toDp() }, with(density) { first.height.toDp() })
            .onFocusChanged { focused = it.isFocused }
            .semantics {
                contentDescription = link.description
                link.follow?.let { follow -> onClick { follow(); true } }
            }
            .onKeyEvent { event ->
                val follow = link.follow
                val confirms = event.key == Key.Enter || event.key == Key.NumPadEnter || event.key == Key.DirectionCenter
                if (follow != null && confirms && event.type == KeyEventType.KeyUp) {
                    follow()
                    true
                } else {
                    false
                }
            }
            .focusable()
            .drawBehind {
                if (!focused) return@drawBehind
                pieces.forEach { piece ->
                    drawRoundRect(
                        focusColor,
                        topLeft = Offset(piece.left - first.left, piece.top - first.top),
                        size = piece.size,
                        cornerRadius = CornerRadius(3.dp.toPx()),
                        style = Stroke(2.dp.toPx()),
                    )
                }
            },
    )
}

/** Returns the box of each line's piece of [link] in [layout], in reading order. */
private fun listLinkPieces(layout: TextLayoutResult, link: TextLink): List<Rect> = buildList {
    forEachLineOfRange(layout, link.start, link.end) { left, right, line -> add(Rect(left, layout.getLineTop(line), right, layout.getLineBottom(line))) }
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
 * Builds the arrow of a footnote's back link: a hook, the desktop's "↩", in the colour of
 * [style]. The surrounding text underlines it and takes its taps, and its link node names it
 * "Back to reference 1" for a screen reader, as the desktop's `aria-label` does. The arrow is
 * drawn, not set in type, because no bundled font has the character and the phone's fallback
 * font draws it at a size of its own.
 */
private fun buildBackLink(style: TextStyle) =
    InlineTextContent(Placeholder(1.em, 1.em, PlaceholderVerticalAlign.TextCenter)) {
        Box(Modifier.fillMaxSize().drawBehind { drawBackArrow(style.color) })
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
 * Follows the link of [links] that a short tap lands on, in the text [layout] returns.
 *
 * Only a tap follows a link. A press held as long as a long press is left to the selection
 * around the message, which selects the word under it, so a long press never opens a link. The
 * press is never consumed, so the selection sees every press.
 */
private fun Modifier.tapLinks(links: List<TextLink>, layout: () -> TextLayoutResult?): Modifier {
    val followed = links.filter { it.follow != null }
    if (followed.isEmpty()) return this
    return this
        .pointerInput(followed) {
            awaitEachGesture {
                val down = awaitFirstDown(requireUnconsumed = false)
                val laidOut = layout() ?: return@awaitEachGesture
                val link = followed.firstOrNull { isOnLink(laidOut, it, down.position) } ?: return@awaitEachGesture
                val up = withTimeoutOrNull(viewConfiguration.longPressTimeoutMillis) { waitForUpOrCancellation() }
                if (up != null) {
                    up.consume()
                    link.follow?.invoke()
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

/**
 * The translation Android's text translation shows in place of a block's text, which a text's
 * own semantics would take care of. The block replaces those semantics, so it gives the same
 * three actions again: set a translation, show it or the original, and clear it.
 */
@Stable
private class TextTranslation {
    private var substitution by mutableStateOf<AnnotatedString?>(null)
    private var showing by mutableStateOf(false)

    /** The translation to draw in place of the text, or null to draw the text. */
    val shown: AnnotatedString? get() = substitution.takeIf { showing }

    /** Gives [receiver] the translation's state and its three actions. */
    fun describe(receiver: SemanticsPropertyReceiver) = with(receiver) {
        substitution?.let {
            textSubstitution = it
            isShowingTextSubstitution = showing
        }
        setTextSubstitution { translated ->
            substitution = translated
            true
        }
        showTextSubstitution { show ->
            if (substitution == null) return@showTextSubstitution false
            showing = show
            true
        }
        clearTextSubstitution {
            substitution = null
            showing = false
            true
        }
    }
}
