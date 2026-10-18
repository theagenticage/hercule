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

import java.util.IdentityHashMap
import org.commonmark.ext.gfm.strikethrough.Strikethrough
import org.commonmark.ext.gfm.strikethrough.StrikethroughExtension
import org.commonmark.ext.gfm.tables.TableBlock
import org.commonmark.ext.gfm.tables.TableBody
import org.commonmark.ext.gfm.tables.TableCell
import org.commonmark.ext.gfm.tables.TableHead
import org.commonmark.ext.gfm.tables.TableRow
import org.commonmark.ext.gfm.tables.TablesExtension
import org.commonmark.internal.util.Escaping
import org.commonmark.node.BlockQuote
import org.commonmark.node.Code
import org.commonmark.node.Delimited
import org.commonmark.node.Document
import org.commonmark.node.Emphasis
import org.commonmark.node.FencedCodeBlock
import org.commonmark.node.HardLineBreak
import org.commonmark.node.Heading
import org.commonmark.node.HtmlBlock
import org.commonmark.node.HtmlInline
import org.commonmark.node.Image
import org.commonmark.node.IndentedCodeBlock
import org.commonmark.node.Link
import org.commonmark.node.LinkReferenceDefinition
import org.commonmark.node.ListBlock
import org.commonmark.node.ListItem
import org.commonmark.node.Node
import org.commonmark.node.OrderedList
import org.commonmark.node.Paragraph
import org.commonmark.node.SoftLineBreak
import org.commonmark.node.SourceSpan
import org.commonmark.node.StrongEmphasis
import org.commonmark.node.Text
import org.commonmark.node.ThematicBreak
import org.commonmark.parser.IncludeSourceSpans
import org.commonmark.parser.InlineParserContext
import org.commonmark.parser.Parser
import org.commonmark.parser.beta.LinkInfo
import org.commonmark.parser.beta.LinkProcessor
import org.commonmark.parser.beta.LinkResult
import org.commonmark.parser.beta.Scanner

/*
 * Parses the markdown in a message into the tree of MarkdownTree.kt. A port of `parseMarkdown`
 * in packages/client-core/src/markdown.ts, which parses with marked: for the same text, both
 * build the same tree. MarkdownParityTest checks it against the trees client-core builds for the
 * inputs of scripts/markdown-parity-corpus.json.
 *
 * The tree holds only the elements the app knows how to draw, so it is safe to draw by
 * construction:
 *
 * - Raw HTML becomes elements only for an allowlist of tags (MarkdownHtml.kt). With
 *   embeddedHtml false, all HTML is kept as text instead.
 * - A link or an image whose address is unsafe, such as `javascript:`, is not in the tree.
 * - Character references are decoded, so `AT&amp;T` reads `AT&T`.
 * - Link and image addresses are percent-encoded.
 *
 * How it parses: commonmark-java finds the blocks and the inline elements, with the source span
 * of each. Where marked reads a part of the message in another way, that part is read again from
 * its source by marked's rules:
 *
 * - The text of a paragraph, a heading or a cell is cut out of the source as marked cuts it
 *   (InlineSource.kt).
 * - The text between two elements is read from that source by marked's text rules
 *   (InlineText.kt): escapes, line breaks, bare URLs, footnote references, character references,
 *   and the spaces at the ends of lines.
 * - A link's address and title are read from its source, unescaped and decoded as marked does.
 * - Task boxes, footnote definitions (FootnoteSyntax.kt) and the HTML (MarkdownHtml.kt) are read
 *   by client-core's own rules.
 */

/**
 * The deepest that a message's tree may nest before [parseMarkdown] shows it as plain text:
 * blocks and inlines counted together, each one level, from a top-level block down to its
 * deepest text. A port of `MAX_MARKDOWN_NESTING` in packages/client-core/src/markdown.ts, which
 * refuses the same messages by the same rule, see [isTooDeep].
 */
const val MAX_MARKDOWN_NESTING = 100

/** Thrown when the mapping nests deeper than [MAX_MARKDOWN_NESTING]; [parseMarkdown] then returns the plain text. */
private class NestingTooDeep : RuntimeException(null, null, false, false)

/**
 * Builds the parser. [linkDefinitions] are the message's, for a footnote's own text, which is
 * parsed apart from the message but knows its link definitions. It is null for the message
 * itself.
 *
 * The parser keeps no state between calls, so one instance serves every thread. Its limits on
 * open blocks and on inline nesting are [MAX_MARKDOWN_NESTING]: it reads anything deeper as text,
 * so the work on a hostile message stays bounded. A message it cuts short is deeper than the
 * limit, and its tree, cut short too, is still deeper than the limit, so it is shown as plain text
 * all the same.
 */
private fun buildParser(linkDefinitions: Map<String, SourcedDefinition>?): Parser {
    val builder =
        Parser.builder()
            .extensions(listOf(TablesExtension.create(), StrikethroughExtension.create()))
            .customBlockParserFactory(FootnoteDefinitionParserFactory())
            .includeSourceSpans(IncludeSourceSpans.BLOCKS_AND_INLINES)
            .maxOpenBlockParsers(MAX_MARKDOWN_NESTING)
            .maxInlineNesting(MAX_MARKDOWN_NESTING)
    if (linkDefinitions != null) builder.linkProcessor(MessageReferenceProcessor(linkDefinitions))
    return builder.build()
}

/** The parser of a whole message. Unlike marked, it reads line breaks the same way with and without `breaks`. */
private val MESSAGE_PARSER: Parser = buildParser(linkDefinitions = null)

/**
 * Parses [text] as GitHub-flavoured markdown with footnotes.
 *
 * With [embeddedHtml] (the default), an allowlist of HTML elements becomes the same nodes as the
 * markdown for them, as on GitHub, where bots write comments in HTML. With embeddedHtml false,
 * every tag is shown as text, as written: use that for the user's own messages.
 *
 * With [breaks], a single newline inside a paragraph becomes a line break, as in the user's
 * message bubble. Without it, a single newline stays in the text, as CommonMark says.
 *
 * A message whose tree nests deeper than [MAX_MARKDOWN_NESTING] levels is returned as one
 * paragraph of its raw text, as client-core's callers show one that `parseMarkdown` refuses with a
 * `MarkdownTooDeepError`. It never throws.
 *
 * A port of `parseMarkdown` in packages/client-core/src/markdown.ts.
 */
fun parseMarkdown(text: String, breaks: Boolean = false, embeddedHtml: Boolean = true): MarkdownDocument =
    try {
        val source = normalizeLineEnds(text)
        val document = MessageMapper(breaks, embeddedHtml).mapDocument(SourceDocument(source, MESSAGE_PARSER.parse(source)))
        if (isTooDeep(document)) showAsPlainText(text) else document
    } catch (_: NestingTooDeep) {
        // The mapping counts fewer levels than the tree has, so a mapping this deep is a tree too deep.
        showAsPlainText(text)
    } catch (_: StackOverflowError) {
        // A last resort: the limit keeps the walks shallow, but a thread with a very small stack
        // may still run out.
        showAsPlainText(text)
    }

/** Checks whether [inlines], at nesting level [level], nest deeper than [MAX_MARKDOWN_NESTING]. */
private fun isInlineTooDeep(inlines: List<MarkdownInline>, level: Int): Boolean =
    level > MAX_MARKDOWN_NESTING ||
        inlines.any { inline ->
            val children =
                when (inline) {
                    is MarkdownInline.Strong -> inline.children
                    is MarkdownInline.Emphasis -> inline.children
                    is MarkdownInline.Strikethrough -> inline.children
                    is MarkdownInline.Link -> inline.children
                    else -> null
                }
            children != null && isInlineTooDeep(children, level + 1)
        }

