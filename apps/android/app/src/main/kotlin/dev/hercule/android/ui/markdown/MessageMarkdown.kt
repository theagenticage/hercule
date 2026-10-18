package dev.hercule.android.ui.markdown

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.selection.DisableSelection
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalClipboard
import dev.hercule.android.markdown.MarkdownDocument
import dev.hercule.android.markdown.parseMarkdown
import dev.hercule.android.markdown.splitStreamingText
import dev.hercule.android.ui.CARET_ID
import dev.hercule.android.ui.buildCaret

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
 * The details blocks the user opened stay open while the message grows, whether it is still
 * being written or has ended, because then its text only grows at its end. When its text no
 * longer starts with the text before, as when the streamed words were dropped and the stored
 * text took their place, or the finished text was corrected or replaced, they all shut again.
 *
 * A copy of a selection in the message is written again as the text reads ([MessageCopy]).
 */
@Composable
fun MessageMarkdown(text: String, author: MessageAuthor, modifier: Modifier = Modifier, writing: Boolean = false, caret: Color? = null) {
    val tracker = remember { MessageTextTracker() }
    val parts = remember(text, writing) { tracker.read(text, writing) }
    val document = remember(parts.source, author) { parseMessage(parts.source, author) }
    val look = readMarkdownLook()
    val copy = remember { MessageCopy() }
    val clipboard = LocalClipboard.current
    val messageClipboard = remember(clipboard, copy) { MessageClipboard(clipboard, copy) }
    CompositionLocalProvider(LocalClipboard provides messageClipboard, LocalMessageCopy provides copy) {
        SelectionContainer(modifier) {
            Column(Modifier.onGloballyPositioned { copy.container = it }) {
                val hasBlocks = document.blocks.isNotEmpty() || document.footnotes.isNotEmpty()
                key(parts.resets) {
                    if (hasBlocks) Markdown(document, container = author.container)
                }
                val open = parts.open
                if (open != null && (open.isNotEmpty() || caret != null)) {
                    if (hasBlocks) Spacer(Modifier.height(computeTrailingMargin(document, author.container)))
                    OpenParagraph(open, look, caret)
                }
            }
        }
    }
}

/**
 * Draws the paragraph the agent is still writing, [open], as the plain text it is so far, in the
 * body text of [look], ending in the streaming caret of [caret]'s colour when given. A caret with
 * no text yet is drawn alone, and is left out of the selection, as there is nothing to select.
 */
@Composable
private fun OpenParagraph(open: String, look: MarkdownLook, caret: Color?) {
    val text = remember(open, caret != null) { buildOpenText(open, withCaret = caret != null) }
    val inlineContent = remember(caret) { if (caret == null) emptyMap() else mapOf(CARET_ID to buildCaret(caret)) }
    val paragraph = @Composable { BasicText(text.text, Modifier.registerForCopy(text.text), style = look.body, inlineContent = inlineContent) }
    if (open.isEmpty()) DisableSelection { paragraph() } else paragraph()
}

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
