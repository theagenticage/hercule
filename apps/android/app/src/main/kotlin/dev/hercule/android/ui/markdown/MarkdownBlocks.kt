package dev.hercule.android.ui.markdown

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.wrapContentWidth
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.selection.DisableSelection
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextIndent
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import dev.hercule.android.markdown.MarkdownBlock
import dev.hercule.android.markdown.MarkdownDocument
import dev.hercule.android.markdown.MarkdownFootnote
import dev.hercule.android.markdown.MarkdownInline
import dev.hercule.android.markdown.MarkdownListItem
import dev.hercule.android.ui.rememberChipPaddingSize

/*
 * Draws a parsed message, as the desktop's markdown.tsx draws its tree with markdown.css. The
 * sizes and how margins collapse are in MarkdownLook.kt; the text of each block in
 * MarkdownText.kt; tables in MarkdownTable.kt.
 *
 * Every block is its own composable, called with values Compose compares, so a block whose
 * part of the tree is equal to what it drew before is skipped: a message re-parsed because a
 * paragraph settled redraws only the new paragraph.
 */

/**
 * What a message's markdown sits in, whose rules differ:
 *
 * - [AgentMessage] is the book's `.msg-body`, an agent's message. Its `p:last-child` rule leaves
 *   no margin under a paragraph that ends its list item, quote or details block, so the items
 *   of a loose list sit as close as those of a tight one.
 * - [Bubble] is the book's `.bubble`, a message sent into the session, which has no such rule.
 */
enum class MarkdownContainer { AgentMessage, Bubble }

/** Everything a block of one message needs besides its part of the tree. */
private class MessageScope(
    val look: MarkdownLook,
    val details: DetailsState,
    val actions: MarkdownActions,
    val flushLastParagraph: Boolean,
)

/**
 * Draws [document]: its blocks, then the footnotes they reference, in a muted section under them,
 * by the rules of its [container].
 *
 * Details blocks start shut, and the ones the user opens stay open while the row is on screen
 * and after it scrolls away and back, as long as each keeps its place in the document. Footnote
 * links bring their targets into view within the list around the message.
 *
 * The last block's own bottom margin is left out, by the desktop's `> :last-child` rule; what
 * the blocks inside it leave below them stays (see [computeEndMargin]).
 */
@Composable
fun Markdown(document: MarkdownDocument, modifier: Modifier = Modifier, container: MarkdownContainer = MarkdownContainer.AgentMessage) {
    val look = readMarkdownLook()
    val details = rememberSaveable(saver = DetailsState.Saver) { DetailsState() }
    val coroutineScope = rememberCoroutineScope()
    val navigator = remember(details) { FootnoteNavigator(coroutineScope, details) }
    val referenceDetails = remember(document) { findReferenceDetails(document) }
    SideEffect { navigator.referenceDetails = referenceDetails }
    val context = LocalContext.current
    val actions = remember(context, navigator) { MarkdownActions(context, navigator) }
    val flushLastParagraph = container == MarkdownContainer.AgentMessage
    val scope = remember(look, details, actions, flushLastParagraph) { MessageScope(look, details, actions, flushLastParagraph) }
    Column(modifier) {
        val first = document.blocks.firstOrNull()
        // A heading that opens the message has no margin above it, by the desktop's
        // `> :is(h1, …):first-child` rule; any other block keeps its top margin.
        if (first != null && first !is MarkdownBlock.Heading) Spacer(Modifier.height(computeMargins(first, tight = false, inListItem = false, flushLastParagraph).top))
        BlockColumn(document.blocks, "", look.body, tight = false, inListItem = false, listDepth = 0, scope)
        val end = computeEndMargin(document, flushLastParagraph)
        if (end > 0.dp) Spacer(Modifier.height(end))
        if (document.footnotes.isNotEmpty()) {
            val above = document.blocks.lastOrNull()?.let { computeMargins(it, tight = false, inListItem = false, flushLastParagraph).bottom } ?: 0.dp
            Spacer(Modifier.height(above))
            FootnoteSection(document.footnotes, scope)
        }
    }
}

/**
 * Returns the space under the last thing [document] draws, which the text after it, such as the
 * paragraph being written, starts below: the last block's bottom margin, or none under footnotes.
 */
internal fun computeTrailingMargin(document: MarkdownDocument, container: MarkdownContainer): Dp {
    val last = document.blocks.lastOrNull()
    if (document.footnotes.isNotEmpty() || last == null) return 0.dp
    return computeMargins(last, tight = false, inListItem = false, container == MarkdownContainer.AgentMessage).bottom
}