/** Checks whether [blocks], at nesting level [level], nest deeper than [MAX_MARKDOWN_NESTING]. */
private fun isBlockTooDeep(blocks: List<MarkdownBlock>, level: Int): Boolean =
    level > MAX_MARKDOWN_NESTING ||
        blocks.any { block ->
            when (block) {
                is MarkdownBlock.Paragraph -> block.children.isNotEmpty() && isInlineTooDeep(block.children, level + 1)
                is MarkdownBlock.Heading -> block.children.isNotEmpty() && isInlineTooDeep(block.children, level + 1)
                is MarkdownBlock.List -> block.items.any { level + 1 > MAX_MARKDOWN_NESTING || isBlockTooDeep(it.children, level + 2) }
                is MarkdownBlock.Blockquote -> isBlockTooDeep(block.children, level + 1)
                is MarkdownBlock.Details ->
                    (block.summary.isNotEmpty() && isInlineTooDeep(block.summary, level + 1)) || isBlockTooDeep(block.children, level + 1)
                is MarkdownBlock.Table ->
                    (listOf(block.header) + block.rows).any { row ->
                        row.any { cell -> level + 1 > MAX_MARKDOWN_NESTING || (cell.children.isNotEmpty() && isInlineTooDeep(cell.children, level + 2)) }
                    }
                is MarkdownBlock.Code, MarkdownBlock.Rule -> false
            }
        }

/**
 * Checks whether [document] nests deeper than [MAX_MARKDOWN_NESTING], its footnotes included. A
 * port of `isTooDeep` in packages/client-core/src/markdown.ts.
 */
private fun isTooDeep(document: MarkdownDocument): Boolean =
    isBlockTooDeep(document.blocks, 1) || document.footnotes.any { isBlockTooDeep(it.children, 1) }

/** Returns the document that shows [text] as written, in one paragraph. */
private fun showAsPlainText(text: String): MarkdownDocument =
    MarkdownDocument(listOf(MarkdownBlock.Paragraph(listOf(MarkdownInline.Text(text)))), emptyList())

/** Returns [text] with each `\r\n` and `\r` replaced by `\n`, as marked does before it reads a message. */
private fun normalizeLineEnds(text: String): String {
    if ('\r' !in text) return text
    val out = StringBuilder(text.length)
    var index = 0
    while (index < text.length) {
        val character = text[index]
        if (character == '\r') {
            out.append('\n')
            if (index + 1 < text.length && text[index + 1] == '\n') index++
        } else {
            out.append(character)
        }
        index++
    }
    return out.toString()
}

/** A link reference definition, with the text of the document it was written in. */
private class SourcedDefinition(val definition: LinkReferenceDefinition, val source: String)

/** Returns [root] and the blocks inside it, in document order, without the inline content of paragraphs and headings. */
private fun listBlocks(root: Node): List<Node> {
    val blocks = ArrayList<Node>()
    // The walk keeps its own stack: a message may nest thousands of quotes.
    val pending = ArrayDeque<Node>()
    pending.addLast(root)
    while (pending.isNotEmpty()) {
        val node = pending.removeLast()
        blocks.add(node)
        if (node is Paragraph || node is Heading || node is TableCell) continue
        var child = node.lastChild
        while (child != null) {
            pending.addLast(child)
            child = child.previous
        }
    }
    return blocks
}

/** Returns the inline nodes inside [block], in document order. */
private fun listInlines(block: Node): List<Node> {
    val nodes = ArrayList<Node>()
    val pending = ArrayDeque<Node>()
    var child = block.lastChild
    while (child != null) {
        pending.addLast(child)
        child = child.previous
    }
    while (pending.isNotEmpty()) {
        val node = pending.removeLast()
        nodes.add(node)
        var inner = node.lastChild
        while (inner != null) {
            pending.addLast(inner)
            inner = inner.previous
        }
    }
    return nodes
}

/** A parsed document: its [text] and the [root] that commonmark-java built from it. */
private class SourceDocument(val text: String, val root: Node) {
    /** The first definition of each label, by the label commonmark-java normalizes. */
    val linkDefinitions: Map<String, SourcedDefinition> =
        buildMap {
            for (node in listBlocks(root)) {
                if (node is LinkReferenceDefinition) putIfAbsent(Escaping.normalizeLabelContent(node.label), SourcedDefinition(node, text))
            }
        }
}

/**
 * Resolves a reference link in a footnote's own text with the link definitions of the message,
 * as marked, which lexes a footnote with the message, resolves it. A definition in the footnote's
 * text comes first.
 */
private class MessageReferenceProcessor(private val definitions: Map<String, SourcedDefinition>) : LinkProcessor {
    override fun process(linkInfo: LinkInfo, scanner: Scanner, context: InlineParserContext): LinkResult? {
        if (linkInfo.destination() != null) return LinkResult.none()
        val label = linkInfo.label()?.takeIf { it.isNotBlank() } ?: linkInfo.text()
        if (context.getDefinition(LinkReferenceDefinition::class.java, label) != null) return LinkResult.none()
        val definition = definitions[Escaping.normalizeLabelContent(label)]?.definition ?: return LinkResult.none()
        if (linkInfo.marker()?.literal == "!") {
            return LinkResult.wrapTextIn(Image(definition.destination, definition.title), scanner.position()).includeMarker()
        }
        return LinkResult.wrapTextIn(Link(definition.destination, definition.title), scanner.position())
    }
}

/** A footnote the visible text has referenced: its number and its definition. */
private class NumberedFootnote(val number: Int, val definition: FootnoteDefinitionBlock)

/** The footnotes that the text has referenced so far, by normalized label and in the order of their numbers. */
private class FootnoteNumbering {
    val byLabel = HashMap<String, NumberedFootnote>()
    val inOrder = ArrayList<NumberedFootnote>()
}

/**
 * What the mapping functions share while they walk one message. A port of `MappingContext` in
 * packages/client-core/src/markdown.ts.
 *
 * - [insideCode] is whether the nodes are inside an HTML `code` or `pre` element. Their content is
 *   literal: markup in it shows as written and takes no footnote number.
 * - [numbered] holds the footnotes the text has referenced so far.
 */
private class MappingContext(val insideCode: Boolean, val numbered: FootnoteNumbering)

/**
 * Checks whether a blank line separates two blocks of one of [list]'s items. Then the list is
 * loose, in marked as in CommonMark, though commonmark-java reads a list whose item holds an
 * underlined heading and then a paragraph as tight.
 */
private fun hasBlankLineBetweenChildren(list: ListBlock): Boolean =
    childrenOf(list).any { item ->
        childrenOf(item).zipWithNext().any { (before, after) ->
            val end = before.sourceSpans.lastOrNull()?.lineIndex
            val start = after.sourceSpans.firstOrNull()?.lineIndex
            end != null && start != null && start - end > 1
        }
    }

/**
 * Returns [text], the text of [block], without the white space at its end when [block] ends a
 * list: when it is the last block of a list's last item. marked trims the end of a list's last
 * item before it reads the item.
 */
private fun trimListEnd(block: Node, text: String): String {
    val item = block.parent
    if (block.next != null || item !is ListItem || item.next != null) return text
    return text.substring(0, findTrimmedRange(text).let { if (it.isEmpty()) 0 else it.last + 1 })
}

/** Checks whether [node] is text that the text between elements covers: text and soft or hard line breaks. */
private fun isTextLike(node: Node): Boolean = node is Text || node is SoftLineBreak || node is HardLineBreak

/** Returns the children of [node], in order. */
private fun childrenOf(node: Node): List<Node> = generateSequence(node.firstChild) { it.next }.toList()

/** Returns [first] and the siblings after it, in order. */
private fun siblingsFrom(first: Node?): List<Node> = generateSequence(first) { it.next }.toList()

/** Checks whether [link] is an autolink, `<...>`, which [input] holds at its start. */
private fun isAutolink(link: Node, input: String): Boolean =
    link is Link && link.sourceSpans.firstOrNull()?.let { input.getOrNull(it.inputIndex) == '<' } == true

