/*
 * Parts of this file port the rules of marked (https://github.com/markedjs/marked), under its
 * MIT license:
 *
 * Copyright (c) 2018+, MarkedJS (https://github.com/markedjs/)
 * Copyright (c) 2011-2018, Christopher Jeffrey (https://github.com/chjj/)
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software
 * and associated documentation files (the "Software"), to deal in the Software without
 * restriction, including without limitation the rights to use, copy, modify, merge, publish,
 * distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
 * Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all copies or
 * substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
 * BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
 * DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

package dev.hercule.android.markdown

import org.commonmark.node.BlockQuote
import org.commonmark.node.Document
import org.commonmark.node.Heading
import org.commonmark.node.IndentedCodeBlock
import org.commonmark.node.ListBlock
import org.commonmark.node.ListItem
import org.commonmark.node.Node
import org.commonmark.node.Paragraph
import org.commonmark.node.SourceSpan

/*
 * The inline source of a block as marked reads it: the text that marked's inline lexer reads for
 * a paragraph, a heading or a table cell, built from the source spans that commonmark-java
 * records, with a record of where each of its characters sits in the document. commonmark-java
 * and marked often disagree on what a paragraph's lines hold: the spaces and tabs that start
 * them, a lazy line that marked reads apart, a line of spaces at the end. The lines are cut here
 * by marked's rules where those are known; where marked reads the lines as other blocks, the
 * parity test lists the difference as known. A port of how marked 18's
 * `paragraph`, `blockquote`, `list`, `heading`, `lheading`, `code` and `table` tokenizers cut
 * their lines (marked/src/Tokenizer.ts, Lexer.ts and helpers.ts), which client-core's
 * `parseMarkdown` reads through.
 */

/**
 * The text that marked's inline lexer reads for one block, and where each of its characters sits
 * in the document.
 *
 * Line `i` of the text runs from `lineStarts[i]` to `lineEnds[i]`, and starts at `inputStarts[i]`
 * in the document. Between two lines the text holds characters that stand for none of the
 * document's, such as the line break between them. [cellBase] is set instead for a table cell,
 * whose elements commonmark-java places by their index in the cell's text with `\|` turned into
 * `|`, counted from the cell's start.
 */
internal class InlineSource(
    val text: String,
    private val lineStarts: IntArray,
    private val lineEnds: IntArray,
    private val inputStarts: IntArray,
    private val cellBase: Int = -1,
) {
    /** Returns the index in [text] of the character at [inputIndex] in the document, kept within its line. */
    fun locate(inputIndex: Int): Int {
        if (cellBase >= 0) return (inputIndex - cellBase).coerceIn(0, text.length)
        // The last line that starts at or before the index.
        var low = 0
        var high = inputStarts.size - 1
        while (low < high) {
            val middle = (low + high + 1) / 2
            if (inputStarts[middle] <= inputIndex) low = middle else high = middle - 1
        }
        return (lineStarts[low] + (inputIndex - inputStarts[low])).coerceIn(lineStarts[low], lineEnds[low])
    }

    /** Where the text's first line starts in the document. */
    val firstInputIndex: Int get() = inputStarts[0]

    /** Returns where line [index] of the text starts in [text]. */
    fun findLineStart(index: Int): Int = lineStarts[index]

    /** Returns where [node] starts and ends in [text], from its source spans, or null when it has none. */
    fun locate(node: Node): IntRange? {
        val spans = node.sourceSpans
        if (spans.isEmpty()) return null
        val last = spans.last()
        return locate(spans.first().inputIndex) until locate(last.inputIndex + last.length)
    }

    companion object {
        /** Returns the inline source of a table cell: [text], whose elements commonmark-java places from [cellBase] on. */
        fun forCell(text: String, cellBase: Int): InlineSource =
            InlineSource(text, intArrayOf(0), intArrayOf(text.length), intArrayOf(cellBase), cellBase)
    }
}

