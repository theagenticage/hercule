package dev.hercule.android.markdown

import org.commonmark.ext.gfm.tables.TableBlock
import org.commonmark.node.Block
import org.commonmark.node.CustomBlock
import org.commonmark.node.DefinitionMap
import org.commonmark.node.Document
import org.commonmark.node.ListBlock
import org.commonmark.node.Paragraph
import org.commonmark.parser.block.AbstractBlockParser
import org.commonmark.parser.block.AbstractBlockParserFactory
import org.commonmark.parser.block.BlockContinue
import org.commonmark.parser.block.BlockStart
import org.commonmark.parser.block.MatchedBlockParser
import org.commonmark.parser.block.ParserState

/*
 * Footnote definitions and references for commonmark-java, read by the rules of client-core's
 * marked extension: a port of `readFootnoteDefinition`, `FOOTNOTE_DEFINITION_START`,
 * `FOOTNOTE_REFERENCE`, `STARTS_ANOTHER_BLOCK` and `footnoteExtension` in
 * packages/client-core/src/markdown.ts. commonmark-java's own footnote extension reads them by
 * other rules, so it is not used.
 *
 * The patterns are written out as code over plain characters, so that they behave the same on
 * the phone, whose regular expressions are ICU's, as in the JVM tests.
 */

/** The most characters of source a footnote label may hold, escapes included. */
private const val MAX_LABEL_LENGTH = 999

/**
 * Returns the end of the footnote label that starts at [start] in [text], reading no further
 * than [limit]: the index of its closing `]`, or -1 when no label starts there. As on GitHub, a
 * label holds no whitespace and no unescaped bracket, and a backslash escapes the character after
 * it. A label is 1 to 999 characters of source.
 */
private fun findLabelEnd(text: CharSequence, start: Int, limit: Int = text.length): Int {
    var position = start
    while (position < limit && position - start <= MAX_LABEL_LENGTH) {
        when (text[position]) {
            ']' -> return if (position > start) position else -1
            '[', ' ', '\t', '\r', '\n' -> return -1
            '\\' -> {
                val next = if (position + 1 < limit) text[position + 1] else return -1
                if (next == ' ' || next == '\t' || next == '\r' || next == '\n') return -1
                position += 2
            }
            else -> position++
        }
    }
    return -1
}

/** A footnote reference, `[^label]`, read from text: its label, and the index after its `]`. */
internal class FootnoteReferenceSyntax(val label: String, val end: Int)

/**
 * Reads a footnote reference, `[^label]`, at [start] in [text], reading no further than [limit].
 * Returns null when none starts there. Whether the message defines the label is for the caller to
 * check: an undefined reference keeps its ordinary meaning.
 */
internal fun readFootnoteReference(text: String, start: Int, limit: Int): FootnoteReferenceSyntax? {
    if (start + 1 >= limit || text[start] != '[' || text[start + 1] != '^') return null
    val labelEnd = findLabelEnd(text, start + 2, limit)
    if (labelEnd == -1) return null
    return FootnoteReferenceSyntax(text.substring(start + 2, labelEnd), labelEnd + 1)
}

/**
 * The first line of a footnote definition: its label and the text after the colon and the spaces
 * that follow it.
 */
private class DefinitionStart(val label: String, val rest: String)

/**
 * Reads the start of a footnote definition at the start of [line]: up to 3 spaces, `[^`, the
 * label, `]:`, and the spaces and tabs after it. Returns null when [line] does not start one.
 */
private fun readDefinitionStart(line: String): DefinitionStart? {
    var position = 0
    while (position < 3 && position < line.length && line[position] == ' ') position++
    if (!line.startsWith("[^", position)) return null
    val labelStart = position + 2
    val labelEnd = findLabelEnd(line, labelStart)
    if (labelEnd == -1 || labelEnd - labelStart > MAX_LABEL_LENGTH) return null
    if (labelEnd + 1 >= line.length || line[labelEnd + 1] != ':') return null
    var restStart = labelEnd + 2
    while (restStart < line.length && (line[restStart] == ' ' || line[restStart] == '\t')) restStart++
    return DefinitionStart(line.substring(labelStart, labelEnd), line.substring(restStart))
}

/** Checks whether [line] starts a footnote definition: up to 3 spaces, `[^`, a label and `]:`. */
internal fun startsFootnoteDefinition(line: String): Boolean = readDefinitionStart(line) != null

/**
 * Returns the length of the indentation that makes [line] part of a footnote: 4 spaces, or up to
 * 3 spaces and a tab. Returns -1 when [line] is not indented that far.
 */