/**
 * Returns the space under a message's last block, as the desktop leaves it. The last block's own
 * bottom margin is zero, by the `> :last-child` rule, but the message is a grid item, which
 * holds the margins of what it contains: the bottom margin of the last block's own last block
 * collapses through it and stays inside the message. So a quote that ends in a list or a code
 * block, or, in a bubble, a quote or a loose list that ends in a paragraph, leaves its margin
 * under the message. A message with footnotes ends in them, which leave none.
 */
internal fun computeEndMargin(document: MarkdownDocument, flushLastParagraph: Boolean): Dp {
    if (document.footnotes.isNotEmpty()) return 0.dp
    return when (val last = document.blocks.lastOrNull()) {
        is MarkdownBlock.Blockquote -> {
            val child = last.children.lastOrNull()
            if (child == null || (flushLastParagraph && child is MarkdownBlock.Paragraph)) 0.dp
            else computeBottomMargin(child, tight = false, inListItem = false, flushLastParagraph)
        }
        is MarkdownBlock.List -> last.items.lastOrNull()?.let { computeItemBottomMargin(it, !last.loose, flushLastParagraph) } ?: 0.dp
        else -> 0.dp
    }
}

/** The space a block asks for above and below it, after the margins of what it holds collapsed into it. */
internal data class Margins(val top: Dp, val bottom: Dp)

/**
 * Returns [block]'s margins as markdown.css gives them, collapsed as CSS collapses them:
 *
 * - a paragraph has 10 dp below it, or none in a [tight] list, where it is bare text;
 * - a heading has 16 dp above and 6 dp below;
 * - a list, a quote, a table and a details block have 10 dp below; a list directly inside a
 *   list item ([inListItem]) has none, by the desktop's `li > :is(ul, ol)` rule;
 * - a code block has 8 dp above and below, and a rule 14 dp;
 * - a quote and a list have no padding above or below, so their first child's top margin and
 *   their last child's bottom margin collapse through them;
 * - with [flushLastParagraph], a paragraph that ends its list item has no margin below it, by the
 *   book's `.msg-body p:last-child` rule (see [MarkdownContainer]). The rule reaches the last
 *   paragraph of a quote or a details block too, but there it changes nothing: the quote's own
 *   margin is as large, and a details block drops its last margin anyway.
 */
internal fun computeMargins(block: MarkdownBlock, tight: Boolean, inListItem: Boolean, flushLastParagraph: Boolean): Margins =
    Margins(computeTopMargin(block, tight), computeBottomMargin(block, tight, inListItem, flushLastParagraph))

// The top and the bottom margin are worked out apart, because a container's top margin follows
// only its first child and its bottom margin only its last: each walks one path down the tree,
// so a message nested a hundred deep costs a hundred steps, not two to the hundredth.

/** Returns [block]'s top margin, by the rules of [computeMargins]. */
private fun computeTopMargin(block: MarkdownBlock, tight: Boolean): Dp = when (block) {
    is MarkdownBlock.Paragraph, is MarkdownBlock.Table, is MarkdownBlock.Details -> 0.dp
    is MarkdownBlock.Heading -> 16.dp
    is MarkdownBlock.Code -> 8.dp
    MarkdownBlock.Rule -> 14.dp
    is MarkdownBlock.Blockquote -> block.children.firstOrNull()?.let { computeTopMargin(it, tight = false) } ?: 0.dp
    is MarkdownBlock.List -> block.items.firstOrNull()?.children?.firstOrNull()?.let { computeTopMargin(it, !block.loose) } ?: 0.dp
}

/** Returns [block]'s bottom margin, by the rules of [computeMargins]. */
private fun computeBottomMargin(block: MarkdownBlock, tight: Boolean, inListItem: Boolean, flushLastParagraph: Boolean): Dp = when (block) {
    is MarkdownBlock.Paragraph -> if (tight) 0.dp else 10.dp
    is MarkdownBlock.Heading -> 6.dp
    is MarkdownBlock.Code -> 8.dp
    MarkdownBlock.Rule -> 14.dp
    is MarkdownBlock.Table, is MarkdownBlock.Details -> 10.dp
    is MarkdownBlock.Blockquote ->
        maxOf(10.dp, block.children.lastOrNull()?.let { computeBottomMargin(it, tight = false, inListItem = false, flushLastParagraph) } ?: 0.dp)
    is MarkdownBlock.List -> {
        val last = block.items.lastOrNull()?.let { computeItemBottomMargin(it, !block.loose, flushLastParagraph) } ?: 0.dp
        maxOf(if (inListItem) 0.dp else 10.dp, last)
    }
}