/**
 * Returns marked's `inLink` state after the HTML tag [html]: an `<a ` tag opens a link and an
 * `</a>` tag closes it. While a link is open, marked turns no bare URL into a link.
 */
private fun advanceTagLinkState(html: String, inLink: Boolean): Boolean {
    val opensLink = html.length > 2 && html[0] == '<' && (html[1] == 'a' || html[1] == 'A') && html[2] == ' '
    val closesLink = html.length == 4 && html[0] == '<' && html[1] == '/' && (html[2] == 'a' || html[2] == 'A') && html[3] == '>'
    return when {
        !inLink && opensLink -> true
        inLink && closesLink -> false
        else -> inLink
    }
}

/**
 * Returns marked's `inLink` state after [node] and everything inside it: HTML tags open and
 * close links, see [advanceTagLinkState], and a markdown link or image ends with the state
 * closed, whatever it was before.
 */
private fun advanceLinkState(node: Node, inLink: Boolean, input: String): Boolean {
    var state = inLink
    // The node and what is inside it, in document order, with a stack of its own. What is inside a
    // markdown link does not matter: the link closes the state when it ends.
    val pending = ArrayDeque<Node>()
    pending.addLast(node)
    while (pending.isNotEmpty()) {
        val inner = pending.removeLast()
        if (inner is HtmlInline) {
            state = advanceTagLinkState(inner.literal, state)
        } else if ((inner is Link && !isAutolink(inner, input)) || inner is Image) {
            state = false
        } else {
            var child = inner.lastChild
            while (child != null) {
                pending.addLast(child)
                child = child.previous
            }
        }
    }
    return state
}

/**
 * Returns the deepest that brackets nest inside the text of a link or image, [text] from [start]
 * to [end]. A bracket that a backslash escapes, or that sits in a code span, does not count.
 */
private fun measureBracketNesting(text: String, start: Int, end: Int): Int {
    var depth = 0
    var deepest = 0
    var position = start
    while (position < end) {
        when (text[position]) {
            '\\' -> position++
            '`' -> {
                // marked's label pattern skips a code span: backticks, text without one, backticks.
                var runEnd = position
                while (runEnd < end && text[runEnd] == '`') runEnd++
                val close = text.indexOf('`', runEnd)
                if (close in runEnd until end) {
                    position = close
                    while (position + 1 < end && text[position + 1] == '`') position++
                } else {
                    position = runEnd - 1
                }
            }
            '[' -> deepest = maxOf(deepest, ++depth)
            ']' -> depth = maxOf(0, depth - 1)
        }
        position++
    }
    return deepest
}

/**
 * One element of a run of inline nodes, from [start] to [end] of its inline source: a [node] that
 * commonmark-java read, or a footnote reference to [label] read across nodes.
 */
private class InlineElement(val node: Node?, val label: String?, val start: Int, val end: Int)

/**
 * The deepest that brackets may nest inside a link's text before marked no longer reads it as a
 * link: its pattern for a label follows two levels of brackets and no more.
 */
private const val MAX_LINK_TEXT_BRACKET_NESTING = 2

/**
 * Walks the nodes commonmark-java parsed from one message and maps them onto the tree, by the
 * rules of client-core's mapping functions in packages/client-core/src/markdown.ts.
 */
private class MessageMapper(private val breaks: Boolean, private val embeddedHtml: Boolean) {
    /** The first top-level definition of each normalized footnote label. */
    private val definitions = LinkedHashMap<String, FootnoteDefinitionBlock>()

    /** The parsed text of each footnote that is read, by its definition. */
    private val footnoteDocuments = HashMap<FootnoteDefinitionBlock, SourceDocument>()

    /** The parser of a text parsed apart from the message, made the first time one is needed. */
    private var footnoteParser: Parser? = null

    /**
     * marked's `inLink` state at the start of each paragraph, heading and cell, when the message
     * holds an `<a ` tag that may leave it open. Without one, it is closed at every start.
     */
    private var linkStateAtStart: IdentityHashMap<Node, Boolean>? = null

    /** The line at which marked ends a list in the middle of its last paragraph, by that paragraph, see [findListEndingLine]. */
    private val listEndingLines = IdentityHashMap<Paragraph, Int>()

    /**
     * Returns the last paragraph of a top-level [list] and the index of its line at which marked
     * ends the list, or null when it does not. marked ends a list item at a line that starts with
     * `#` after fewer spaces than the item's indentation, even where that is no heading, as in
     * `#tag`. commonmark-java continues the item's paragraph with it lazily. The line and the
     * lines after it are a paragraph after the list.
     */
    private fun findListEndingLine(list: ListBlock, input: String): Pair<Paragraph, Int>? {
        if (list.parent !is Document) return null
        val item = list.lastChild as? ListItem ?: return null
        val paragraph = item.lastChild as? Paragraph ?: return null
        for ((index, span) in paragraph.sourceSpans.withIndex()) {
            if (index > 0 && startsWithListEndingHash(span, item, input)) return Pair(paragraph, index)
        }
        return null
    }

    /** Checks whether the line of [span] starts with `#` after fewer spaces than [item]'s indentation, up to 3, which ends the item in marked. */
    private fun startsWithListEndingHash(span: SourceSpan, item: ListItem, input: String): Boolean {
        val maxSpaces = minOf(3, (item.contentIndent ?: 1) - 1)
        var position = span.inputIndex - span.columnIndex
        var spaces = 0
        while (position < input.length && input[position] == ' ') {
            position++
            spaces++
        }
        return spaces <= maxSpaces && position < input.length && input[position] == '#'
    }

    /** The paragraph that marked reads as part of the quote or list before it, by that block, see [takesLazyParagraph]. */
    private val lazyParagraphs = IdentityHashMap<Node, Paragraph>()

    private lateinit var message: SourceDocument

    private var depth = 0

    /** Runs [map] one level deeper, and fails with [NestingTooDeep] past [MAX_MARKDOWN_NESTING]. */
    private inline fun <T> nested(map: () -> T): T {
        if (++depth > MAX_MARKDOWN_NESTING) throw NestingTooDeep()
        try {
            return map()
        } finally {
            depth--
        }
    }

    /**
     * Maps a whole message. The footnote definitions at the top level are set aside and the rest
     * is the body. The body is mapped first, and each reference in it numbers its footnote. Then
     * the referenced footnotes are mapped in number order. Last, the texts that end up side by
     * side are joined.
     *
     * A port of `mapDocument` in packages/client-core/src/markdown.ts.
     */
    fun mapDocument(document: SourceDocument): MarkdownDocument {
        message = document
        val body = ArrayList<Node>()
        for (node in childrenOf(document.root)) {
            if (node is FootnoteDefinitionBlock && node.isTopLevel) {
                // The first definition of a label wins; a later one is dropped.
                definitions.putIfAbsent(normalizeFootnoteLabel(node.label), node)
            } else {
                body.add(node)
            }
        }
        linkStateAtStart = findLinkStates(document)
        val context = MappingContext(insideCode = false, numbered = FootnoteNumbering())
        val blocks = mapBlocks(body, context, document)
        val footnotes = ArrayList<MarkdownFootnote>()
        // A footnote that only another footnote references is numbered while this loop runs, and
        // comes after the footnotes already waiting.
        var index = 0
        while (index < context.numbered.inOrder.size) {
            val footnote = context.numbered.inOrder[index]
            val footnoteDocument = parseFootnote(footnote.definition)
            val children = mapBlocks(childrenOf(footnoteDocument.root), context, footnoteDocument)
            footnotes.add(MarkdownFootnote(footnote.number, appendBackReference(children, footnote.number)))
            index++
        }
        return MarkdownDocument(mergeBlockTexts(blocks), footnotes.map { MarkdownFootnote(it.number, mergeBlockTexts(it.children)) })
    }

    /** Returns the parser of a text parsed apart from the message, which knows the message's link definitions. */
    private fun findFootnoteParser(): Parser = footnoteParser ?: buildParser(message.linkDefinitions).also { footnoteParser = it }