/** Builds an [InlineSource] line by line, from stretches of the document's text. */
private class InlineSourceBuilder(private val input: String) {
    private val text = StringBuilder()
    private val lineStarts = ArrayList<Int>()
    private val lineEnds = ArrayList<Int>()
    private val inputStarts = ArrayList<Int>()

    /** Appends the characters of the document from [inputStart] to [inputEnd] as a line of their own. */
    fun appendLine(inputStart: Int, inputEnd: Int) {
        lineStarts.add(text.length)
        inputStarts.add(inputStart)
        text.append(input, inputStart, maxOf(inputStart, inputEnd))
        lineEnds.add(text.length)
    }

    /** Appends [separator], which stands for no character of the document, such as the line break between two lines. */
    fun appendSeparator(separator: String) {
        text.append(separator)
    }

    fun build(): InlineSource = InlineSource(text.toString(), lineStarts.toIntArray(), lineEnds.toIntArray(), inputStarts.toIntArray())
}

private fun isSpaceOrTab(character: Char): Boolean = character == ' ' || character == '\t'

/** Returns where the text of [text] starts and ends without the white space at its ends, as JavaScript's `trim` reads it. */
internal fun findTrimmedRange(text: String): IntRange {
    var start = 0
    var end = text.length
    while (start < end && isJavaScriptWhitespace(text[start])) start++
    while (end > start && isJavaScriptWhitespace(text[end - 1])) end--
    return start until end
}

/** Returns where the line that holds [span] starts in the document. */
private fun findLineStart(span: SourceSpan): Int = span.inputIndex - span.columnIndex

/**
 * Returns the length of the indentation that makes the line from [start] to [end] a line of
 * indented code to marked, and that marked takes away from it: 4 spaces, or up to 3 spaces and a
 * tab, with more text after them. Returns 0 when the line is not one.
 */
private fun measureCodeIndent(input: String, start: Int, end: Int): Int {
    var spaces = 0
    while (spaces < 4 && start + spaces < end && input[start + spaces] == ' ') spaces++
    val indent =
        when {
            spaces == 4 -> 4
            start + spaces < end && input[start + spaces] == '\t' -> spaces + 1
            else -> return 0
        }
    return if (start + indent < end) indent else 0
}

/**
 * Returns the inline source of [paragraph], whose document text is [input]: its lines, as marked
 * reads them inside the block that holds the paragraph.
 */
internal fun buildParagraphSource(paragraph: Paragraph, input: String): InlineSource =
    when (val parent = paragraph.parent) {
        is ListItem -> buildListItemParagraphSource(input, paragraph, parent)
        is BlockQuote -> buildQuoteParagraphSource(input, paragraph, parent)
        else -> buildTopLevelParagraphSource(input, paragraph)
    }

/**
 * Returns the inline source of a paragraph at the top level: its lines as written, joined by
 * line breaks. marked's paragraph also takes a last line of nothing but spaces and tabs when no
 * line break follows it: `foo\n  ` holds `foo\n  `, where CommonMark reads that line as blank.
 */
private fun buildTopLevelParagraphSource(input: String, paragraph: Paragraph): InlineSource {
    val builder = InlineSourceBuilder(input)
    val spans = paragraph.sourceSpans
    for ((index, span) in spans.withIndex()) {
        if (index > 0) builder.appendSeparator("\n")
        builder.appendLine(span.inputIndex, span.inputIndex + span.length)
    }
    val last = spans.lastOrNull()
    if (last != null && paragraph.next == null) {
        val lineEnd = last.inputIndex + last.length
        val start = lineEnd + 1
        val endsInSpaces =
            lineEnd < input.length && input[lineEnd] == '\n' && start < input.length && (start until input.length).all { isSpaceOrTab(input[it]) }
        if (endsInSpaces) {
            builder.appendSeparator("\n")
            builder.appendLine(start, input.length)
        }
    }
    return builder.build()
}

/** Checks whether every block around [node], up to the document, is a list or a list item. */
private fun isOnlyInLists(node: Node): Boolean {
    var ancestor = node.parent
    while (ancestor != null && ancestor !is Document) {
        if (ancestor !is ListItem && ancestor !is ListBlock) return false
        ancestor = ancestor.parent
    }
    return true
}