/**
 * Returns the margins a list [item] passes out to its neighbours: its first block's top margin
 * and its last block's bottom margin, which collapse through the item. [tight] and
 * [flushLastParagraph] are as [computeMargins] has them.
 */
internal fun computeItemMargins(item: MarkdownListItem, tight: Boolean, flushLastParagraph: Boolean): Margins =
    Margins(item.children.firstOrNull()?.let { computeTopMargin(it, tight) } ?: 0.dp, computeItemBottomMargin(item, tight, flushLastParagraph))

/** Returns the bottom margin of [item]'s last block, which is none for a paragraph with [flushLastParagraph]. */
private fun computeItemBottomMargin(item: MarkdownListItem, tight: Boolean, flushLastParagraph: Boolean): Dp {
    val last = item.children.lastOrNull() ?: return 0.dp
    return if (flushLastParagraph && last is MarkdownBlock.Paragraph) 0.dp else computeBottomMargin(last, tight, inListItem = true, flushLastParagraph)
}

/**
 * Draws [blocks] one under the other, each as far below the one before as the larger of the two
 * margins between them. The first block's top margin and the last block's bottom margin are left
 * to the caller, which collapses them with its own.
 *
 * [parent] is the path of the block that holds them; [style] is the text style they inherit;
 * [tight], [inListItem] and [listDepth] say whether they are the children of a list item, of
 * which kind, and how many lists are around them.
 */
@Composable
private fun BlockColumn(
    blocks: List<MarkdownBlock>,
    parent: String,
    style: TextStyle,
    tight: Boolean,
    inListItem: Boolean,
    listDepth: Int,
    scope: MessageScope,
) {
    Column {
        var previous: Margins? = null
        blocks.forEachIndexed { index, block ->
            val margins = computeMargins(block, tight, inListItem, scope.flushLastParagraph)
            previous?.let { Spacer(Modifier.height(maxOf(it.bottom, margins.top))) }
            previous = margins
            Block(block, buildChildPath(parent, index), style, tight, listDepth, scope)
        }
    }
}

/** Draws one [block] at [path], in [style]. [tight] and [listDepth] are as [BlockColumn] has them. */
@Composable
private fun Block(block: MarkdownBlock, path: String, style: TextStyle, tight: Boolean, listDepth: Int, scope: MessageScope) {
    when (block) {
        is MarkdownBlock.Paragraph -> InlineBlock(block.children, style, scope)
        is MarkdownBlock.Heading -> InlineBlock(block.children, buildHeadingStyle(style.color), scope)
        is MarkdownBlock.List -> ListBlock(block, path, style, listDepth, scope)
        is MarkdownBlock.Blockquote -> {
            val line = scope.look.line
            Box(
                Modifier
                    .fillMaxWidth()
                    // The desktop's `box-shadow: inset 2px 0 0 var(--line)`, at the start edge.
                    .drawBehind {
                        val left = if (layoutDirection == LayoutDirection.Rtl) size.width - 2.dp.toPx() else 0f
                        drawRect(line, Offset(left, 0f), Size(2.dp.toPx(), size.height))
                    }
                    .padding(start = 12.dp),
            ) {
                BlockColumn(block.children, path, style.copy(color = scope.look.muted), tight = false, inListItem = false, listDepth, scope)
            }
        }
        is MarkdownBlock.Code -> CodeBlock(block.text, scope.look)
        is MarkdownBlock.Table -> MarkdownTable(block, style, scope.look, scope.actions)
        MarkdownBlock.Rule -> Box(Modifier.fillMaxWidth().height(1.dp).background(scope.look.lineSoft))
        is MarkdownBlock.Details -> DetailsBlock(block, path, style, listDepth, scope)
    }
}

/** Draws a run of [inlines] as one block of text in [style]: a paragraph or a heading. */
@Composable
private fun InlineBlock(inlines: List<MarkdownInline>, style: TextStyle, scope: MessageScope, modifier: Modifier = Modifier, decorate: (DrawScope.(TextLayoutResult) -> Unit)? = null) {
    val codeStyle = scope.look.buildCodeStyle(style.color)
    val chipPadding = rememberChipPaddingSize(codeStyle)
    val text = remember(inlines, codeStyle, chipPadding, scope.actions) { buildBlockText(inlines, codeStyle, chipPadding, scope.actions) }
    MarkdownText(text, style, scope.look, scope.actions, modifier, decorate = decorate)
}

/**
 * Draws a code block, the book's phone `.codeblock`: its text exactly as written, in Recursive,
 * on the sunken colour inside a hairline, scrolling sideways when a line is too long.
 */