private fun measureFootnoteIndent(line: String): Int {
    if (line.startsWith("    ")) return 4
    var spaces = 0
    while (spaces < 3 && spaces < line.length && line[spaces] == ' ') spaces++
    return if (spaces < line.length && line[spaces] == '\t') spaces + 1 else -1
}

/**
 * Checks whether [text] from [from] on is [character] and then only that character, spaces and
 * tabs, with at least [count] of [character], as in a thematic break such as `* * *`.
 */
private fun isRepeatedWithSpaces(text: String, from: Int, character: Char, count: Int): Boolean {
    if (from >= text.length || text[from] != character) return false
    var seen = 0
    for (index in from until text.length) {
        when (text[index]) {
            character -> seen++
            ' ', '\t' -> Unit
            else -> return false
        }
    }
    return seen >= count
}

/** Checks whether [character] may make up a table's delimiter row: `-`, `:`, `|`, a space or a tab. */
private fun isDelimiterRowCharacter(character: Char): Boolean =
    character == '-' || character == ':' || character == '|' || character == ' ' || character == '\t'

/**
 * Checks whether [line] starts a block other than a paragraph, or may: up to 3 spaces, then a
 * heading, a quote, a list marker, a code fence, a thematic break of `*` or `_`, a heading
 * underline, a table row or a table's delimiter row, HTML, or a footnote or link definition.
 *
 * A line that starts with `|` or `<` may still be paragraph text. It matches all the same,
 * because a footnote that ends a line too early only shows that line after the footnote, while
 * one that ends too late can hide it.
 */
private fun startsAnotherBlock(line: String): Boolean {
    // A delimiter row may start with any number of spaces, which it holds too.
    if (line.isNotEmpty() && line.all(::isDelimiterRowCharacter)) return true
    var start = 0
    while (start < 3 && start < line.length && line[start] == ' ') start++
    if (start >= line.length) return false
    val first = line[start]
    fun isEndOrSpace(index: Int) = index >= line.length || line[index] == ' ' || line[index] == '\t'
    if (first == '#') {
        var hashes = 0
        while (start + hashes < line.length && line[start + hashes] == '#') hashes++
        if (hashes <= 6 && isEndOrSpace(start + hashes)) return true
    }
    if (first == '>' || first == '|' || first == '<') return true
    if ((first == '-' || first == '*' || first == '+') && isEndOrSpace(start + 1)) return true
    if (first in '0'..'9') {
        var digits = 0
        while (start + digits < line.length && line[start + digits] in '0'..'9') digits++
        val marker = if (start + digits < line.length) line[start + digits] else null
        if (digits <= 9 && (marker == '.' || marker == ')') && isEndOrSpace(start + digits + 1)) return true
    }
    if (line.startsWith("```", start) || line.startsWith("~~~", start)) return true
    if (isRepeatedWithSpaces(line, start, '*', 3) || isRepeatedWithSpaces(line, start, '_', 3)) return true
    if (first == '=') {
        var equalsEnd = start
        while (equalsEnd < line.length && line[equalsEnd] == '=') equalsEnd++
        if ((equalsEnd until line.length).all { line[it] == ' ' || line[it] == '\t' }) return true
    }
    if (first == '[') {
        // A link definition's label: 1 to 999 characters or escapes, then `]:`.
        var position = start + 1
        var items = 0
        while (position < line.length && items < MAX_LABEL_LENGTH && line[position] != ']') {
            if (line[position] == '\\') {
                if (position + 1 >= line.length) return false
                position += 2
            } else {
                position++
            }
            items++
        }
        if (items >= 1 && line.startsWith("]:", position)) return true
    }
    return false
}

/** Checks whether [line] holds nothing but white space, as JavaScript's `trim` reads it. */
private fun isBlankLine(line: String): Boolean = line.all(::isJavaScriptWhitespace)

/**
 * A footnote definition, `[^label]: text`, as the footnote reader reads it.
 *
 * - [label] is the label as written, such as `Note 1`.
 * - [text] is the definition's text with the indentation removed, which is parsed as blocks of
 *   its own when the footnote is shown.
 * - [raw] is the source the definition covers, which is what a definition that defines nothing
 *   shows: one inside a quote or a list, or one inside a footnote.
 * - [isTopLevel] is whether the definition sits at the top level of the message, the only place
 *   where a definition defines a footnote.
 */
internal class FootnoteDefinitionBlock(val label: String, val isTopLevel: Boolean) : CustomBlock() {
    var text: String = ""
    var raw: String = ""
}