/**
 * Returns the inline source of a paragraph in a list item, as marked reads it. marked widens each
 * tab at the start of a line to 4 spaces and takes away the item's indentation from each line,
 * and then reads the item's lines one at a time:
 *
 * - A line indented by 4 spaces or a tab is a line of code that joins the paragraph without that
 *   indentation, and with a blank line after the last such line when text follows. So
 *   `- a\n      b\n  c` holds `a\nb\n\nc`.
 * - Any other line joins the paragraph as it is.
 *
 * The white space at the end of a list's last item is trimmed. Only an item in lists alone has its tabs widened here; in a quote, commonmark-java's reading of
 * the line is kept.
 */
private fun buildListItemParagraphSource(input: String, paragraph: Paragraph, item: ListItem): InlineSource {
    val builder = InlineSourceBuilder(input)
    val widensTabs = isOnlyInLists(item)
    val itemIndent = item.contentIndent ?: 0
    // marked trims the white space at the end of a list's last item.
    val endsList = paragraph.next == null && item.next == null
    val spans = paragraph.sourceSpans
    var inCode = false
    for ((index, span) in spans.withIndex()) {
        var start = span.inputIndex
        var end = span.inputIndex + span.length
        if (endsList && index == spans.size - 1) while (end > start && isJavaScriptWhitespace(input[end - 1])) end--
        // Spaces in front of the line that the document holds as a tab, which marked widened.
        var widenedSpaces = 0
        if (index > 0 && widensTabs) {
            val lineStart = findLineStart(span)
            var firstText = lineStart
            var width = 0
            while (firstText < end && isSpaceOrTab(input[firstText])) {
                width += if (input[firstText] == '\t') 4 else 1
                firstText++
            }
            if ((lineStart until firstText).any { input[it] == '\t' } && width >= itemIndent) {
                widenedSpaces = width - itemIndent
                start = firstText
            }
        }
        val codeLine = index > 0 && (widenedSpaces >= 4 && start < end || measureCodeIndent(input, start, end) > 0)
        if (index > 0) builder.appendSeparator(if (inCode && !codeLine) "\n\n" else "\n")
        inCode = codeLine
        if (codeLine) {
            if (widenedSpaces >= 4) {
                widenedSpaces -= 4
            } else {
                start += measureCodeIndent(input, start, end).coerceAtLeast(0)
                widenedSpaces = 0
            }
        }
        if (widenedSpaces > 0) builder.appendSeparator(" ".repeat(widenedSpaces))
        builder.appendLine(start, end)
    }
    return builder.build()
}

/** Checks whether the characters of [input] from [start] to [end] are a heading underline: up to 3 spaces, `=` or `-` marks, and spaces. */
private fun isUnderline(input: String, start: Int, end: Int): Boolean {
    var position = start
    while (position < end && position - start < 3 && input[position] == ' ') position++
    if (position >= end || (input[position] != '=' && input[position] != '-')) return false
    val mark = input[position]
    while (position < end && input[position] == mark) position++
    while (position < end && input[position] == ' ') position++
    return position == end
}

/** Returns the number of quotes around [node]. */
private fun countQuotes(node: Node): Int {
    var count = 0
    var ancestor: Node? = node.parent
    while (ancestor != null) {
        if (ancestor is BlockQuote) count++
        ancestor = ancestor.parent
    }
    return count
}

/**
 * Returns where marked reads the content of a quote's line from: after the line's last `>`
 * before [contentStart], and the space or tab after it. commonmark-java counts a tab after `>`
 * as spaces up to the next tab stop and keeps the rest of it, where marked takes the whole tab.
 */
private fun findQuoteContentStart(input: String, lineStart: Int, contentStart: Int): Int {
    val marker = input.lastIndexOf('>', contentStart).takeIf { it >= lineStart } ?: return contentStart
    var start = marker + 1
    if (start < input.length && isSpaceOrTab(input[start])) start++
    return start
}