@Composable
private fun CodeBlock(code: String, look: MarkdownLook) {
    val shape = RoundedCornerShape(12.dp)
    Box(
        Modifier
            .fillMaxWidth()
            .background(look.sunken, shape)
            .border(1.dp, look.lineSoft, shape)
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = 12.dp, vertical = 10.dp),
    ) {
        val text = remember(code) { AnnotatedString(code) }
        BasicText(text, Modifier.registerForCopy(text), style = look.codeBlock, softWrap = false)
    }
}

/**
 * Draws a list: each item's marker in a 22 dp column before it, and the item's blocks beside
 * it. A bulleted list's marker is a disc, inside another list a circle, and deeper a square,
 * as a browser draws them; a numbered list counts up from its start.
 */
@Composable
private fun ListBlock(list: MarkdownBlock.List, path: String, style: TextStyle, listDepth: Int, scope: MessageScope) {
    Column {
        var previousBottom: Dp? = null
        list.items.forEachIndexed { index, item ->
            val tight = !list.loose
            val margins = computeItemMargins(item, tight, scope.flushLastParagraph)
            previousBottom?.let { Spacer(Modifier.height(maxOf(it, margins.top))) }
            previousBottom = margins.bottom
            val itemPath = buildChildPath(path, index)
            ListItemRow(
                marker = { modifier ->
                    val start = list.start
                    if (start == null) BulletMarker(listDepth, style, modifier) else NumberMarker(start + index, style, modifier)
                },
            ) { modifier ->
                Box(modifier) {
                    BlockColumn(item.children, itemPath, style, tight, inListItem = true, listDepth + 1, scope)
                }
            }
        }
    }
}

/**
 * Lays out one list item: [marker] in the 22 dp indent, on the baseline of the item's first
 * line, and [content] beside it. The marker is left out of a selection, as a browser leaves a
 * list's markers out of copied text.
 */
@Composable
private fun ListItemRow(marker: @Composable (Modifier) -> Unit, content: @Composable (Modifier) -> Unit) {
    Row(Modifier.fillMaxWidth()) {
        DisableSelection { marker(Modifier.alignByBaseline().width(LIST_INDENT)) }
        content(Modifier.alignByBaseline().weight(1f))
    }
}

/** The indent of a list's items, the desktop's `padding-left: 22px`. */
private val LIST_INDENT = 22.dp

/**
 * Draws the number marker "[number]." at the end of the list's indent, a space's width before
 * the item's text, as a browser draws an outside marker. A number too wide for the indent
 * reaches out to its start.
 */
@Composable
private fun NumberMarker(number: Int, style: TextStyle, modifier: Modifier) {
    Box(modifier, contentAlignment = Alignment.TopEnd) {
        BasicText("$number.", Modifier.wrapContentWidth(Alignment.End, unbounded = true).padding(end = MARKER_GAP), style = style)
    }
}

/**
 * Draws a bullet marker for a list inside [listDepth] other lists: a disc, a circle or a square,
 * as Chromium draws them, 5 dp across with its middle 14 dp before the item's text. The marker
 * is drawn on an empty line of [style], so its baseline lines up with the item's first line.
 */
@Composable
private fun BulletMarker(listDepth: Int, style: TextStyle, modifier: Modifier) {
    var layout by remember { mutableStateOf<TextLayoutResult?>(null) }
    val color = style.color
    BasicText(
        "\u00A0",
        modifier.drawBehind {
            val laidOut = layout ?: return@drawBehind
            val radius = BULLET_SIZE.toPx() / 2f
            val fromEnd = BULLET_CENTER_BEFORE_TEXT.toPx()
            val x = if (layoutDirection == LayoutDirection.Rtl) fromEnd else size.width - fromEnd
            val center = Offset(x, laidOut.firstBaseline - style.fontSize.toPx() * BULLET_RAISE)
            when (listDepth) {
                0 -> drawCircle(color, radius, center)
                1 -> drawCircle(color, radius - 0.5.dp.toPx(), center, style = Stroke(1.dp.toPx()))
                else -> drawRect(color, Offset(center.x - radius, center.y - radius), Size(radius * 2, radius * 2))
            }
        },
        style = style,
        onTextLayout = { layout = it },
    )
}

/** The gap between a number marker and the item's text: a space at 15 sp. */
private val MARKER_GAP = 4.dp

/** A bullet's size, and where its middle sits: before the item's text, and above the baseline as a fraction of the font size. */
private val BULLET_SIZE = 5.dp
private val BULLET_CENTER_BEFORE_TEXT = 14.dp
private const val BULLET_RAISE = 0.3f