    /** Returns the parsed text of [definition]. */
    private fun parseFootnote(definition: FootnoteDefinitionBlock): SourceDocument =
        footnoteDocuments.getOrPut(definition) { SourceDocument(definition.text, findFootnoteParser().parse(definition.text)) }

    /**
     * Returns marked's `inLink` state at the start of each paragraph, heading and cell of the
     * message and its footnotes, or null when the message holds no `<a ` tag, so that the state
     * is closed at every start. marked keeps the state from one block to the next, and an `<a `
     * that no `</a>` closes leaves it open for the rest of the message. It reads the text of a
     * footnote where the footnote is defined, so the states are found in that order.
     */
    private fun findLinkStates(document: SourceDocument): IdentityHashMap<Node, Boolean>? {
        val definitionBlocks = definitions.values.toSet()
        fun mayOpenLink(input: SourceDocument): Boolean =
            listBlocks(input.root).any { block ->
                when {
                    block is FootnoteDefinitionBlock && block in definitionBlocks -> mayOpenLink(parseFootnote(block))
                    block is Paragraph || block is Heading || block is TableCell ->
                        listInlines(block).any { it is HtmlInline && advanceTagLinkState(it.literal, false) }
                    else -> false
                }
            }
        if (!mayOpenLink(document)) return null
        val states = IdentityHashMap<Node, Boolean>()
        var state = false
        fun walk(input: SourceDocument) {
            for (node in listBlocks(input.root)) {
                if (node is FootnoteDefinitionBlock && node in definitionBlocks) {
                    walk(parseFootnote(node))
                } else if (node is Paragraph || node is Heading || node is TableCell) {
                    states[node] = state
                    for (child in childrenOf(node)) state = advanceLinkState(child, state, input.text)
                }
            }
        }
        walk(document)
        return states
    }

    // -----------------------------------------------------------------------
    // Blocks
    // -----------------------------------------------------------------------

    /**
     * Returns the blocks for a list of block nodes. With embedded HTML, the tags in its HTML
     * blocks are matched into elements here, across blocks: a `<details>` in one block wraps the
     * paragraphs between it and its `</details>` in a later one.
     */
    private fun mapBlocks(allNodes: List<Node>, context: MappingContext, document: SourceDocument): List<MarkdownBlock> {
        val nodes = ArrayList<Node>(allNodes.size)
        for (node in allNodes) {
            val before = nodes.lastOrNull()
            if (node is Paragraph && before != null && takesLazyParagraph(before, node, document.text)) {
                lazyParagraphs[before] = node
            } else {
                nodes.add(node)
            }
        }
        if (!embeddedHtml) return nodes.flatMap { mapBlock(it, context, document) }
        return buildBlocksFromPieces(
            nodes.map { node ->
                if (node is HtmlBlock) {
                    HtmlPiece.Html(readHtmlBlockText(node, node.literal, document.text))
                } else {
                    HtmlPiece.Nodes { insideCode ->
                        mapBlock(node, if (insideCode) MappingContext(true, context.numbered) else context, document)
                    }
                }
            },
        )
    }

    /**
     * Returns where the first line of [source], the text of [paragraph], starts that starts a
     * footnote definition in marked, or -1 when none does. marked reads a list item line by line,
     * and starts a block at each line of a quote that continues a paragraph lazily, so a line
     * there that starts a definition starts one, though commonmark-java continues the paragraph
     * with it. Like any definition in a list or a quote, it defines nothing and shows as written.
     */
    private fun findDefinitionLine(paragraph: Paragraph, source: InlineSource): Int {
        if (paragraph.parent !is ListItem && paragraph.parent !is BlockQuote) return -1
        var lineStart = source.text.indexOf('\n') + 1
        while (lineStart > 0) {
            val lineEnd = source.text.indexOf('\n', lineStart).let { if (it == -1) source.text.length else it }
            if (startsFootnoteDefinition(source.text.substring(lineStart, lineEnd))) return lineStart
            if (lineEnd >= source.text.length) break
            lineStart = lineEnd + 1
        }
        return -1
    }

    /**
     * Returns the blocks for [paragraph], whose inline source is [source], from [first] and [start]
     * on, with [lead] in front: the paragraph, and a paragraph of the source of a footnote
     * definition that starts in it, see [findDefinitionLine].
     */
    private fun mapParagraph(
        paragraph: Paragraph,
        source: InlineSource,
        first: Node?,
        start: Int,
        lead: List<MarkdownInline>,
        context: MappingContext,
        document: SourceDocument,
    ): List<MarkdownBlock> {
        val definitionLine = findDefinitionLine(paragraph, source)
        val listEnd = listEndingLines[paragraph]?.let { source.findLineStart(it) - 1 }
        val end = listEnd ?: if (definitionLine == -1) source.text.length else definitionLine - 1
        val inlines = lead + mapInlines(first, source, start, end, context, document, linkStateAt(paragraph))
        if (definitionLine == -1 || listEnd != null) return mapParagraph(inlines)
        val raw = source.text.substring(definitionLine) + if (paragraph.next != null) "\n" else ""
        return mapParagraph(inlines) + MarkdownBlock.Paragraph(listOf(MarkdownInline.Text(trimListEnd(paragraph, raw))))
    }

    /** Returns a paragraph of [children], or no block when there are none. */
    private fun mapParagraph(children: List<MarkdownInline>): List<MarkdownBlock> =
        if (children.isEmpty()) emptyList() else listOf(MarkdownBlock.Paragraph(children))

    /**
     * Returns the blocks for one block node: one block in most cases, and none for a link
     * definition. A node this function does not know becomes a paragraph of its source. That
     * includes a footnote definition inside a quote, a list or a footnote, which defines nothing.
     */
    private fun mapBlock(node: Node, context: MappingContext, document: SourceDocument): List<MarkdownBlock> =
        nested {
            if (context.insideCode) {
                // Inside HTML code a block shows as written: a paragraph of its source.
                return@nested mapParagraph(
                    listOf(MarkdownInline.Text(decodeCharacterReferences(trimTrailingNewlines(readBlockSource(node, document.text))))),
                )
            }
            when (node) {
                is LinkReferenceDefinition -> emptyList()
                is Paragraph -> mapParagraph(node, buildParagraphSource(node, document.text), node.firstChild, 0, emptyList(), context, document)
                is Heading ->
                    if (node.sourceSpans.size > 1 && !isUnderlinedHeadingToMarked(node, document.text)) {
                        mapParagraph(mapLeafInlines(node, buildLinesSource(node, document.text), context, document))
                    } else {
                        listOf(MarkdownBlock.Heading(node.level, mapLeafInlines(node, buildHeadingSource(node, document.text), context, document)))
                    }
                is ThematicBreak -> listOf(MarkdownBlock.Rule)
                is BlockQuote -> listOf(MarkdownBlock.Blockquote(mapBlocks(childrenOf(node) + listOfNotNull(lazyParagraphs[node]), context, document)))
                is FencedCodeBlock -> listOf(MarkdownBlock.Code(trimListEnd(node, node.literal.removeSuffix("\n"))))
                is IndentedCodeBlock -> listOf(MarkdownBlock.Code(trimListEnd(node, readIndentedCode(node, document.text))))
                // The HTML is shown as written.
                is HtmlBlock ->
                    listOf(MarkdownBlock.Paragraph(listOf(MarkdownInline.Text(trimListEnd(node, trimTrailingNewlines(readHtmlBlockText(node, node.literal, document.text)))))))
                is ListBlock -> {
                    val ending = findListEndingLine(node, document.text)
                    if (ending != null) listEndingLines[ending.first] = ending.second
                    val list =
                        MarkdownBlock.List(
                            start = (node as? OrderedList)?.markerStartNumber,
                            loose = !node.isTight || hasBlankLineBetweenChildren(node),
                            items =
                                childrenOf(node).map { item ->
                                    val lazy = if (item.next == null) lazyParagraphs[node] else null
                                    MarkdownListItem(mapListItem(item as ListItem, lazy, context, document))
                                },
                        )
                    if (ending == null) {
                        listOf(list)
                    } else {
                        val (paragraph, line) = ending
                        val source = buildLinesFromLineStart(document.text, paragraph, line)
                        listOf(list) + mapParagraph(mapInlines(paragraph.firstChild, source, 0, source.text.length, context, document, false))
                    }
                }
                is TableBlock -> listOf(mapTable(node, context, document))
                is FootnoteDefinitionBlock -> listOf(MarkdownBlock.Paragraph(listOf(MarkdownInline.Text(trimListEnd(node, node.raw)))))
                else -> listOf(MarkdownBlock.Paragraph(listOf(MarkdownInline.Text(readBlockSource(node, document.text)))))
            }
        }