/**
 * Returns the inline source of the lines of [paragraph] from line [from] on, each from the start
 * of its line in the document, for the lines that marked reads as a paragraph after a list, see
 * `findListEndingLine` in Markdown.kt.
 */
internal fun buildLinesFromLineStart(input: String, paragraph: Paragraph, from: Int): InlineSource {
    val builder = InlineSourceBuilder(input)
    for ((index, span) in paragraph.sourceSpans.drop(from).withIndex()) {
        if (index > 0) builder.appendSeparator("\n")
        builder.appendLine(findLineStart(span), span.inputIndex + span.length)
    }
    return builder.build()
}

/**
 * Returns the inline source of a paragraph in a quote, as marked reads it. marked takes away the
 * `>` and the space or tab after it from each line. It reads the quote's lines in stretches: the
 * lines that carry the quote's `>`, and then the lines that continue the paragraph lazily without
 * one. Each stretch after the first is read on its own and joined to the paragraph, which changes
 * three things:
 *
 * - A stretch that starts with a line of indented code joins it without its indentation, and
 *   with a blank line after it when text follows in the stretch. `> a\n    b` holds `a\nb`.
 * - A lazy line that looks like a heading underline gets 4 spaces in front, so that it stays
 *   text: `> foo\nbar\n===` holds `foo\nbar\n    ===`.
 * - A last line of the quote of nothing but spaces and tabs is kept, as at the top level.
 */
private fun buildQuoteParagraphSource(input: String, paragraph: Paragraph, quote: BlockQuote): InlineSource {
    val quoteDepth = countQuotes(paragraph)
    val builder = InlineSourceBuilder(input)
    val spans = paragraph.sourceSpans
    var previousLazy = false
    var inCode = false
    for ((index, span) in spans.withIndex()) {
        val lineStart = findLineStart(span)
        val markers = (lineStart until span.inputIndex).count { input[it] == '>' }
        val lazy = index > 0 && markers < quoteDepth
        val start = if (lazy) span.inputIndex else findQuoteContentStart(input, lineStart, span.inputIndex)
        val end = span.inputIndex + span.length
        val stretchStart = lazy && !previousLazy
        previousLazy = lazy
        val codeIndent = if (index == 0) 0 else measureCodeIndent(input, start, end)
        if (inCode && codeIndent > 0 && !stretchStart) {
            builder.appendSeparator("\n")
            builder.appendLine(start + codeIndent, end)
            continue
        }
        if (index > 0) builder.appendSeparator(if (inCode && !stretchStart) "\n\n" else "\n")
        inCode = stretchStart && codeIndent > 0
        when {
            inCode -> builder.appendLine(start + codeIndent, end)
            lazy && !stretchStart && isUnderline(input, start, end) -> {
                var marks = start
                while (input[marks] == ' ') marks++
                builder.appendSeparator("    ")
                builder.appendLine(marks, end)
            }
            else -> builder.appendLine(start, end)
        }
    }
    (findQuoteTrailingSpaceLine(paragraph, quote, input) ?: findLazyTrailingSpaceLine(spans.last(), previousLazy, input))?.let { line ->
        builder.appendSeparator("\n")
        builder.appendLine(line.first, line.last + 1)
    }
    return builder.build()
}

/**
 * Returns where a last line of spaces and tabs sits in [input], after [last], the last line of a
 * quote's paragraph, when [last] continues the paragraph lazily and that line ends the message.
 * marked reads the lazy lines on their own, as it reads the top level, where it keeps such a line.
 */
private fun findLazyTrailingSpaceLine(last: SourceSpan, lazy: Boolean, input: String): IntRange? {
    if (!lazy) return null
    val lineEnd = last.inputIndex + last.length
    val start = lineEnd + 1
    if (lineEnd >= input.length || input[lineEnd] != '\n' || start >= input.length) return null
    return if ((start until input.length).all { isSpaceOrTab(input[it]) }) start until input.length else null
}

