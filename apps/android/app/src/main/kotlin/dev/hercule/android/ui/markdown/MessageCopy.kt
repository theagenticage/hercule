package dev.hercule.android.ui.markdown

import android.content.ClipData
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.Clipboard
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.toSize
import dev.hercule.android.ui.DRAWN_TAG

/*
 * What a copy of a message's selection holds. Compose copies a selection as the text of each
 * selected text node, the nodes in reading order, joined by newlines. That text holds what the
 * message draws but nobody wrote, the padding of inline code and the streaming caret, and it
 * joins a table's cells with newlines, where the desktop separates a row's cells with tabs.
 *
 * So the message keeps, for each of its text nodes, the text it draws and where it sits. A copy
 * is matched back to those texts: the part of the first text from some offset, the whole texts
 * after it, and the last text up to some offset. Once the match is known, the copy is written
 * again from the texts themselves:
 *
 * - each character tagged with [DRAWN_TAG] is left out, by its offset, so a character the agent
 *   wrote is never lost, whatever it is;
 * - two cells of one table row are joined by a tab, and anything else by a newline.
 *
 * A copy that matches no texts, or matches them in two ways that would read differently, is
 * left as Compose wrote it: it may then hold the padding, but it never loses a character.
 */

/** Where a table cell sits, so a copy can tell two cells of one row from anything else. */
internal class TableRowPlace(val table: Any, val row: Int) {
    override fun equals(other: Any?): Boolean = other is TableRowPlace && other.table === table && other.row == row

    override fun hashCode(): Int = System.identityHashCode(table) * 31 + row
}

/** One text node of a message: the [text] it draws, its [row] when it is a table cell, and where it sits. */
internal class CopySource(val text: AnnotatedString, val row: TableRowPlace?) {
    var coordinates: LayoutCoordinates? = null
}

/**
 * The text nodes of one message, for [rewriteCopy]. Each node registers while it is drawn. The
 * list is read only when the user copies, so it is plain data, not Compose state.
 */
@Stable
internal class MessageCopy {
    private val sources = mutableListOf<CopySource>()

    /** Where the message itself sits, which the nodes' places are measured from. */
    var container: LayoutCoordinates? = null

    fun register(source: CopySource) {
        sources += source
    }

    fun unregister(source: CopySource) {
        sources -= source
    }

    /**
     * Returns [copied], the text Compose copied from this message's selection, written again as
     * the text reads: without the characters the message only draws, and with a row's cells
     * joined by tabs. Returns [copied] itself when it cannot be matched back to the message.
     */
    fun rewriteCopy(copied: String): String {
        val container = container?.takeIf { it.isAttached } ?: return copied
        val placed = sources.mapNotNull { source ->
            source.coordinates?.takeIf { it.isAttached }?.let { source to Rect(container.localPositionOf(it, Offset.Zero), it.size.toSize()) }
        }
        val ordered = sortInReadingOrder(placed)
        val rewrites = findCopiedParts(copied, ordered.map { it.text.text }).map { parts -> writeParts(parts, ordered) }.distinct()
        return rewrites.singleOrNull() ?: copied
    }
}

/** The message's [MessageCopy], for the text nodes inside it to register with, or null outside a message. */
internal val LocalMessageCopy = staticCompositionLocalOf<MessageCopy?> { null }

/**
 * Registers the text node this modifier sits on, drawing [text], with the message around it,
 * and keeps its place up to date. [row] is its table row, when it is a cell.
 */
@Composable
internal fun Modifier.registerForCopy(text: AnnotatedString, row: TableRowPlace? = null): Modifier {
    val copy = LocalMessageCopy.current ?: return this
    val source = remember(text, row) { CopySource(text, row) }
    DisposableEffect(copy, source) {
        copy.register(source)
        onDispose { copy.unregister(source) }
    }
    return onGloballyPositioned { source.coordinates = it }
}

/**
 * Sorts [placed] text nodes in the order Compose's selection reads them (SelectionRegistrarImpl's
 * sort in Compose 1.12): two nodes that sit in one row are read from left to right, and any
 * other two from top to bottom.
 */
private fun sortInReadingOrder(placed: List<Pair<CopySource, Rect>>): List<CopySource> =
    placed.sortedWith { (_, a), (_, b) ->
        if (isInARow(a, b)) a.left.compareTo(b.left) else a.top.compareTo(b.top)
    }.map { it.first }