    /**
     * Checks whether marked reads [paragraph], the block after [block], as part of [block]: a
     * paragraph that starts on the line after a quote or a list. commonmark-java continues only
     * a paragraph lazily, but marked's quote and list take a line that starts no block after other
     * blocks too:
     *
     * - after a quote whose last block is a heading or a rule, or that ends in a line with
     *   something after its `>` and one space, such as `>\t`;
     * - after a list whose last item ends in an empty list or an empty quote. The paragraph then
     *   goes into that item.
     */
    private fun takesLazyParagraph(block: Node, paragraph: Paragraph, input: String): Boolean {
        val blockLast = block.sourceSpans.lastOrNull() ?: return false
        if (paragraph.sourceSpans.firstOrNull()?.lineIndex != blockLast.lineIndex + 1) return false
        return when (block) {
            is BlockQuote -> {
                val last = block.lastChild
                if (last != null && last !is Heading && last !is ThematicBreak) return false
                var start = blockLast.inputIndex
                val end = blockLast.inputIndex + blockLast.length
                while (start < end && input[start] == ' ') start++
                if (start >= end || input[start] != '>') return false
                start++
                if (start < end && input[start] == ' ') start++
                start < end
            }
            is ListBlock -> {
                val item = block.lastChild as? ListItem ?: return false
                val last = item.lastChild
                val endsEmpty = (last is ListBlock && last.lastChild?.firstChild == null) || (last is BlockQuote && last.firstChild == null)
                // A line that starts with `#` ends the list instead, see findListEndingLine.
                endsEmpty && !startsWithListEndingHash(paragraph.sourceSpans.first(), item, input)
            }
            else -> false
        }
    }

    /**
     * Returns the blocks for the contents of a list item. A task item, one whose first line starts
     * with `[ ]`, `[x]` or `[X]` and spaces and more text, gets a checkbox at the start of its
     * first paragraph, as marked reads it: the box is taken away before the line is read, so a
     * `[x]` that a link definition names is a box all the same.
     */
    private fun mapListItem(item: ListItem, lazy: Paragraph?, context: MappingContext, document: SourceDocument): List<MarkdownBlock> {
        val children = childrenOf(item) + listOfNotNull(lazy)
        val first = children.firstOrNull()
        if (first is Paragraph) {
            val source = buildParagraphSource(first, document.text)
            val contentStart = findTaskContentStart(source.text)
            if (contentStart != -1) {
                val inlines = childrenOf(first)
                // An element that ends inside the box goes with it; one that reaches past the box makes it no box.
                val rest = inlines.firstOrNull { child -> isTextLike(child) || (source.locate(child)?.let { it.last + 1 > contentStart } ?: true) }
                val restStart = rest?.takeUnless(::isTextLike)?.let { source.locate(it)?.first } ?: contentStart
                if (restStart >= contentStart) {
                    val checkbox = MarkdownInline.Checkbox(checked = source.text[1] != ' ')
                    val blocks = mapParagraph(first, source, rest, contentStart, listOf(checkbox), context, document)
                    return blocks + mapBlocks(children.drop(1), context, document)
                }
            }
        }
        return mapBlocks(children, context, document)
    }

    /**
     * Returns where the text of a task item starts after its box, or -1 when [text] does not start
     * with one: `[ ]`, `[x]` or `[X]`, one or more spaces, and a character that is not white space.
     */
    private fun findTaskContentStart(text: String): Int {
        if (text.length < 5 || text[0] != '[' || text[2] != ']' || (text[1] != ' ' && text[1] != 'x' && text[1] != 'X')) return -1
        var start = 3
        while (start < text.length && text[start] == ' ') start++
        return if (start > 3 && start < text.length && !isJavaScriptWhitespace(text[start])) start else -1
    }

    private fun mapTable(table: TableBlock, context: MappingContext, document: SourceDocument): MarkdownBlock {
        var header: List<MarkdownTableCell> = emptyList()
        val rows = ArrayList<List<MarkdownTableCell>>()
        for (section in childrenOf(table)) {
            for (row in childrenOf(section)) {
                val cells = mapTableRow(row as TableRow, header.size.takeIf { section is TableBody }, context, document)
                when (section) {
                    is TableHead -> header = cells
                    is TableBody -> rows.add(cells)
                }
            }
        }
        return MarkdownBlock.Table(header, rows)
    }

    /**
     * Returns the cells of a table row. [columnCount] is the header's, for a body row. When marked
     * splits the row into other cells than commonmark-java, as at `\\|`, which marked reads as a
     * backslash and the end of a cell, marked's cells are each read on their own.
     */
    private fun mapTableRow(row: TableRow, columnCount: Int?, context: MappingContext, document: SourceDocument): List<MarkdownTableCell> {
        val cells = childrenOf(row).map { it as TableCell }
        val texts = cells.map { cell -> findCellText(cell, document)?.let { (content, window) -> content.substring(window.first, window.last + 1) } ?: "" }
        val rowSpan = row.sourceSpans.firstOrNull()
        val markedTexts = rowSpan?.let { splitTableCells(document.text.substring(it.inputIndex, it.inputIndex + it.length), columnCount) }
        if (markedTexts == null || markedTexts == texts) return cells.map { mapTableCell(it, context, document) }
        return markedTexts.mapIndexed { column, text ->
            MarkdownTableCell(mapTextOnItsOwn(text, context), 1, cells.getOrNull(column)?.let(::readAlignment))
        }
    }

    /** Returns the alignment that a cell's column sets. */
    private fun readAlignment(cell: TableCell): ColumnAlignment? =
        when (cell.alignment) {
            TableCell.Alignment.LEFT -> ColumnAlignment.Left
            TableCell.Alignment.CENTER -> ColumnAlignment.Center
            TableCell.Alignment.RIGHT -> ColumnAlignment.Right
            null -> null
        }

    /**
     * Returns a cell's text as commonmark-java reads it, with `\|` turned into `|`, and where its
     * text starts and ends without the white space at its ends. Returns null for a cell that the
     * row does not hold, which commonmark-java adds empty.
     */
    private fun findCellText(cell: TableCell, document: SourceDocument): Pair<String, IntRange>? {
        val span = cell.sourceSpans.firstOrNull() ?: return null
        val content = document.text.substring(span.inputIndex, span.inputIndex + span.length).replace("\\|", "|")
        return Pair(content, findTrimmedRange(content))
    }

    /** Returns a table cell of one column, with the alignment its column's delimiter sets. */
    private fun mapTableCell(cell: TableCell, context: MappingContext, document: SourceDocument): MarkdownTableCell {
        val (content, window) = findCellText(cell, document) ?: return MarkdownTableCell(emptyList(), 1, readAlignment(cell))
        val source = InlineSource.forCell(content, cell.sourceSpans.first().inputIndex)
        val children = mapInlines(cell.firstChild, source, window.first, window.last + 1, context, document, linkStateAt(cell))
        return MarkdownTableCell(children, 1, readAlignment(cell))
    }