/**
 * Returns where the last line of [quote] sits in [input] after its `>` and the space or tab after
 * that, when it is nothing but spaces and tabs and comes right after [paragraph], the quote's last
 * block. marked keeps such a line in the paragraph.
 */
private fun findQuoteTrailingSpaceLine(paragraph: Paragraph, quote: BlockQuote, input: String): IntRange? {
    if (paragraph.next != null) return null
    val last = paragraph.sourceSpans.lastOrNull() ?: return null
    val quoteLast = quote.sourceSpans.lastOrNull() ?: return null
    if (quoteLast.lineIndex != last.lineIndex + 1) return null
    var start = quoteLast.inputIndex
    val end = quoteLast.inputIndex + quoteLast.length
    while (start < end && start - quoteLast.inputIndex < 3 && input[start] == ' ') start++
    if (start >= end || input[start] != '>') return null
    start++
    if (start < end && isSpaceOrTab(input[start])) start++
    if (start >= end) return null
    return if ((start until end).all { isSpaceOrTab(input[it]) }) start until end else null
}

/**
 * Returns the inline source of [heading] as marked reads it. For a heading of `#` marks, the line
 * after the marks and without the closing marks, trimmed. For an underlined heading, the lines
 * above the underline, with the white space at both ends trimmed.
 */
internal fun buildHeadingSource(heading: Heading, input: String): InlineSource {
    val spans = heading.sourceSpans
    val builder = InlineSourceBuilder(input)
    if (spans.size > 1) {
        val lines = spans.dropLast(1)
        for ((index, span) in lines.withIndex()) {
            var start = span.inputIndex
            var end = span.inputIndex + span.length
            if (index == 0) while (start < end && isJavaScriptWhitespace(input[start])) start++
            if (index == lines.size - 1) while (end > start && isJavaScriptWhitespace(input[end - 1])) end--
            if (index > 0) builder.appendSeparator("\n")
            builder.appendLine(start, end)
        }
        return builder.build()
    }
    val span = spans.single()
    val line = input.substring(span.inputIndex, span.inputIndex + span.length)
    var start = 0
    // A tab here is the rest of one after a quote's `>`, which marked has already taken away.
    while (start < line.length && isSpaceOrTab(line[start])) start++
    while (start < line.length && line[start] == '#') start++
    val trimmed = findTrimmedRange(line.substring(start))
    var contentStart = start + trimmed.first
    var contentEnd = start + trimmed.last + 1
    if (contentEnd > contentStart && line[contentEnd - 1] == '#') {
        var hashesStart = contentEnd
        while (hashesStart > contentStart && line[hashesStart - 1] == '#') hashesStart--
        // CommonMark asks for a space or a tab before the closing marks.
        if (hashesStart == contentStart || isSpaceOrTab(line[hashesStart - 1])) {
            val inner = findTrimmedRange(line.substring(contentStart, hashesStart))
            contentEnd = contentStart + inner.last + 1
            contentStart += inner.first
        }
    }
    builder.appendLine(span.inputIndex + contentStart, span.inputIndex + maxOf(contentStart, contentEnd))
    return builder.build()
}

/**
 * Returns the cells of a table row as marked reads them: the row split at each `|` that an odd
 * number of backslashes does not escape, without an empty first or last cell, cut or padded to
 * [count] cells when it is given, and each cell trimmed with `\|` turned into `|`. A port of
 * `splitCells` in marked/src/helpers.ts. commonmark-java splits the same row the same way, except
 * that it takes `\\|` as an escaped pipe too.
 */
internal fun splitTableCells(row: String, count: Int? = null): List<String> {
    val cells = ArrayList<String>()
    var cellStart = 0
    for (index in row.indices) {
        if (row[index] != '|') continue
        var backslashes = 0
        while (index - backslashes - 1 >= 0 && row[index - backslashes - 1] == '\\') backslashes++
        if (backslashes % 2 == 1) continue
        cells.add(row.substring(cellStart, index))
        cellStart = index + 1
    }
    cells.add(row.substring(cellStart))
    if (cells.first().all(::isJavaScriptWhitespace)) cells.removeAt(0)
    if (cells.isNotEmpty() && cells.last().all(::isJavaScriptWhitespace)) cells.removeAt(cells.size - 1)
    if (count != null) {
        while (cells.size > count) cells.removeAt(cells.size - 1)
        while (cells.size < count) cells.add("")
    }
    return cells.map { trimJavaScriptWhitespace(it).replace("\\|", "|") }
}

