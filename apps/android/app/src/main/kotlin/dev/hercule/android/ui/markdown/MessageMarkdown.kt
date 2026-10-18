package dev.hercule.android.ui.markdown

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import dev.hercule.android.markdown.MarkdownDocument
import dev.hercule.android.markdown.parseMarkdown
import dev.hercule.android.markdown.splitStreamingText
import dev.hercule.android.ui.StreamingCaret
import kotlin.math.roundToInt

/**
 * Who wrote a message, which decides how its text is read as markdown and what it sits in, as
 * the desktop decides it (`Markdown` in messages.tsx and the thread's blocks):
 *
 * - [Agent] is the session's own agent: a single newline joins its lines, as CommonMark says,
 *   because that is what the agent meant, and its embedded HTML is read.
 * - [User] is the user: each newline the user typed is a line break, and every HTML tag shows
 *   as typed, so `<b>x</b>` reads `<b>x</b>`.
 * - [AnotherAgent] is another session's agent, which sent the message into the thread: its
 *   newlines are breaks, as in any message sent in, and its embedded HTML is read, as an agent's is.
 */
enum class MessageAuthor(val breaks: Boolean, val embeddedHtml: Boolean, val container: MarkdownContainer) {
    Agent(breaks = false, embeddedHtml = true, MarkdownContainer.AgentMessage),
    User(breaks = true, embeddedHtml = false, MarkdownContainer.Bubble),
    AnotherAgent(breaks = true, embeddedHtml = true, MarkdownContainer.Bubble),
}

/**
 * Parses [text] by the rules of its [author]. This is the one place a message is parsed, so the
 * cost of parsing can be measured here.
 */
internal fun parseMessage(text: String, author: MessageAuthor): MarkdownDocument =
    parseMarkdown(text, breaks = author.breaks, embeddedHtml = author.embeddedHtml)

/**
 * Draws the [text] of a message by [author] as markdown, which the user can select and copy.
 *
 * While the agent is still [writing] it, the text is drawn in two parts, as the desktop draws it
 * (spec 17, the thread's transcript):
 *
 * - its finished paragraphs, as markdown;
 * - the paragraph being written, as plain text, ending in a caret of [caret]'s colour when given.
 *
 * A paragraph is finished at a blank line outside a code block (`splitStreamingText`). The text
 * arrives cut anywhere, inside a word or a code block, and markdown drawn from a cut would end
 * its last paragraph there. The finished part is parsed again only when a paragraph finishes, so
 * a token that finishes none costs no parse and redraws only the paragraph being written. Both
 * parts come from the same text in the same composition, so no text is ever drawn twice or left
 * out for a frame. Once the message ends, its whole text is parsed.
 *
 * The details blocks the user opened are kept by their place in the document (see
 * MessageNavigation.kt), so they stay open while the message grows at its end, whether it is
 * still being written or has ended. When its text no longer starts with the text before, as when
 * the streamed words were dropped and the stored text took their place, or the finished text was
 * corrected or replaced, the ones the user opened shut again.
 *
 * The text of the message can be selected and copied. It holds only what the message says:
 * nothing is inserted for the padding of inline code or for the caret, which are drawn.
 */
@Composable
fun MessageMarkdown(text: String, author: MessageAuthor, modifier: Modifier = Modifier, writing: Boolean = false, caret: Color? = null) {
    val tracker = remember { MessageTextTracker() }
    val parts = remember(text, writing) { tracker.read(text, writing) }
    val document = remember(parts.source, author) { parseMessage(parts.source, author) }
    val look = readMarkdownLook()
    SelectionContainer(modifier) {
        Column {
            val hasBlocks = document.blocks.isNotEmpty() || document.footnotes.isNotEmpty()
            key(parts.resets) {
                if (hasBlocks) Markdown(document, container = author.container)
            }
            val open = parts.open
            if (open != null && (open.isNotEmpty() || caret != null)) {
                if (hasBlocks) Spacer(Modifier.height(computeTrailingMargin(document, author.container)))
                OpenParagraph(open, look.body, caret)
            }
        }
    }
}

/**
 * Draws the paragraph the agent is still writing, [open], as the plain text it is so far, in
 * [style], ending in the streaming caret of [caret]'s colour when given.
 *
 * The caret is drawn, not set in the text, so a copy of the paragraph holds only its words. It
 * sits 3 dp after the last character, centred on the last line, the book's `.caret` with its
 * `margin-left: 3px`. When it does not fit at the end of that line, it starts a line of its
 * own, as the desktop's inline caret wraps. With no words yet, the caret stands alone on a line.
 */