    /**
     * Returns the inlines of [text] read on its own, as marked reads a table cell's text: as the
     * paragraph it parses to, or as plain text when it parses to anything else, such as a heading.
     */
    private fun mapTextOnItsOwn(text: String, context: MappingContext): List<MarkdownInline> {
        val document = SourceDocument(text, findFootnoteParser().parse(text))
        val paragraph = document.root.firstChild
        if (paragraph is Paragraph && paragraph.next == null) {
            return mapLeafInlines(paragraph, buildParagraphSource(paragraph, text), context, document)
        }
        return mapPlainText(text, 0, text.length, text.length, breaks, linksBareUrls = true) { label -> referenceFootnote(label, context) }
    }

    /** Returns marked's `inLink` state at the start of [leaf], a paragraph, a heading or a cell. */
    private fun linkStateAt(leaf: Node): Boolean = linkStateAtStart?.get(leaf) ?: false

    /** Returns the inlines of a paragraph or a heading, whose inline source is [source]. */
    private fun mapLeafInlines(node: Node, source: InlineSource, context: MappingContext, document: SourceDocument): List<MarkdownInline> =
        mapInlines(node.firstChild, source, 0, source.text.length, context, document, linkStateAt(node))

    // -----------------------------------------------------------------------
    // Inlines
    // -----------------------------------------------------------------------

    /**
     * Returns the elements among the inline nodes from [first] on, which cover the characters of
     * [source] from [start] to [end], in order: the nodes that are not text, and the footnote
     * references that reach across nodes. client-core's extension reads a reference from the raw
     * text before marked reads anything inside it, so `[^"><b>x</b>]` is one reference when the
     * message defines its label, though commonmark-java reads HTML in it. The nodes inside such a
     * reference are left out.
     */
    private fun findElements(first: Node?, source: InlineSource, start: Int, end: Int): List<InlineElement> {
        val nodes = siblingsFrom(first).mapNotNull { node ->
            // A node before the source's first line belongs to the part of a paragraph that another source covers.
            if (isTextLike(node) || (node.sourceSpans.firstOrNull()?.inputIndex ?: 0) < source.firstInputIndex) null
            else source.locate(node)?.takeIf { it.first < end }?.let { InlineElement(node, null, it.first, it.last + 1) }
        }
        if (definitions.isEmpty() || source.text.indexOf("[^", start).let { it == -1 || it >= end }) return nodes
        val elements = ArrayList<InlineElement>(nodes.size)
        var gapStart = start
        var index = 0
        while (gapStart < end) {
            while (index < nodes.size && nodes[index].start < gapStart) index++
            val gapEnd = if (index < nodes.size) nodes[index].start else end
            val crossing = findCrossingReference(source.text, gapStart, gapEnd, end)
            if (crossing != null) {
                elements.add(crossing)
                gapStart = crossing.end
                continue
            }
            if (index >= nodes.size) break
            elements.add(nodes[index])
            gapStart = maxOf(nodes[index].end, gapStart)
            index++
        }
        return elements
    }

    /**
     * Returns the first footnote reference that starts in the plain text of [text] from [start]
     * to [gapEnd] and ends past it, before [end], to a footnote the message defines. Returns null
     * when there is none.
     */
    private fun findCrossingReference(text: String, start: Int, gapEnd: Int, end: Int): InlineElement? {
        var position = text.indexOf("[^", start)
        while (position != -1 && position < gapEnd) {
            var backslashes = 0
            while (position - backslashes - 1 >= start && text[position - backslashes - 1] == '\\') backslashes++
            if (backslashes % 2 == 0) {
                val syntax = readFootnoteReference(text, position, end)
                if (syntax != null && syntax.end > gapEnd && normalizeFootnoteLabel(syntax.label) in definitions) {
                    return InlineElement(null, syntax.label, position, syntax.end)
                }
            }
            position = text.indexOf("[^", position + 1)
        }
        return null
    }

    /**
     * Returns the nodes for the inline nodes from [first] on, which cover the characters of
     * [source] from [start] to [end]. [inLink] is marked's `inLink` state at [start]. With embedded
     * HTML, the tags among them are matched into elements here, so that `<strong>` and
     * `</strong>` in separate nodes wrap the nodes between them.
     *
     * The nodes between two tags are one piece. Inside an HTML `code` element the piece is their
     * source, decoded once.
     */
    private fun mapInlines(
        first: Node?,
        source: InlineSource,
        start: Int,
        end: Int,
        context: MappingContext,
        document: SourceDocument,
        inLink: Boolean,
    ): List<MarkdownInline> {
        val elements = findElements(first, source, start, end)
        if (!embeddedHtml) return mapRun(elements, source, start, end, end, context, document, inLink)
        val pieces = ArrayList<HtmlPiece<MarkdownInline>>()
        var runStart = start
        var run = ArrayList<InlineElement>()
        var state = inLink
        var runState = inLink
        fun endRun(runEnd: Int) {
            val runElements = run
            val from = runStart
            val stateAtStart = runState
            run = ArrayList()
            if (runEnd <= from) return
            pieces.add(
                HtmlPiece.Nodes { insideCode ->
                    if (insideCode || context.insideCode) listOf(MarkdownInline.Text(decodeCharacterReferences(source.text.substring(from, runEnd))))
                    else mapRun(runElements, source, from, runEnd, end, context, document, stateAtStart)
                },
            )
        }
        for (element in elements) {
            val node = element.node
            if (node is HtmlInline) {
                endRun(element.start)
                pieces.add(HtmlPiece.Html(node.literal))
                state = advanceTagLinkState(node.literal, state)
                runStart = element.end
                runState = state
            } else {
                run.add(element)
                if (node != null) state = advanceLinkState(node, state, document.text)
            }
        }
        endRun(end)
        return buildInlinesFromPieces(pieces)
    }

    /**
     * Returns the nodes for a run of inline [elements] that covers the characters of [source] from
     * [start] to [end]. The text between two elements, and before the first and after the last, is
     * read from the source by marked's rules, see [mapPlainText]. [sourceEnd] is where the inline
     * source that holds the run ends, which those rules look ahead to, and [inLink] is marked's
     * `inLink` state at [start].
     */
    private fun mapRun(
        elements: List<InlineElement>,
        source: InlineSource,
        start: Int,
        end: Int,
        sourceEnd: Int,
        context: MappingContext,
        document: SourceDocument,
        inLink: Boolean,
    ): List<MarkdownInline> {
        val out = ArrayList<MarkdownInline>()
        var position = start
        var state = inLink
        val reference = { label: String -> referenceFootnote(label, context) }
        for (element in elements) {
            // A bare URL in the text before may have run on over this element, see readPlainText.
            if (element.start < position) continue
            val elementEnd = maxOf(element.end, element.start)
            val before = readPlainText(source.text, position, element.start, end, sourceEnd, breaks, linksBareUrls = !state, reference)
            out.addAll(before.nodes)
            position = before.end
            if (element.start < position) continue
            val elementStart = element.start
            val node = element.node
            if (node == null) {
                out.addAll(listOfNotNull(element.label?.let(reference)))
            } else {
                out.addAll(mapElement(node, source, elementStart, elementEnd, sourceEnd, context, document, state))
                state = advanceLinkState(node, state, document.text)
            }
            position = elementEnd
        }
        out.addAll(mapPlainText(source.text, position, end, sourceEnd, breaks, linksBareUrls = !state, reference))
        return out
    }