/**
 * Returns the text of an indented code block. marked's text for one ends with a line break,
 * which client-core drops, so this is commonmark-java's text without its last line break, with
 * two exceptions where marked reads the lines in another way:
 *
 * - In a quote, the lines are read again from the source: marked takes away the `>` and the
 *   space or tab after it, then up to 4 spaces or a tab. commonmark-java counts a tab as the
 *   spaces up to the next tab stop, so `>\t\tfoo` holds `  foo` there and `foo` in marked.
 * - At the end of the message, marked keeps a last line of spaces with no line break after it:
 *   `    a\n     ` holds `a\n `.
 */
internal fun readIndentedCode(code: IndentedCodeBlock, input: String): String {
    val parent = code.parent
    val spans = code.sourceSpans
    if (parent is Document || spans.isEmpty()) {
        val text = code.literal.removeSuffix("\n")
        // commonmark-java keeps the blank lines at the end of the block in its spans, not in its text.
        val last = spans.lastOrNull { span -> (span.inputIndex until span.inputIndex + span.length).any { !isSpaceOrTab(input[it]) } } ?: return text
        val lineEnd = last.inputIndex + last.length
        val trailingStart = lineEnd + 1
        val endsInSpaces =
            code.next == null && lineEnd < input.length && input[lineEnd] == '\n' && trailingStart < input.length &&
                (trailingStart until input.length).all { isSpaceOrTab(input[it]) }
        if (!endsInSpaces) return text
        // marked takes away up to 4 spaces, or up to 3 spaces and a tab.
        var indent = 0
        while (indent < 4 && trailingStart + indent < input.length && input[trailingStart + indent] == ' ') indent++
        if (indent < 4 && trailingStart + indent < input.length && input[trailingStart + indent] == '\t') indent++
        return text + "\n" + input.substring(trailingStart + indent)
    }
    var ancestor: Node? = parent
    while (ancestor != null && ancestor !is Document) {
        if (ancestor !is BlockQuote) return code.literal.removeSuffix("\n")
        ancestor = ancestor.parent
    }
    val first = spans.first()
    val last = spans.last()
    val lines = ArrayList<String>()
    var lineStart = findLineStart(first)
    for (lineIndex in first.lineIndex..last.lineIndex) {
        val lineEnd = input.indexOf('\n', lineStart).let { if (it == -1) input.length else it }
        var start = lineStart
        // Each quote's `>`, and the space or tab after it.
        while (true) {
            var marker = start
            while (marker < lineEnd && marker - start < 3 && input[marker] == ' ') marker++
            if (marker >= lineEnd || input[marker] != '>') break
            start = marker + 1
            if (start < lineEnd && isSpaceOrTab(input[start])) start++
        }
        var spaces = 0
        while (spaces < 3 && start + spaces < lineEnd && input[start + spaces] == ' ') spaces++
        start +=
            when {
                start + spaces < lineEnd && input[start + spaces] == '\t' -> spaces + 1
                spaces == 3 && start + 3 < lineEnd && input[start + 3] == ' ' -> 4
                else -> spaces
            }
        lines.add(input.substring(start, lineEnd))
        lineStart = lineEnd + 1
    }
    return lines.joinToString("\n")
}

/**
 * Returns the text of an HTML block as marked reads it: commonmark-java's text, and the line
 * break after it where marked keeps that. marked keeps one line break, and no more:
 *
 * - after a block that ends at its closing mark, one that starts with `<script`, `<pre`,
 *   `<style`, `<textarea`, `<!` or `<?`, when no blank line follows it;
 * - after any other block, which ends at a blank line, only at the end of the message, with a
 *   last line of spaces and tabs after it when there is one.
 *
 * Only a block at the top level of the message is read this way.
 */