/**
 * Checks whether [a] and [b] sit in one row, as Compose's `inARow` decides it: they overlap
 * over at least half the height of one of them, and over less than half the width of each.
 */
private fun isInARow(a: Rect, b: Rect): Boolean {
    val verticalOverlap = maxOf(0f, minOf(a.bottom, b.bottom) - maxOf(a.top, b.top))
    val horizontalOverlap = maxOf(0f, minOf(a.right, b.right) - maxOf(a.left, b.left))
    val overlapsInHeight = verticalOverlap >= a.height * 0.5f || verticalOverlap >= b.height * 0.5f
    return overlapsInHeight && horizontalOverlap < a.width * 0.5f && horizontalOverlap < b.width * 0.5f
}

/** A part of a copy: the characters from [start] to [end] of the text of node [source]. */
private data class CopiedPart(val source: Int, val start: Int, val end: Int)

/**
 * Returns every way [copied] can be the copy of a selection over [texts], in reading order:
 * within one text, or from an offset in one text, through the whole texts after it, to an
 * offset in a later one, the texts joined by newlines.
 */
private fun findCopiedParts(copied: String, texts: List<String>): List<List<CopiedPart>> {
    val found = mutableListOf<List<CopiedPart>>()
    texts.forEachIndexed { first, text ->
        // Within one text.
        var at = text.indexOf(copied)
        while (at >= 0 && copied.isNotEmpty()) {
            found += listOf(CopiedPart(first, at, at + copied.length))
            at = text.indexOf(copied, at + 1)
        }
        // From an offset in this text to the end of it, then on through the texts after it.
        var newline = copied.indexOf('\n')
        while (newline >= 0) {
            val head = copied.substring(0, newline)
            if (text.endsWith(head)) {
                matchFollowingTexts(copied, newline + 1, texts, first + 1)?.let { rest -> found += listOf(CopiedPart(first, text.length - head.length, text.length)) + rest }
            }
            newline = copied.indexOf('\n', newline + 1)
        }
    }
    return found
}

/**
 * Matches the rest of [copied], from [from], to the texts from [next] on: whole texts each
 * followed by a newline, then the start of one more. Returns the parts, or null when they do
 * not match.
 */
private fun matchFollowingTexts(copied: String, from: Int, texts: List<String>, next: Int): List<CopiedPart>? {
    var at = from
    val parts = mutableListOf<CopiedPart>()
    for (index in next until texts.size) {
        val text = texts[index]
        val rest = copied.length - at
        if (rest <= text.length) return if (copied.regionMatches(at, text, 0, rest)) parts + CopiedPart(index, 0, rest) else null
        if (!copied.regionMatches(at, text, 0, text.length) || copied[at + text.length] != '\n') return null
        parts += CopiedPart(index, 0, text.length)
        at += text.length + 1
    }
    return null
}

/** Writes [parts] of the [sources]' texts again, without their drawn characters, a row's cells joined by tabs. */
private fun writeParts(parts: List<CopiedPart>, sources: List<CopySource>): String = buildString {
    parts.forEachIndexed { index, part ->
        val source = sources[part.source]
        if (index > 0) {
            val row = source.row
            append(if (row != null && row == sources[parts[index - 1].source].row) '\t' else '\n')
        }
        val drawn = source.text.getStringAnnotations(DRAWN_TAG, part.start, part.end)
        var at = part.start
        drawn.sortedBy { it.start }.forEach { range ->
            if (range.start > at) append(source.text.text, at, range.start)
            at = maxOf(at, range.end)
        }
        if (part.end > at) append(source.text.text, at, part.end)
    }
}

/**
 * The clipboard a message's selection is copied to: [clipboard], given the copy written again by
 * [copy] (see [MessageCopy.rewriteCopy]).
 */
internal class MessageClipboard(private val clipboard: Clipboard, private val copy: MessageCopy) : Clipboard by clipboard {
    override suspend fun setClipEntry(clipEntry: ClipEntry?) {
        val data = clipEntry?.clipData
        val text = data?.takeIf { it.itemCount == 1 }?.getItemAt(0)?.text?.toString()
        clipboard.setClipEntry(if (text == null) clipEntry else ClipEntry(ClipData.newPlainText(data.description.label, copy.rewriteCopy(text))))
    }
}