    /**
     * Returns the nodes for one inline element that covers the characters of [source] from
     * [start] to [end]: one node in most cases, and the link's children for a link with an unsafe
     * address.
     */
    private fun mapElement(
        node: Node,
        source: InlineSource,
        start: Int,
        end: Int,
        sourceEnd: Int,
        context: MappingContext,
        document: SourceDocument,
        inLink: Boolean,
    ): List<MarkdownInline> =
        nested {
            when (node) {
                is Emphasis -> listOf(MarkdownInline.Emphasis(mapDelimitedChildren(node, source, start, end, context, document, inLink)))
                is StrongEmphasis -> listOf(MarkdownInline.Strong(mapDelimitedChildren(node, source, start, end, context, document, inLink)))
                is Strikethrough -> listOf(MarkdownInline.Strikethrough(mapDelimitedChildren(node, source, start, end, context, document, inLink)))
                is Code -> listOf(MarkdownInline.InlineCode(node.literal))
                is Link -> mapLink(node, source, start, end, sourceEnd, context, document, inLink)
                is Image -> mapImage(node, source, start, end, sourceEnd, context, document, inLink)
                // With embedded HTML off, a tag is shown as written.
                is HtmlInline -> listOf(MarkdownInline.Text(node.literal))
                else -> listOf(MarkdownInline.Text(source.text.substring(start, end)))
            }
        }

    /** Returns the children of an emphasis or a strikethrough, whose markers are on both sides of them. */
    private fun mapDelimitedChildren(
        node: Node,
        source: InlineSource,
        start: Int,
        end: Int,
        context: MappingContext,
        document: SourceDocument,
        inLink: Boolean,
    ): List<MarkdownInline> {
        val marker = (node as Delimited).openingDelimiter.length
        return mapInlines(node.firstChild, source, start + marker, maxOf(start + marker, end - marker), context, document, inLink)
    }

    /**
     * Returns the node for a reference to the footnote [label], or null when the message defines
     * no such footnote: then the brackets keep their ordinary meaning. The first reference to a
     * footnote gives it the next number. A port of `mapFootnoteReference` in
     * packages/client-core/src/markdown.ts.
     */
    private fun referenceFootnote(label: String, context: MappingContext): MarkdownInline? {
        val normalized = normalizeFootnoteLabel(label)
        val definition = definitions[normalized] ?: return null
        val earlier = context.numbered.byLabel[normalized]
        val number = earlier?.number ?: (context.numbered.inOrder.size + 1)
        if (earlier == null) {
            val footnote = NumberedFootnote(number, definition)
            context.numbered.byLabel[normalized] = footnote
            context.numbered.inOrder.add(footnote)
        }
        return MarkdownInline.FootnoteReference(number, isFirstReference = earlier == null)
    }

    /** Returns where the text of a link or an image ends, at its `]`, after its last child. */
    private fun findLinkTextEnd(node: Node, source: InlineSource, textStart: Int, end: Int): Int {
        var after = textStart
        for (child in childrenOf(node)) source.locate(child)?.let { after = maxOf(after, it.last + 1) }
        val close = source.text.indexOf(']', after)
        return if (close == -1 || close >= end) after else close
    }

    /**
     * Returns the address and the title of a link or an image, as marked reads them from its
     * source: unescaped, with their character references still in.
     */
    private fun readDestination(node: Node, source: InlineSource, textStart: Int, textEnd: Int, end: Int, document: SourceDocument): Pair<String, String?> {
        val afterText = textEnd + 1
        if (afterText < end && source.text[afterText] == '(') return splitDestinationAndTitle(source.text.substring(afterText + 1, end - 1))
        val label =
            if (afterText < end && source.text[afterText] == '[') {
                source.text.substring(afterText + 1, findClosingBracket(source.text, afterText + 1, end)).takeIf { it.isNotBlank() }
            } else {
                null
            } ?: source.text.substring(textStart, textEnd)
        val key = Escaping.normalizeLabelContent(label)
        val sourced = document.linkDefinitions[key] ?: message.linkDefinitions[key]
        if (sourced == null) {
            val destination = (node as? Link)?.destination ?: (node as? Image)?.destination ?: ""
            return Pair(destination, (node as? Link)?.title ?: (node as? Image)?.title)
        }
        return readDefinitionDestination(readBlockSource(sourced.definition, sourced.source))
    }

    /** Returns the index of the first `]` from [start] that no backslash escapes, or [end]. */
    private fun findClosingBracket(text: String, start: Int, end: Int): Int {
        var position = start
        while (position < end) {
            when (text[position]) {
                '\\' -> position += 2
                ']' -> return position
                else -> position++
            }
        }
        return minOf(position, end)
    }

    /** Returns the address and title of a link definition's source, `[label]: address "title"`. */
    private fun readDefinitionDestination(source: String): Pair<String, String?> {
        val labelEnd = findClosingBracket(source, source.indexOf('[') + 1, source.length)
        return splitDestinationAndTitle(source.substring(minOf(labelEnd + 2, source.length)))
    }

    /**
     * Splits the part of a link after its text, without the parentheses, into its address and its
     * title, as marked does: the address is `<...>` or the characters up to white space, and the
     * title is what follows, without its quotes or parentheses. Both are unescaped.
     */
    private fun splitDestinationAndTitle(part: String): Pair<String, String?> {
        var position = 0
        while (position < part.length && part[position].code <= 0x20) position++
        val href: String
        if (position < part.length && part[position] == '<') {
            var close = position + 1
            while (close < part.length && part[close] != '>') close += if (part[close] == '\\') 2 else 1
            href = part.substring(position + 1, minOf(close, part.length))
            position = minOf(close + 1, part.length)
        } else {
            val hrefStart = position
            while (position < part.length && part[position].code > 0x20) position++
            href = part.substring(hrefStart, position)
        }
        val rest = part.substring(position).trim { it.code <= 0x20 }
        val title = if (rest.length >= 2) rest.substring(1, rest.length - 1) else null
        return Pair(unescapePunctuation(href), title?.let(::unescapePunctuation))
    }

    /** Returns the title of a link or an image with its character references decoded, or null when it has none. */
    private fun decodeTitle(title: String?): String? = if (title.isNullOrEmpty()) null else decodeCharacterReferences(title)

    /**
     * Returns the nodes for a link or an image that marked does not read as one, though
     * commonmark-java does: [opening], its children as text that is no link, and the rest of its
     * source as plain text. This happens when brackets nest too deep in its text.
     */
    private fun mapAsText(
        node: Node,
        opening: String,
        source: InlineSource,
        textStart: Int,
        textEnd: Int,
        end: Int,
        sourceEnd: Int,
        context: MappingContext,
        document: SourceDocument,
        inLink: Boolean,
    ): List<MarkdownInline> =
        listOf(MarkdownInline.Text(opening)) +
            mapInlines(node.firstChild, source, textStart, textEnd, context, document, inLink) +
            mapPlainText(source.text, textEnd, end, sourceEnd, breaks, linksBareUrls = !inLink) { label -> referenceFootnote(label, context) }

    /**
     * Returns the nodes for a footnote reference that commonmark-java read as a link or image, as
     * in `[^1](/v)`: marked reads the reference first, then the rest as plain text. [prefix] is
     * the `!` of an image. Returns null when the link's text is no reference to a footnote the
     * message defines.
     */
    private fun mapAsFootnoteReference(
        prefix: String,
        source: InlineSource,
        textStart: Int,
        textEnd: Int,
        end: Int,
        sourceEnd: Int,
        context: MappingContext,
    ): List<MarkdownInline>? {
        val syntax = readFootnoteReference(source.text, textStart - 1, textEnd + 1) ?: return null
        if (syntax.end != textEnd + 1) return null
        val reference = referenceFootnote(syntax.label, context) ?: return null
        val rest = mapPlainText(source.text, textEnd + 1, end, sourceEnd, breaks, linksBareUrls = true) { label -> referenceFootnote(label, context) }
        return listOfNotNull(prefix.takeIf { it.isNotEmpty() }?.let { MarkdownInline.Text(it) }, reference) + rest
    }