@Composable
private fun OpenParagraph(open: String, style: TextStyle, caret: Color?) {
    if (caret == null) {
        BasicText(open, style = style)
        return
    }
    var textLayout by remember { mutableStateOf<TextLayoutResult?>(null) }
    Layout(
        content = {
            BasicText(open, style = style, onTextLayout = { textLayout = it })
            StreamingCaret(caret)
        },
    ) { measurables, constraints ->
        val text = measurables[0].measure(constraints.copy(minWidth = 0, minHeight = 0))
        val bar = measurables[1].measure(Constraints.fixed(CARET_WIDTH.roundToPx(), CARET_HEIGHT.roundToPx()))
        val gap = CARET_GAP.roundToPx()
        // The message's line height is a multiple of its font size, as CSS writes `line-height: 1.5`.
        val lineHeight = if (style.lineHeight.isEm) style.lineHeight.value * style.fontSize.toPx() else style.lineHeight.toPx()
        val laidOut = textLayout.takeIf { open.isNotEmpty() }
        val rightToLeft = layoutDirection == LayoutDirection.Rtl
        // Where the caret would go on the last line: its start edge, and the line's middle.
        var start: Int
        var middle: Float
        var height = text.height
        if (laidOut == null) {
            start = if (rightToLeft) constraints.maxWidth - bar.width else 0
            middle = lineHeight / 2f
            height = lineHeight.roundToInt()
        } else {
            val last = laidOut.lineCount - 1
            start = if (rightToLeft) laidOut.getLineLeft(last).roundToInt() - gap - bar.width else laidOut.getLineRight(last).roundToInt() + gap
            middle = (laidOut.getLineTop(last) + laidOut.getLineBottom(last)) / 2f
            if (start < 0 || start + bar.width > constraints.maxWidth) {
                start = if (rightToLeft) constraints.maxWidth - bar.width else 0
                middle = text.height + lineHeight / 2f
                height = (text.height + lineHeight).roundToInt()
            }
        }
        val width = maxOf(text.width, start + bar.width).coerceIn(constraints.minWidth, constraints.maxWidth)
        // The caret is centred on the text, from its ascent to its descent, as the book's inline
        // caret is; in Bricolage that middle sits 0.02 em above the middle of the line.
        val textMiddle = middle - style.fontSize.toPx() * TEXT_MIDDLE_ABOVE_LINE_MIDDLE
        layout(width, height) {
            text.placeRelative(0, 0)
            bar.place(start, (textMiddle - bar.height / 2f).roundToInt())
        }
    }
}

/** The book's `.caret`: 8 by 16, 3 dp after the last character. */
private val CARET_WIDTH = 8.dp
private val CARET_HEIGHT = 16.dp
private val CARET_GAP = 3.dp

/** How far the middle of Bricolage's text sits above the middle of its line, in em, measured. */
private const val TEXT_MIDDLE_ABOVE_LINE_MIDDLE = 0.02f

/** The text of a message to draw: what to parse, the paragraph being written, and how often the text was replaced. */
@Immutable
private class MessageParts(
    /** The text to parse: the finished paragraphs while the message is written, else the whole text. */
    val source: String,
    /** The paragraph being written, or null once the message has ended. */
    val open: String?,
    /** How many times the text stopped starting with the text before, which shuts its details blocks. */
    val resets: Int,
)

/**
 * Follows the text of one message as it changes, and splits it while the message is being
 * written. It keeps the text before, to tell growth from replacement, and the last finished
 * part, from which the next split starts, as `splitStreamingText` asks.
 */
private class MessageTextTracker {
    private var before: String? = null
    private var settled = ""
    private var resets = 0

    /**
     * Returns the parts of [text], the message's whole text so far, [writing] or ended. While
     * the text grows from the same start, a finished part of the same length is the same text,
     * and the same string instance is returned for it, so the parse keyed by it sees at once
     * that nothing changed.
     */
    fun read(text: String, writing: Boolean): MessageParts {
        val previous = before
        if (previous != null && !text.startsWith(previous)) {
            resets++
            settled = ""
        }
        before = text
        if (!writing) return MessageParts(text, open = null, resets)
        val split = splitStreamingText(text, settled)
        if (split.settled.length != settled.length || !split.settled.startsWith(settled)) settled = split.settled
        return MessageParts(settled, split.open, resets)
    }
}
