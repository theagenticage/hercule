package dev.hercule.android.ui.markdown

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.text.selection.SelectionContainer
import android.content.ClipData
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.Clipboard
import androidx.compose.ui.platform.LocalClipboard
import dev.hercule.android.markdown.MarkdownDocument
import dev.hercule.android.markdown.parseMarkdown
import dev.hercule.android.markdown.splitStreamingText
import dev.hercule.android.ui.CodeText
import dev.hercule.android.ui.TextRun
import dev.hercule.android.ui.removeDrawnSpaces

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
 * The details blocks the user opened stay open while the message grows, because its finished
 * text only grows at its end. When the text no longer starts with the finished part, as when its
 * streamed words were dropped and the stored text replaced them, they are all shut again.
 */
@Composable
fun MessageMarkdown(text: String, author: MessageAuthor, modifier: Modifier = Modifier, writing: Boolean = false, caret: Color? = null) {
    val splitter = remember { StreamingSplitter() }
    val parts = if (writing) remember(text) { splitter.split(text) } else null
    val source = parts?.settled ?: text
    val document = remember(source, author) { parseMessage(source, author) }
    val look = readMarkdownLook()
    val clipboard = LocalClipboard.current
    val messageClipboard = remember(clipboard) { MessageClipboard(clipboard) }
    CompositionLocalProvider(LocalClipboard provides messageClipboard) {
        SelectionContainer(modifier) {
            Column {
                val hasBlocks = document.blocks.isNotEmpty() || document.footnotes.isNotEmpty()
                key(splitter.resets) {
                    if (hasBlocks) Markdown(document, container = author.container)
                }
                val open = parts?.open
                if (open != null && (open.isNotEmpty() || caret != null)) {
                    if (hasBlocks) Spacer(Modifier.height(computeTrailingMargin(document, author.container)))
                    val runs = remember(open) { listOf(TextRun(open, isCode = false)) }
                    CodeText(runs, look.body, look.buildCodeStyle(look.body.color), caret = caret)
                }
            }
        }
    }
}

/**
 * The clipboard a message's selection is copied to: [clipboard], given the copied text without
 * the padding that sets inline code apart and without the caret. Copying "Run `git push`" then
 * gives "Run git push", as on the desktop, rather than spaces around the command that a shell
 * would not take.
 */
private class MessageClipboard(private val clipboard: Clipboard) : Clipboard by clipboard {
    override suspend fun setClipEntry(clipEntry: ClipEntry?) {
        val data = clipEntry?.clipData
        val text = data?.takeIf { it.itemCount == 1 }?.getItemAt(0)?.text
        clipboard.setClipEntry(if (text == null) clipEntry else ClipEntry(ClipData.newPlainText(data.description.label, removeDrawnSpaces(text))))
    }
}

/** The text of a message the agent is still writing: its finished paragraphs, and the paragraph being written. */
@Immutable
private class MessageParts(val settled: String, val open: String)

/**
 * Splits the text of one message the agent is still writing as it grows. It keeps the last
 * finished part, from which the next split starts, as `splitStreamingText` asks.
 */
private class StreamingSplitter {
    private var settled = ""

    /** How many times the text stopped starting with the finished part, which drops what the message remembers. */
    var resets = 0
        private set

    /**
     * Splits [text], the message's whole text so far. While the text grows from the same start,
     * a finished part of the same length is the same text, and the same string instance is
     * returned for it, so the parse keyed by it sees at once that nothing changed.
     */
    fun split(text: String): MessageParts {
        val reset = !text.startsWith(settled)
        if (reset) resets++
        val split = splitStreamingText(text, settled)
        if (reset || split.settled.length != settled.length) settled = split.settled
        return MessageParts(settled, split.open)
    }
}