/**
 * Reads a footnote definition line by line, by the rules of `readFootnoteDefinition`. The first
 * line is `[^label]: text`, and then:
 *
 * - A line indented by 4 spaces or a tab belongs to it, with the indentation removed. Blank lines
 *   belong to it when an indented line follows them.
 * - A line without indentation continues the paragraph on the line before it, when the line does
 *   not start another block and the definition has held only paragraphs so far.
 * - Any other line ends it, and is read as the start of what follows.
 */
private class FootnoteDefinitionParser(start: DefinitionStart, isTopLevel: Boolean) : AbstractBlockParser() {
    private val block = FootnoteDefinitionBlock(start.label, isTopLevel)
    private val lines = arrayListOf(start.rest)
    private val rawLines = arrayListOf<String>()

    // The blank lines seen since the last line that belongs. They belong only if an indented line follows.
    private val pendingBlankLines = ArrayList<String>()

    // Whether every line so far is blank or paragraph text. Text indented further is code, which is not.
    private var onlyParagraphs = !startsAnotherBlock(start.rest)

    // Whether the line before is paragraph text that a line without indentation may continue.
    private var paragraphOpen = onlyParagraphs && !isBlankLine(start.rest)

    // Whether any line follows the last line that belongs, inside the same container.
    private var sourceContinues = false

    fun addFirstLine(source: String) {
        rawLines.add(source)
    }

    override fun getBlock(): Block = block

    override fun tryContinue(state: ParserState): BlockContinue? {
        val content = state.line.content
        val line = content.subSequence(state.index, content.length).toString()
        sourceContinues = true
        val indent = measureFootnoteIndent(line)
        when {
            isBlankLine(line) -> {
                pendingBlankLines.add(line)
                paragraphOpen = false
            }
            indent != -1 -> {
                val rest = line.substring(indent)
                repeat(pendingBlankLines.size) { lines.add("") }
                rawLines.addAll(pendingBlankLines)
                pendingBlankLines.clear()
                lines.add(rest)
                rawLines.add(line)
                sourceContinues = false
                onlyParagraphs = onlyParagraphs && !startsAnotherBlock(rest) && measureFootnoteIndent(rest) == -1
                paragraphOpen = onlyParagraphs
            }
            paragraphOpen && !startsAnotherBlock(line) -> {
                lines.add(line)
                rawLines.add(line)
                sourceContinues = false
            }
            else -> return BlockContinue.none()
        }
        return BlockContinue.atIndex(content.length)
    }

    override fun closeBlock() {
        block.text = lines.joinToString("\n")
        // The line break that ends the last line is part of the definition when anything follows it.
        block.raw = rawLines.joinToString("\n") + if (sourceContinues || pendingBlankLines.isNotEmpty()) "\n" else ""
    }

    override fun getDefinitions(): List<DefinitionMap<*>> {
        if (!block.isTopLevel) return emptyList()
        val definitions = DefinitionMap(FootnoteDefinitionBlock::class.java)
        definitions.putIfAbsent(block.label, block)
        return listOf(definitions)
    }
}

/**
 * Starts a footnote definition wherever marked would lex one: at the start of any block, and at
 * the start of a line in a paragraph. A definition defines a footnote only at the top level of
 * the message.
 */
internal class FootnoteDefinitionParserFactory : AbstractBlockParserFactory() {
    override fun tryStart(state: ParserState, matchedBlockParser: MatchedBlockParser): BlockStart? {
        val content = state.line.content
        val line = content.subSequence(state.index, content.length).toString()
        val start = readDefinitionStart(line) ?: return BlockStart.none()
        // The block the definition goes into. A list cannot hold it, and neither can a paragraph
        // it cuts short, so it goes into the block around those.
        var container = matchedBlockParser.matchedBlockParser.block
        while (container is Paragraph || container is ListBlock) container = container.parent
        // A definition cuts a paragraph short: marked reads a list item line by line, and the
        // content of a quote as it reads the top level, where client-core's extension cuts
        // paragraphs. A paragraph that the line would continue lazily, from inside a quote or a
        // list item that the line does not reach, goes on.
        val active = state.activeBlockParser.block
        if (active is Paragraph && active.parent !== container) return BlockStart.none()
        // A line after a table's rows is one more row to marked, which reads no definition there.
        if (active is TableBlock) return BlockStart.none()
        val isTopLevel = container is Document
        val parser = FootnoteDefinitionParser(start, isTopLevel)
        parser.addFirstLine(line)
        return BlockStart.of(parser).atIndex(content.length)
    }
}

/**
 * Returns the label with case ignored, as CommonMark ignores it in a link label: `[^Note]` and
 * `[^note]` are one label. A port of `normalizeLabel` in packages/client-core/src/markdown.ts.
 */
internal fun normalizeFootnoteLabel(label: String): String = label.lowercase().uppercase()