internal fun readHtmlBlockText(block: Node, literal: String, input: String): String {
    val last = block.sourceSpans.lastOrNull()
    if (block.parent !is Document || last == null) return literal
    val lineEnd = last.inputIndex + last.length
    if (lineEnd >= input.length || input[lineEnd] != '\n') return literal
    val next = lineEnd + 1
    val lowercase = literal.take(10).lowercase()
    if (listOf("<script", "<pre", "<style", "<textarea", "<!", "<?").any { lowercase.startsWith(it) }) {
        return if (next < input.length && input[next] == '\n') literal else literal + "\n"
    }
    val endsInSpaces = (next until input.length).all { isSpaceOrTab(input[it]) }
    return if (endsInSpaces) literal + "\n" + input.substring(next) else literal
}

/**
 * Checks whether marked reads the lines of an underlined heading as a heading. Its pattern for
 * one stops at a line that is a lone HTML tag, such as `<br>`, that starts with a list marker
 * and a space, or that could be a table's delimiter row, such as `|`, which commonmark-java keeps
 * in the heading. marked then reads the lines, the
 * underline with them, as a paragraph.
 */
internal fun isUnderlinedHeadingToMarked(heading: Heading, input: String): Boolean {
    val lines = heading.sourceSpans.dropLast(1)
    val linesOfText = lines.map { span -> input.substring(span.inputIndex, span.inputIndex + span.length) }
    // A first line that is a lone tag stops the pattern too.
    if (linesOfText.first().trimStart(' ').let { it.length > 2 && it[0] == '<' && it.last() == '>' && it.indexOf('>') == it.length - 1 }) return false
    // A line that could be a table's delimiter row, `|` and `-`, `:` or spaces, stops the pattern on any line.
    if (linesOfText.any { line -> '|' in line && line.trimStart(' ').all { it == '|' || it == ':' || it == '-' || it == ' ' } }) return false
    return linesOfText.drop(1).none { line ->
        var start = 0
        while (start < 3 && start < line.length && line[start] == ' ') start++
        val rest = line.substring(start)
        val isTag = rest.length > 2 && rest[0] == '<' && rest.last() == '>' && rest.indexOf('>') == rest.length - 1
        var digits = 0
        while (digits < rest.length && rest[digits] in '0'..'9') digits++
        val marker = if (digits in 1..9) rest.getOrNull(digits)?.takeIf { it == '.' || it == ')' } else rest.firstOrNull()?.takeIf { it in "*+-" }
        val markerEnd = if (digits in 1..9) digits + 1 else 1
        isTag || (marker != null && rest.getOrNull(markerEnd) == ' ')
    }
}

/**
 * Returns the inline source of the lines of [node], joined by line breaks, for an underlined
 * heading that marked reads as a paragraph: with the underline, or without it when [dropLast] is
 * set, as for an underline that marked reads as a rule.
 */
internal fun buildLinesSource(node: Node, input: String, dropLast: Boolean = false): InlineSource {
    val builder = InlineSourceBuilder(input)
    for ((index, span) in node.sourceSpans.dropLast(if (dropLast) 1 else 0).withIndex()) {
        if (index > 0) builder.appendSeparator("\n")
        builder.appendLine(span.inputIndex, span.inputIndex + span.length)
    }
    return builder.build()
}

/**
 * Returns the source of [node] in [input]: one line per line it covers, with the blank lines that
 * the node holds but no span covers put back as empty lines. It is what marked calls a block's
 * `raw`.
 */
internal fun readBlockSource(node: Node, input: String): String {
    val spans = node.sourceSpans
    if (spans.isEmpty()) return ""
    val out = StringBuilder()
    var previousLine = -1
    for (span in spans) {
        if (previousLine != -1) repeat(span.lineIndex - previousLine) { out.append('\n') }
        out.append(input, span.inputIndex, span.inputIndex + span.length)
        previousLine = span.lineIndex
    }
    return out.toString()
}