    private fun mapLink(
        node: Link,
        source: InlineSource,
        start: Int,
        end: Int,
        sourceEnd: Int,
        context: MappingContext,
        document: SourceDocument,
        inLink: Boolean,
    ): List<MarkdownInline> {
        if (source.text[start] == '<') {
            // An autolink. Its address and text are literal: no character references.
            val text = source.text.substring(start + 1, maxOf(start + 1, end - 1))
            val href = normalizeAddress(node.destination)
            val children = listOf(MarkdownInline.Text(text))
            return if (isSafeAddress(href)) listOf(MarkdownInline.Link(href, null, children)) else children
        }
        val textStart = start + 1
        val textEnd = findLinkTextEnd(node, source, textStart, end)
        mapAsFootnoteReference("", source, textStart, textEnd, end, sourceEnd, context)?.let { return it }
        if (measureBracketNesting(source.text, textStart, textEnd) > MAX_LINK_TEXT_BRACKET_NESTING) {
            return mapAsText(node, "[", source, textStart, textEnd, end, sourceEnd, context, document, inLink)
        }
        val children = mapInlines(node.firstChild, source, textStart, textEnd, context, document, inLink = true)
        val (rawHref, rawTitle) = readDestination(node, source, textStart, textEnd, end, document)
        val href = normalizeAddress(decodeCharacterReferences(rawHref))
        // A link holds no link: the one around an HTML link in the text wins.
        return if (isSafeAddress(href)) listOf(MarkdownInline.Link(href, decodeTitle(rawTitle), removeNestedLinks(children))) else children
    }

    private fun mapImage(
        node: Image,
        source: InlineSource,
        start: Int,
        end: Int,
        sourceEnd: Int,
        context: MappingContext,
        document: SourceDocument,
        inLink: Boolean,
    ): List<MarkdownInline> {
        val textStart = start + 2
        val textEnd = findLinkTextEnd(node, source, textStart, end)
        mapAsFootnoteReference("!", source, textStart, textEnd, end, sourceEnd, context)?.let { return it }
        if (measureBracketNesting(source.text, textStart, textEnd) > MAX_LINK_TEXT_BRACKET_NESTING) {
            return mapAsText(node, "![", source, textStart, textEnd, end, sourceEnd, context, document, inLink)
        }
        // The alt text is plain text, so a footnote reference in it must not take a number. It is
        // mapped with numbering of its own, which is thrown away.
        val altContext = MappingContext(context.insideCode, FootnoteNumbering())
        val alt = extractPlainText(mapInlines(node.firstChild, source, textStart, textEnd, altContext, document, inLink = true))
        val (rawSrc, rawTitle) = readDestination(node, source, textStart, textEnd, end, document)
        val src = normalizeAddress(decodeCharacterReferences(rawSrc))
        if (isSafeAddress(src)) return listOf(MarkdownInline.Image(src, alt, decodeTitle(rawTitle)))
        return if (alt.isEmpty()) emptyList() else listOf(MarkdownInline.Text(alt))
    }
}

/**
 * Returns [text] with each backslash before a punctuation or symbol character removed, as marked
 * unescapes a link's address and title: its `anyPunctuation` rule takes any Unicode punctuation
 * or symbol, not only ASCII.
 */
private fun unescapePunctuation(text: String): String {
    if ('\\' !in text) return text
    val out = StringBuilder(text.length)
    var index = 0
    while (index < text.length) {
        val character = text[index]
        if (character == '\\' && index + 1 < text.length) {
            val codePoint = text.codePointAt(index + 1)
            if (isPunctuationOrSymbol(codePoint)) {
                out.appendCodePoint(codePoint)
                index += 1 + Character.charCount(codePoint)
                continue
            }
        }
        out.append(character)
        index++
    }
    return out.toString()
}

/**
 * Checks whether [codePoint] is in one of Unicode's punctuation or symbol categories, as
 * JavaScript's `[\p{P}\p{S}]` reads it. The categories come from the platform's Unicode tables,
 * which may be of another Unicode version than the JavaScript engine's for a new character.
 */
private fun isPunctuationOrSymbol(codePoint: Int): Boolean =
    when (Character.getType(codePoint).toByte()) {
        Character.CONNECTOR_PUNCTUATION,
        Character.DASH_PUNCTUATION,
        Character.START_PUNCTUATION,
        Character.END_PUNCTUATION,
        Character.INITIAL_QUOTE_PUNCTUATION,
        Character.FINAL_QUOTE_PUNCTUATION,
        Character.OTHER_PUNCTUATION,
        Character.MATH_SYMBOL,
        Character.CURRENCY_SYMBOL,
        Character.MODIFIER_SYMBOL,
        Character.OTHER_SYMBOL,
        -> true
        else -> false
    }

/**
 * Returns the blocks of a footnote with its back reference at the end: in the last block when
 * that is a paragraph, and in a paragraph of its own when not. A port of `appendBackReference` in
 * packages/client-core/src/markdown.ts.
 */
private fun appendBackReference(blocks: List<MarkdownBlock>, number: Int): List<MarkdownBlock> {
    val backReference = MarkdownInline.FootnoteBackReference(number)
    val last = blocks.lastOrNull()
    if (last is MarkdownBlock.Paragraph) return blocks.dropLast(1) + MarkdownBlock.Paragraph(last.children + backReference)
    return blocks + MarkdownBlock.Paragraph(listOf(backReference))
}

/**
 * Returns [inlines] with each run of adjacent texts joined into one text, at every depth: inside
 * strong, emphasis, strikethrough and link children too. A break, inline code, an image or a
 * footnote's mark ends a run. Joining makes the tree the same however the text was split, so
 * client-core and this port build equal trees. Each run is joined once.
 *
 * A port of `mergeAdjacentTexts` in packages/client-core/src/markdown.ts.
 */
private fun mergeAdjacentTexts(inlines: List<MarkdownInline>): List<MarkdownInline> {
    val merged = ArrayList<MarkdownInline>(inlines.size)
    val run = StringBuilder()
    var inRun = false
    for (inline in inlines) {
        if (inline is MarkdownInline.Text) {
            run.append(inline.text)
            inRun = true
            continue
        }
        if (inRun) {
            merged.add(MarkdownInline.Text(run.toString()))
            run.setLength(0)
            inRun = false
        }
        merged.add(
            when (inline) {
                is MarkdownInline.Strong -> MarkdownInline.Strong(mergeAdjacentTexts(inline.children))
                is MarkdownInline.Emphasis -> MarkdownInline.Emphasis(mergeAdjacentTexts(inline.children))
                is MarkdownInline.Strikethrough -> MarkdownInline.Strikethrough(mergeAdjacentTexts(inline.children))
                is MarkdownInline.Link -> inline.copy(children = mergeAdjacentTexts(inline.children))
                else -> inline
            },
        )
    }
    if (inRun) merged.add(MarkdownInline.Text(run.toString()))
    return merged
}

/** Returns [cells] with the texts of each cell joined, see [mergeAdjacentTexts]. */
private fun mergeCellTexts(cells: List<MarkdownTableCell>): List<MarkdownTableCell> = cells.map { it.copy(children = mergeAdjacentTexts(it.children)) }

/**
 * Returns [blocks] with the texts of every run of inlines in them joined, see
 * [mergeAdjacentTexts]. A port of `mergeBlockTexts` in packages/client-core/src/markdown.ts.
 */
private fun mergeBlockTexts(blocks: List<MarkdownBlock>): List<MarkdownBlock> =
    blocks.map { block ->
        when (block) {
            is MarkdownBlock.Paragraph -> MarkdownBlock.Paragraph(mergeAdjacentTexts(block.children))
            is MarkdownBlock.Heading -> block.copy(children = mergeAdjacentTexts(block.children))
            is MarkdownBlock.List -> block.copy(items = block.items.map { MarkdownListItem(mergeBlockTexts(it.children)) })
            is MarkdownBlock.Blockquote -> MarkdownBlock.Blockquote(mergeBlockTexts(block.children))
            is MarkdownBlock.Table -> MarkdownBlock.Table(mergeCellTexts(block.header), block.rows.map(::mergeCellTexts))
            is MarkdownBlock.Details -> MarkdownBlock.Details(mergeAdjacentTexts(block.summary), mergeBlockTexts(block.children))
            is MarkdownBlock.Code, MarkdownBlock.Rule -> block
        }
    }