/**
 * Draws a details block: its summary after a chevron, and once opened, its blocks under it,
 * indented 14 dp. A tap on the summary opens and shuts it. It starts shut, as the desktop's
 * native `<details>` does, and [DetailsState] keeps it open by its [path].
 */
@Composable
private fun DetailsBlock(block: MarkdownBlock.Details, path: String, style: TextStyle, listDepth: Int, scope: MessageScope) {
    val open = scope.details.isOpen(path)
    val summaryStyle = style.copy(color = scope.look.ink, textIndent = with(LocalDensity.current) { TextIndent(firstLine = CHEVRON_INDENT.toSp()) })
    val chevronColor = scope.look.faint
    Column {
        InlineBlock(
            block.summary,
            summaryStyle,
            scope,
            Modifier
                .fillMaxWidth()
                .clickable(role = Role.Button, onClickLabel = if (open) "Hide the details" else "Show the details") { scope.details.toggle(path) }
                .semantics { stateDescription = if (open) "Open" else "Shut" },
        ) { layout -> drawChevron(layout, open, chevronColor, style) }
        if (open && block.children.isNotEmpty()) {
            // The desktop's `details[open] > summary { margin-bottom: 8px }`, with the first
            // block's own top margin dropped.
            Spacer(Modifier.height(8.dp))
            Box(Modifier.padding(start = 14.dp)) {
                BlockColumn(block.children, path, style, tight = false, inListItem = false, listDepth, scope)
            }
        }
    }
}

/** The room the chevron takes before the summary: its 5 dp box and a 9 dp gap. */
private val CHEVRON_INDENT = 14.dp

/**
 * Draws a details block's chevron at the start of the summary's first line, as markdown.css
 * draws it: the right and bottom edges of a 5 dp square in 1.5 dp lines, turned to point right
 * when the block is shut and down when it is open, its bottom 0.12 em above the baseline. The
 * book sets `box-sizing: border-box`, so the square's 5 px include its borders.
 */
private fun DrawScope.drawChevron(layout: TextLayoutResult, open: Boolean, color: Color, style: TextStyle) {
    val box = 5.dp.toPx()
    val stroke = 1.5.dp.toPx()
    val left = if (layoutDirection == LayoutDirection.Rtl) size.width - box else 0f
    val bottom = layout.firstBaseline - 0.12f * style.fontSize.toPx() - if (open) 1.dp.toPx() else 0f
    val top = bottom - box
    rotate(if (open) 45f else -45f, Offset(left + box / 2f, top + box / 2f)) {
        val edge = box - stroke / 2f
        drawLine(color, Offset(left + edge, top), Offset(left + edge, top + box), stroke)
        drawLine(color, Offset(left, top + edge), Offset(left + box, top + edge), stroke)
    }
}

/**
 * Draws the footnotes under a message, as the desktop's `<section>`: a numbered list in 14 sp
 * muted text, each footnote a target its references lead to.
 */
@Composable
private fun FootnoteSection(footnotes: List<MarkdownFootnote>, scope: MessageScope) {
    val style = scope.look.small.copy(color = scope.look.muted)
    Column {
        var previousBottom: Dp? = null
        footnotes.forEach { footnote ->
            val top = footnote.children.firstOrNull()?.let { computeMargins(it, tight = false, inListItem = true, scope.flushLastParagraph).top } ?: 0.dp
            // The desktop's `section li > :last-child { margin-bottom: 0 }`.
            previousBottom?.let { Spacer(Modifier.height(maxOf(it, top))) }
            previousBottom = 0.dp
            FootnoteItem(footnote, style, scope)
        }
    }
}

/** Draws one footnote: its number and its blocks, registered as the target of its references. */
@Composable
private fun FootnoteItem(footnote: MarkdownFootnote, style: TextStyle, scope: MessageScope) {
    val requester = remember { BringIntoViewRequester() }
    val navigator = scope.actions.navigator
    DisposableEffect(footnote.number, navigator) {
        val target = FootnoteTarget.Note(footnote.number)
        val bringIntoView: suspend () -> Unit = { requester.bringIntoView() }
        navigator.register(target, bringIntoView)
        onDispose { navigator.unregister(target, bringIntoView) }
    }
    Box(Modifier.bringIntoViewRequester(requester)) {
        ListItemRow(marker = { modifier -> NumberMarker(footnote.number, style, modifier) }) { modifier ->
            Box(modifier) {
                BlockColumn(footnote.children, buildFootnotePath(footnote.number), style, tight = false, inListItem = true, listDepth = 1, scope)
            }
        }
    }
}
