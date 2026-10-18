package dev.hercule.android.markdown

/*
 * Turns the HTML that GitHub comments hold inside markdown into the nodes of the markdown tree. A
 * port of packages/client-core/src/markdown-html.ts, function by function; see that file for the
 * full list of what each element becomes. In short:
 *
 * - An allowlist of elements becomes the node of the same meaning: `strong`, `em`, `del`, `code`,
 *   `br`, `a`, `img`, `p`, `div`, `h1` to `h6`, `blockquote`, `ul`, `ol`, `li`, `hr`, `pre`, the
 *   table elements, `details` and `summary`.
 * - Comments are dropped, and so is a `script` or `style` element whose two tags are in one piece.
 *   Any other standard element is dropped with its text kept.
 * - A tag whose name is not a standard HTML element name, or that mixes cases, stays text.
 *
 * Nothing is ever drawn as HTML: the reader only builds tree nodes. The caller hands one level of
 * markdown nodes over as pieces, in order, and the tags are matched across the pieces.
 */

/**
 * One piece of a level of markdown nodes, in order: nodes the markdown parser makes, or the
 * source of a piece of HTML.
 *
 * The nodes are made on demand. [Nodes.createNodes] is called once, in the order of the pieces,
 * and is told whether an HTML `code` or `pre` element is open at that point, where markup shows as
 * written and a footnote reference takes no number.
 */
sealed interface HtmlPiece<out Node> {
    class Nodes<Node>(val createNodes: (insideCode: Boolean) -> List<Node>) : HtmlPiece<Node>

    class Html(val html: String) : HtmlPiece<Nothing>
}

/**
 * Returns the blocks for pieces of block nodes, with each HTML element that the pieces open
 * wrapping the pieces up to its closing tag. Text that HTML leaves outside any block becomes a
 * paragraph. Returns the nodes unchanged when no piece is HTML.
 *
 * A port of `buildBlocksFromPieces` in packages/client-core/src/markdown-html.ts.
 */
fun buildBlocksFromPieces(pieces: List<HtmlPiece<MarkdownBlock>>): List<MarkdownBlock> =
    if (hasHtml(pieces)) convertToBlocks(nestPieces(pieces, ::wrapBlock))
    else pieces.flatMap { piece -> if (piece is HtmlPiece.Nodes) piece.createNodes(false) else emptyList() }

/**
 * Returns the inlines for pieces of inline nodes, with each HTML element that the pieces open
 * wrapping the pieces up to its closing tag. A block element in a line is flattened to inlines.
 * Returns the nodes unchanged when no piece is HTML.
 *
 * A port of `buildInlinesFromPieces` in packages/client-core/src/markdown-html.ts.
 */
fun buildInlinesFromPieces(pieces: List<HtmlPiece<MarkdownInline>>): List<MarkdownInline> =
    if (hasHtml(pieces)) convertToInlines(nestPieces(pieces, ::wrapInline))
    else pieces.flatMap { piece -> if (piece is HtmlPiece.Nodes) piece.createNodes(false) else emptyList() }

private fun hasHtml(pieces: List<HtmlPiece<*>>): Boolean = pieces.any { it is HtmlPiece.Html }

// ---------------------------------------------------------------------------
// Scanning: HTML source to tags and text
// ---------------------------------------------------------------------------

/**
 * The standard HTML element names, in lower case: the elements of the HTML Living Standard, plus
 * the old ones that comments still use (`center`, `font`, `big`, `tt`, `strike`, `acronym`). `svg`
 * and `math` are left out, as GitHub removes them.
 */
private val HTML_ELEMENT_NAMES: Set<String> =
    hashSetOf(
        "a", "abbr", "acronym", "address", "area", "article", "aside", "audio", "b", "base", "bdi",
        "bdo", "big", "blockquote", "body", "br", "button", "canvas", "caption", "center", "cite",
        "code", "col", "colgroup", "data", "datalist", "dd", "del", "details", "dfn", "dialog", "div",
        "dl", "dt", "em", "embed", "fieldset", "figcaption", "figure", "font", "footer", "form", "h1",
        "h2", "h3", "h4", "h5", "h6", "head", "header", "hgroup", "hr", "html", "i", "iframe", "img",
        "input", "ins", "kbd", "label", "legend", "li", "link", "main", "map", "mark", "menu", "meta",
        "meter", "nav", "noscript", "object", "ol", "optgroup", "option", "output", "p", "param",
        "picture", "pre", "progress", "q", "rp", "rt", "ruby", "s", "samp", "script", "search",
        "section", "select", "slot", "small", "source", "span", "strike", "strong", "style", "sub",
        "summary", "sup", "table", "tbody", "td", "template", "textarea", "tfoot", "th", "thead",
        "time", "title", "tr", "track", "tt", "u", "ul", "var", "video", "wbr",
    )

/**
 * Checks whether a tag name, as written, is a standard HTML element. The name must be in
 * [HTML_ELEMENT_NAMES] and written all in lower case or all in upper case, so `<Button>` (a
 * component) is not HTML but `<BUTTON>` is.
 */
private fun isHtmlElementName(name: String): Boolean {
    val lowercase = name.lowercase()
    return (name == lowercase || name == name.uppercase()) && lowercase in HTML_ELEMENT_NAMES
}

/**
 * What an HTML source is made of. Text and attribute values have their character references
 * decoded, except the text of a tag that is not HTML, which is kept as written.
 */
private sealed interface HtmlToken {
    class Text(val text: String) : HtmlToken

    /** An open tag. [name] is in lower case, and [attributes] are by lower-case name; when one is written twice, the first wins. */
    class OpenTag(val name: String, val attributes: Map<String, String>, val selfClosing: Boolean) : HtmlToken

    class CloseTag(val name: String) : HtmlToken
}

private fun isHtmlSpace(character: Char): Boolean =
    character == ' ' || character == '\t' || character == '\n' || character == '\r' || character == '\u000C'

/** Returns the character of [text] at [index], or null past its end. */
private fun String.charOrNull(index: Int): Char? = if (index < length) this[index] else null

/**
 * Returns the index where the name that starts at [start] ends: at the first space, `/`, `>` or
 * `<`, or at the end of [html]. A `<` ends the name, so that a long run of `<a<a<a` is read in one
 * pass.
 */
private fun findNameEnd(html: String, start: Int): Int {
    var end = start
    while (end < html.length && !isHtmlSpace(html[end]) && html[end] != '/' && html[end] != '>' && html[end] != '<') end++
    return end
}

/** The result of reading a tag: the index after it, and its token. Comments and declarations have no token. */
private class TagRead(val end: Int, val token: HtmlToken? = null)

/**
 * Reads the open tag whose name starts at [start], with its attributes, as an HTML parser does:
 * attribute values are quoted, unquoted or missing, and a stray `/` is ignored. Returns the end of
 * [html] and no token when the tag never closes.
 */
private fun readOpenTag(html: String, start: Int): TagRead {
    val nameEnd = findNameEnd(html, start)
    val name = html.substring(start, nameEnd).lowercase()
    val attributes = HashMap<String, String>()
    var position = nameEnd
    while (position < html.length) {
        while (position < html.length && isHtmlSpace(html[position])) position++
        val character = html.charOrNull(position) ?: break
        if (character == '>') return TagRead(position + 1, HtmlToken.OpenTag(name, attributes, selfClosing = false))
        if (character == '/') {
            if (html.charOrNull(position + 1) == '>') {
                return TagRead(position + 2, HtmlToken.OpenTag(name, attributes, selfClosing = true))
            }
            position++
            continue
        }
        // An attribute name. A name may start with "=" and still has to move on.
        val attributeStart = position
        position++
        while (
            position < html.length &&
            !isHtmlSpace(html[position]) &&
            html[position] != '/' &&
            html[position] != '>' &&
            html[position] != '='
        ) {
            position++
        }
        val attributeName = html.substring(attributeStart, position).lowercase()
        while (position < html.length && isHtmlSpace(html[position])) position++
        var value = ""
        if (html.charOrNull(position) == '=') {
            position++
            while (position < html.length && isHtmlSpace(html[position])) position++
            val quote = html.charOrNull(position)
            if (quote == '"' || quote == '\'') {
                val close = html.indexOf(quote, position + 1)
                if (close == -1) break
                value = html.substring(position + 1, close)
                position = close + 1
            } else {
                val valueStart = position
                while (position < html.length && !isHtmlSpace(html[position]) && html[position] != '>') position++
                value = html.substring(valueStart, position)
            }
        }
        if (attributeName !in attributes) attributes[attributeName] = decodeCharacterReferences(value)
    }
    return TagRead(html.length)
}

/**
 * Reads a tag that is not HTML, such as `<T>` in `Array<T>`, as text exactly as written, up to
 * the next `>`. Returns null when no `>` follows, so that the `<` stays plain text too.
 */
private fun readTagAsText(html: String, start: Int, findGreaterThan: (Int) -> Int): TagRead? {
    val close = findGreaterThan(start)
    if (close == -1) return null
    return TagRead(close + 1, HtmlToken.Text(html.substring(start, close + 1)))
}

/** Reads what starts with the `<` at [start]. Returns null when it is not markup, such as the `<` in `a < b`. */
private fun readMarkup(html: String, start: Int, findGreaterThan: (Int) -> Int): TagRead? {
    if (html.startsWith("<!--", start)) {
        val close = html.indexOf("-->", start + 4)
        return TagRead(if (close == -1) html.length else close + 3)
    }
    val next = html.charOrNull(start + 1)
    if (next == '!' || next == '?') {
        // A declaration such as <!DOCTYPE html>, or a processing instruction.
        val close = html.indexOf('>', start)
        return TagRead(if (close == -1) html.length else close + 1)
    }
    if (next == '/' && html.charOrNull(start + 2)?.let(::isAsciiLetter) == true) {
        val nameEnd = findNameEnd(html, start + 2)
        val name = html.substring(start + 2, nameEnd)
        if (!isHtmlElementName(name)) return readTagAsText(html, start, findGreaterThan)
        val close = html.indexOf('>', nameEnd)
        if (close == -1) return TagRead(html.length)
        return TagRead(close + 1, HtmlToken.CloseTag(name.lowercase()))
    }
    if (next != null && isAsciiLetter(next)) {
        val nameEnd = findNameEnd(html, start + 1)
        if (!isHtmlElementName(html.substring(start + 1, nameEnd))) return readTagAsText(html, start, findGreaterThan)
        return readOpenTag(html, start + 1)
    }
    return null
}

/**
 * Splits [html] into text, open tags and close tags, in order. Comments and declarations are left
 * out. A tag that is not HTML becomes text. The end of [html] cuts off a comment, a tag or a quoted
 * attribute value that is still open there, and the cut-off part is dropped. It takes time linear
 * in the length of [html].
 */
private fun scanHtmlTags(html: String): List<HtmlToken> {
    val tokens = ArrayList<HtmlToken>()
    var textStart = 0
    var position = 0
    // The index of the first ">" at or after the last search. -2 before the first search and -1
    // when none is left. The start of each tag is later than the one before, so one search can
    // serve many tags and the scan stays linear.
    var greaterThan = -2
    val findGreaterThan = { from: Int ->
        if (greaterThan == -2 || (greaterThan != -1 && greaterThan < from)) greaterThan = html.indexOf('>', from)
        greaterThan
    }
    fun addText(end: Int) {
        if (end > textStart) tokens.add(HtmlToken.Text(decodeCharacterReferences(html.substring(textStart, end))))
    }
    while (true) {
        val start = html.indexOf('<', position)
        if (start == -1) break
        val read = readMarkup(html, start, findGreaterThan)
        if (read == null) {
            position = start + 1
            continue
        }
        addText(start)
        read.token?.let(tokens::add)
        textStart = read.end
        position = read.end
    }
    addText(html.length)
    return tokens
}

// ---------------------------------------------------------------------------
// Nesting: matching open and close tags into elements
// ---------------------------------------------------------------------------

/** One cell of an HTML table: its inlines, the columns it covers, its alignment, and whether it is a `th`. */
private data class HtmlTableCell(
    val inlines: List<MarkdownInline>,
    val columnSpan: Int,
    val align: ColumnAlignment?,
    val isHeader: Boolean,
)

/**
 * What an element, or a node from the markdown parser, leaves in the element around it. Most are
 * a block or an inline. The others are the parts of a list, a details block and a table, which
 * their own parent reads. A part that its parent does not read, or that has no parent, is plain
 * content: a list item is its blocks, and a summary, a cell or a row is its inlines.
 */
private sealed interface ElementContent {
    class Block(val block: MarkdownBlock) : ElementContent

    class Inline(val inline: MarkdownInline) : ElementContent

    class ListItem(val blocks: List<MarkdownBlock>) : ElementContent

    class Summary(val inlines: List<MarkdownInline>) : ElementContent

    class Cell(val cell: HtmlTableCell) : ElementContent

    /** A table row. [isHeader] is whether the row is in a `thead`. */
    class Row(val cells: List<HtmlTableCell>, val isHeader: Boolean) : ElementContent
}

/**
 * An element whose closing tag has not come yet, with what it holds so far.
 *
 * - [preservesSpace] is whether the element is a `pre` or inside one, where spaces and line breaks
 *   show as written.
 * - [insideCode] is whether the element is a `code` or a `pre` or inside one: the markup in it
 *   shows as written.
 */
private class OpenElement(
    val tag: String,
    val attributes: Map<String, String>,
    val preservesSpace: Boolean,
    val insideCode: Boolean,
) {
    val content = ArrayList<ElementContent>()
}

private fun wrapBlock(block: MarkdownBlock): ElementContent = ElementContent.Block(block)

private fun wrapInline(inline: MarkdownInline): ElementContent = ElementContent.Inline(inline)

/** Returns the attribute's value, or null when it is missing or empty. */
private fun readAttribute(element: OpenElement, name: String): String? = element.attributes[name]?.takeIf { it.isNotEmpty() }

/**
 * Checks whether [character] is white space as JavaScript's `String.prototype.trim` removes it:
 * the Unicode space separators, the line terminators and the byte order mark.
 */
internal fun isJavaScriptWhitespace(character: Char): Boolean =
    when (character) {
        '\t', '\n', '\u000B', '\u000C', '\r', ' ', '\u00A0', '\u1680', '\u2028', '\u2029', '\u202F', '\u205F', '\u3000', '\uFEFF' -> true
        else -> character in '\u2000'..'\u200A'
    }

/** Returns [text] without the white space at its ends, as JavaScript's `String.prototype.trim` does. */
internal fun trimJavaScriptWhitespace(text: String): String = text.trim(::isJavaScriptWhitespace)

/**
 * Returns the whole number above zero that an attribute holds, up to five digits, or null for a
 * missing attribute or any other value. Used for an image's `width` and `height` and a cell's
 * `colspan`.
 */
private fun parsePositiveInteger(value: String?): Int? {
    if (value == null) return null
    val digits = trimJavaScriptWhitespace(value)
    if (digits.isEmpty() || digits.length > 5 || !digits.all { it in '0'..'9' }) return null
    return digits.toInt().takeIf { it > 0 }
}

/**
 * Returns the number of columns a cell's `colspan` attribute names: a whole number above zero, or
 * 1 for a missing or any other value. A value over [MAX_TABLE_COLUMNS] is kept as written;
 * [limitCellSpans] cuts it down.
 */
private fun parseColumnSpan(value: String?): Int = parsePositiveInteger(value) ?: 1

/**
 * Returns the column alignment that a cell's `align` attribute names: `left`, `center` or `right`
 * in any case, or null for a missing attribute or any other value.
 */
private fun parseAlignment(value: String?): ColumnAlignment? =
    when (value?.let(::trimJavaScriptWhitespace)?.lowercase()) {
        "left" -> ColumnAlignment.Left
        "center" -> ColumnAlignment.Center
        "right" -> ColumnAlignment.Right
        else -> null
    }

/** Returns the index of the first character of [text] that is not white space, or its length. */
private fun findTextStart(text: String): Int {
    var start = 0
    while (start < text.length && isHtmlSpace(text[start])) start++
    return start
}

/** Returns the index after the last character of [text] that is not white space, or 0. */
private fun findTextEnd(text: String): Int {
    var end = text.length
    while (end > 0 && isHtmlSpace(text[end - 1])) end--
    return end
}

/** Checks whether a run of inlines shows nothing: only spaces and line breaks. */
private fun isBlankRun(inlines: List<MarkdownInline>): Boolean = inlines.all(::isBlankInline)

private fun isBlankInline(inline: MarkdownInline): Boolean =
    inline == MarkdownInline.Break || (inline is MarkdownInline.Text && findTextStart(inline.text) == inline.text.length)

/**
 * Returns [inlines] without the spaces and line breaks at both ends, which an HTML element does
 * not show. With [preserveSpace], as inside `pre`, returns them as they are.
 */
private fun trimInlines(inlines: List<MarkdownInline>, preserveSpace: Boolean): List<MarkdownInline> {
    if (preserveSpace) return inlines
    var start = 0
    var end = inlines.size
    while (start < end && isBlankInline(inlines[start])) start++
    while (end > start && isBlankInline(inlines[end - 1])) end--
    val trimmed = ArrayList(inlines.subList(start, end))
    val first = trimmed.firstOrNull()
    if (first is MarkdownInline.Text) trimmed[0] = MarkdownInline.Text(first.text.substring(findTextStart(first.text)))
    val last = trimmed.lastOrNull()
    if (last is MarkdownInline.Text) trimmed[trimmed.size - 1] = MarkdownInline.Text(last.text.substring(0, findTextEnd(last.text)))
    return trimmed
}

/** A run of inlines, or a block: what an element's content is split into. */
private sealed interface Segment {
    class Inlines(val inlines: List<MarkdownInline>) : Segment

    class Block(val block: MarkdownBlock) : Segment
}

/**
 * Splits an element's content into runs of inlines and blocks, in order. Text that sits next to
 * other text is joined into one text. Unless [preserveSpace] is set, as inside `pre`, a space at
 * the start of the second text is dropped when the first ends in one. A run may show nothing, and
 * it is kept: the callers decide.
 *
 * A part outside its parent is plain content here. A list item gives its blocks. A summary, a cell
 * and a row give their inlines, with a space between them and the text before and after, so that
 * `x<td>c</td>y` reads "x c y".
 */
private fun splitIntoSegments(content: List<ElementContent>, preserveSpace: Boolean = false): List<Segment> {
    val segments = ArrayList<Segment>()
    var run = ArrayList<MarkdownInline>()
    // The text just added, not yet in `run`. It is joined once, when the text ends.
    val textPieces = StringBuilder()
    var hasText = false
    var textEndsInSpace = false
    // Whether the inlines just added end a part, and so need a space before whatever comes next.
    var spaceBeforeNext = false
    fun endText() {
        if (hasText) run.add(MarkdownInline.Text(textPieces.toString()))
        textPieces.setLength(0)
        hasText = false
        textEndsInSpace = false
    }
    fun endRun() {
        endText()
        if (run.isNotEmpty()) segments.add(Segment.Inlines(run))
        run = ArrayList()
        spaceBeforeNext = false
    }
    fun appendInline(inline: MarkdownInline) {
        if (spaceBeforeNext) {
            spaceBeforeNext = false
            if (inline != MarkdownInline.Break) appendInline(MarkdownInline.Text(" "))
        }
        if (inline is MarkdownInline.Text) {
            val text = if (preserveSpace || !textEndsInSpace) inline.text else inline.text.substring(findTextStart(inline.text))
            if (text.isEmpty()) return
            textPieces.append(text)
            hasText = true
            textEndsInSpace = isHtmlSpace(text[text.length - 1])
        } else {
            endText()
            run.add(inline)
        }
    }
    fun appendPartInlines(inlines: List<MarkdownInline>) {
        if (inlines.isEmpty()) return
        if (hasText || (run.isNotEmpty() && run.last() != MarkdownInline.Break)) appendInline(MarkdownInline.Text(" "))
        for (inline in inlines) appendInline(inline)
        spaceBeforeNext = true
    }
    for (part in content) {
        when (part) {
            is ElementContent.Inline -> appendInline(part.inline)
            is ElementContent.Block -> {
                endRun()
                segments.add(Segment.Block(part.block))
            }
            is ElementContent.ListItem ->
                for (block in part.blocks) {
                    endRun()
                    segments.add(Segment.Block(block))
                }
            is ElementContent.Summary -> appendPartInlines(part.inlines)
            is ElementContent.Cell -> appendPartInlines(part.cell.inlines)
            is ElementContent.Row -> for (cell in part.cells) appendPartInlines(cell.inlines)
        }
    }
    endRun()
    return segments
}

/** Returns the groups joined into one run of inlines, a line break between two groups, empty groups left out. */
private fun joinWithBreaks(groups: List<List<MarkdownInline>>): List<MarkdownInline> =
    joinGroups(groups, MarkdownInline.Break)

/** Returns the groups joined into one run of inlines, a space between two groups, empty groups left out. */
private fun joinWithSpaces(groups: List<List<MarkdownInline>>): List<MarkdownInline> =
    joinGroups(groups, MarkdownInline.Text(" "))

private fun joinGroups(groups: List<List<MarkdownInline>>, separator: MarkdownInline): List<MarkdownInline> {
    val joined = ArrayList<MarkdownInline>()
    for (group in groups) {
        if (group.isEmpty()) continue
        if (joined.isNotEmpty()) joined.add(separator)
        joined.addAll(group)
    }
    return joined
}

/** Returns the text of a block as inlines, for a place that holds only inlines, such as a table cell. */
private fun flattenBlock(block: MarkdownBlock): List<MarkdownInline> =
    when (block) {
        is MarkdownBlock.Paragraph -> block.children
        is MarkdownBlock.Heading -> block.children
        is MarkdownBlock.Code -> listOf(MarkdownInline.InlineCode(block.text))
        is MarkdownBlock.List -> joinWithBreaks(block.items.map { item -> joinWithBreaks(item.children.map(::flattenBlock)) })
        is MarkdownBlock.Blockquote -> joinWithBreaks(block.children.map(::flattenBlock))
        is MarkdownBlock.Details -> joinWithBreaks(listOf(block.summary) + block.children.map(::flattenBlock))
        is MarkdownBlock.Table ->
            joinWithBreaks((listOf(block.header) + block.rows).map { row -> joinWithSpaces(row.map { it.children }) })
        MarkdownBlock.Rule -> emptyList()
    }

/**
 * Returns the blocks for an element's content. The inlines between two blocks make a paragraph,
 * unless they show nothing.
 */
private fun convertToBlocks(content: List<ElementContent>, preserveSpace: Boolean = false): List<MarkdownBlock> =
    splitIntoSegments(content, preserveSpace).mapNotNull { segment ->
        when (segment) {
            is Segment.Block -> segment.block
            is Segment.Inlines ->
                if (isBlankRun(segment.inlines)) null
                else MarkdownBlock.Paragraph(trimInlines(segment.inlines, preserveSpace))
        }
    }

/**
 * Returns the inlines for an element's content, for an element that holds only inlines. A block
 * among them becomes inlines with a line break around it. Spaces at the ends stay, so `<b>a </b>b`
 * keeps its space.
 */
private fun convertToInlines(content: List<ElementContent>, preserveSpace: Boolean = false): List<MarkdownInline> {
    val segments = splitIntoSegments(content, preserveSpace)
    if (segments.none { it is Segment.Block }) return segments.flatMap { (it as Segment.Inlines).inlines }
    return joinWithBreaks(
        segments.mapNotNull { segment ->
            when (segment) {
                is Segment.Block -> flattenBlock(segment.block)
                is Segment.Inlines -> segment.inlines.takeUnless(::isBlankRun)
            }
        },
    )
}

/**
 * Returns the function that closes a `strong`, `em` or `del` element. The element leaves nothing
 * when it is empty, and only its white space when it holds nothing else.
 */
private fun closeInlineWrapper(wrap: (List<MarkdownInline>) -> MarkdownInline): (OpenElement) -> List<ElementContent> =
    { element ->
        val children = convertToInlines(element.content, element.preservesSpace)
        if (isBlankRun(children)) children.map(::wrapInline) else listOf(wrapInline(wrap(children)))
    }

/** Returns the function that closes a heading element of the given depth. */
private fun closeHeading(depth: Int): (OpenElement) -> List<ElementContent> = { element ->
    val children = trimInlines(convertToInlines(element.content, element.preservesSpace), element.preservesSpace)
    if (children.isEmpty()) emptyList() else listOf(wrapBlock(MarkdownBlock.Heading(depth, children)))
}

/** Closes a `p` or a `div`: each run of inlines in it is a paragraph, and its blocks stay blocks. */
private fun closeParagraph(element: OpenElement): List<ElementContent> =
    convertToBlocks(element.content, element.preservesSpace).map(::wrapBlock)

/**
 * Closes an `a`. It leaves its children alone when its address is missing or unsafe, or when it
 * holds nothing but white space. A link inside it is flattened to its children.
 */
private fun closeLink(element: OpenElement): List<ElementContent> {
    val children = convertToInlines(element.content, element.preservesSpace)
    val href = normalizeAddress(element.attributes["href"] ?: "")
    if (href.isEmpty() || !isSafeAddress(href) || isBlankRun(children)) return children.map(::wrapInline)
    return listOf(wrapInline(MarkdownInline.Link(href, readAttribute(element, "title"), removeNestedLinks(children))))
}

private fun closeCode(element: OpenElement): List<ElementContent> {
    // A line break in code reads as a space, like the white space of the HTML around it, and as
    // a line break inside `pre`, where line breaks show as written.
    val text =
        extractPlainText(
            convertToInlines(element.content, element.preservesSpace),
            if (element.preservesSpace) "\n" else " ",
        )
    return if (text.isEmpty()) emptyList() else listOf(wrapInline(MarkdownInline.InlineCode(text)))
}

private fun closeBlockquote(element: OpenElement): List<ElementContent> {
    val children = convertToBlocks(element.content, element.preservesSpace)
    return if (children.isEmpty()) emptyList() else listOf(wrapBlock(MarkdownBlock.Blockquote(children)))
}

/**
 * Returns the content of an element that the element itself does not use, in order, for the
 * element to pass on to the one around it. The parts for which [isUsed] returns true are the ones
 * the element uses itself. Text that such a part sat between gets a space between.
 */
private fun collectUnusedContent(content: List<ElementContent>, isUsed: (ElementContent) -> Boolean): List<ElementContent> {
    val unused = ArrayList<ElementContent>()
    var endsWithInline = false
    var usedPartFollows = false
    for (part in content) {
        if (isUsed(part)) {
            usedPartFollows = endsWithInline
            continue
        }
        if (usedPartFollows && part is ElementContent.Inline) unused.add(wrapInline(MarkdownInline.Text(" ")))
        usedPartFollows = false
        unused.add(part)
        endsWithInline = part is ElementContent.Inline
    }
    return unused
}

/**
 * Returns the start that an `ol`'s `start` attribute names: a whole number of up to nine digits,
 * with an optional minus sign, or 1 for any other value.
 */
private fun parseListStart(value: String): Int {
    val digits = value.removePrefix("-")
    val valid = digits.isNotEmpty() && digits.length <= 9 && digits.all { it in '0'..'9' }
    return if (valid) value.toInt() else 1
}

/** Closes a `ul` or an `ol`. Its `li` children are the items. Anything else in it comes out in front of the list. */
private fun closeList(element: OpenElement): List<ElementContent> {
    val unused = collectUnusedContent(element.content) { it is ElementContent.ListItem }
    val items = element.content.mapNotNull { part -> (part as? ElementContent.ListItem)?.let { MarkdownListItem(it.blocks) } }
    if (items.isEmpty()) return unused
    // A numbered list always has a start, as one from markdown does: the apps draw a list without
    // one as bullets. HTML allows a start of zero or below, so a sign is read.
    val start = if (element.tag == "ol") parseListStart(element.attributes["start"] ?: "") else null
    return unused + wrapBlock(MarkdownBlock.List(start, loose = false, items = items))
}

private fun closeListItem(element: OpenElement): List<ElementContent> =
    listOf(ElementContent.ListItem(convertToBlocks(element.content, element.preservesSpace)))

private fun closePreformatted(element: OpenElement): List<ElementContent> {
    // A browser drops the line break right after <pre>.
    val plain = extractPlainText(convertToInlines(element.content, element.preservesSpace), "\n")
    val withoutFirstBreak =
        when {
            plain.startsWith("\r\n") -> plain.substring(2)
            plain.startsWith("\n") -> plain.substring(1)
            else -> plain
        }
    val text = trimTrailingNewlines(withoutFirstBreak)
    return if (text.isEmpty()) emptyList() else listOf(wrapBlock(MarkdownBlock.Code(text)))
}

private fun closeSummary(element: OpenElement): List<ElementContent> =
    listOf(ElementContent.Summary(trimInlines(convertToInlines(element.content, element.preservesSpace), element.preservesSpace)))

/**
 * Closes a `details`. Its first `summary` is the summary line, and the rest of its content, a
 * second `summary` included, is the body.
 */
private fun closeDetails(element: OpenElement): List<ElementContent> {
    val summaryPart = element.content.firstOrNull { it is ElementContent.Summary } as ElementContent.Summary?
    val summary = summaryPart?.inlines ?: emptyList()
    return listOf(
        wrapBlock(
            MarkdownBlock.Details(
                summary = summary.ifEmpty { listOf(MarkdownInline.Text("Details")) },
                children = convertToBlocks(element.content.filter { it !== summaryPart }, element.preservesSpace),
            ),
        ),
    )
}

private fun closeCell(element: OpenElement): List<ElementContent> =
    listOf(
        ElementContent.Cell(
            HtmlTableCell(
                inlines = trimInlines(convertToInlines(element.content, element.preservesSpace), element.preservesSpace),
                columnSpan = parseColumnSpan(element.attributes["colspan"]),
                align = parseAlignment(element.attributes["align"]),
                isHeader = element.tag == "th",
            ),
        ),
    )

/** Closes a `tr`. Its cells are the row. Anything else in it comes out in front of the row. */
private fun closeRow(element: OpenElement): List<ElementContent> =
    collectUnusedContent(element.content) { it is ElementContent.Cell } +
        ElementContent.Row(element.content.mapNotNull { (it as? ElementContent.Cell)?.cell }, isHeader = false)

/**
 * Closes a `thead`, `tbody` or `tfoot`. Its rows go on to the table, marked as header rows for a
 * `thead`. Anything else in it comes out in front of them.
 */
private fun closeRowGroup(element: OpenElement): List<ElementContent> =
    collectUnusedContent(element.content) { it is ElementContent.Row } +
        element.content.mapNotNull { part ->
            (part as? ElementContent.Row)?.let { ElementContent.Row(it.cells, it.isHeader || element.tag == "thead") }
        }

/**
 * The most columns a table has. A short row is padded to the widest one, so a single very wide
 * row above many short ones would need millions of cells. No table that a person reads has more
 * than a few dozen columns, so 64 is room to spare. [limitCellSpans] keeps the text of the cells
 * past the limit.
 */
private const val MAX_TABLE_COLUMNS = 64

/**
 * Returns [cells] with the columns they cover limited to [MAX_TABLE_COLUMNS]. A span that reaches
 * past the limit is cut to end at it. Every cell that starts at or past the limit goes into the
 * last cell, its content after the last cell's with a space between them.
 */
private fun limitCellSpans(cells: List<HtmlTableCell>): List<HtmlTableCell> {
    val kept = ArrayList<HtmlTableCell>()
    val overflow = ArrayList<List<MarkdownInline>>()
    var column = 0
    for (cell in cells) {
        if (column >= MAX_TABLE_COLUMNS) {
            overflow.add(cell.inlines)
            continue
        }
        val columnSpan = minOf(cell.columnSpan, MAX_TABLE_COLUMNS - column)
        kept.add(cell.copy(columnSpan = columnSpan))
        column += columnSpan
    }
    if (kept.isEmpty()) return kept
    val last = kept.removeAt(kept.size - 1)
    kept.add(if (overflow.isEmpty()) last else last.copy(inlines = joinWithSpaces(listOf(last.inlines) + overflow)))
    return kept
}

/**
 * Closes a `table`. Content that is not a row comes out in front of the table. The header is the
 * row in a `thead`, or else the first row when all its cells are `th`, or else empty. The table
 * is as wide as its widest row, counting the columns each cell covers. A shorter row ends in one
 * empty cell that covers the rest. A column's alignment comes from the header's cell that starts
 * there, or else the first row's, and each cell takes the alignment of the column it starts in.
 */
private fun closeTable(element: OpenElement): List<ElementContent> {
    val unused = collectUnusedContent(element.content) { it is ElementContent.Row }
    val rows =
        element.content.mapNotNull { part ->
            (part as? ElementContent.Row)?.takeIf { it.cells.isNotEmpty() }?.let { ElementContent.Row(limitCellSpans(it.cells), it.isHeader) }
        }
    val first = rows.firstOrNull()
    val headerRow = rows.firstOrNull { it.isHeader } ?: first?.takeIf { row -> row.cells.all { it.isHeader } }
    val bodyRows = rows.filter { it !== headerRow }
    val columnCount = rows.maxOfOrNull { countColumns(it.cells) } ?: 0
    if (columnCount == 0) return unused
    val alignmentRow = headerRow ?: bodyRows.firstOrNull()
    val columnAlign = buildColumnAlignment(alignmentRow?.cells ?: emptyList(), columnCount)
    fun buildRow(row: ElementContent.Row): List<MarkdownTableCell> {
        var column = 0
        val cells = ArrayList<MarkdownTableCell>(row.cells.size + 1)
        for (cell in row.cells) {
            cells.add(MarkdownTableCell(cell.inlines, cell.columnSpan, columnAlign.getOrNull(column)))
            column += cell.columnSpan
        }
        if (column < columnCount) cells.add(MarkdownTableCell(emptyList(), columnCount - column, columnAlign.getOrNull(column)))
        return cells
    }
    return unused +
        wrapBlock(MarkdownBlock.Table(header = headerRow?.let(::buildRow) ?: emptyList(), rows = bodyRows.map(::buildRow)))
}

/** Returns the number of columns a row's cells cover together. */
private fun countColumns(cells: List<HtmlTableCell>): Int = cells.sumOf { it.columnSpan }

/** Returns the alignment of each of [columnCount] columns: the one a cell sets, for each column it covers. */
private fun buildColumnAlignment(cells: List<HtmlTableCell>, columnCount: Int): List<ColumnAlignment?> {
    val alignment = arrayOfNulls<ColumnAlignment>(columnCount)
    var column = 0
    for (cell in cells) {
        for (covered in column until minOf(column + cell.columnSpan, columnCount)) alignment[covered] = cell.align
        column += cell.columnSpan
    }
    return alignment.asList()
}

/**
 * The elements that become nodes, by tag, each with the function that turns a closed element into
 * the content it leaves behind. A tag that is not here is dropped and its content stays.
 */
private val ELEMENTS: Map<String, (OpenElement) -> List<ElementContent>> =
    hashMapOf(
        "strong" to closeInlineWrapper(MarkdownInline::Strong),
        "b" to closeInlineWrapper(MarkdownInline::Strong),
        "em" to closeInlineWrapper(MarkdownInline::Emphasis),
        "i" to closeInlineWrapper(MarkdownInline::Emphasis),
        "del" to closeInlineWrapper(MarkdownInline::Strikethrough),
        "s" to closeInlineWrapper(MarkdownInline::Strikethrough),
        "strike" to closeInlineWrapper(MarkdownInline::Strikethrough),
        "code" to ::closeCode,
        "a" to ::closeLink,
        "p" to ::closeParagraph,
        "div" to ::closeParagraph,
        "h1" to closeHeading(1),
        "h2" to closeHeading(2),
        "h3" to closeHeading(3),
        "h4" to closeHeading(4),
        "h5" to closeHeading(5),
        "h6" to closeHeading(6),
        "blockquote" to ::closeBlockquote,
        "ul" to ::closeList,
        "ol" to ::closeList,
        "li" to ::closeListItem,
        "pre" to ::closePreformatted,
        "details" to ::closeDetails,
        "summary" to ::closeSummary,
        "table" to ::closeTable,
        "thead" to ::closeRowGroup,
        "tbody" to ::closeRowGroup,
        "tfoot" to ::closeRowGroup,
        "tr" to ::closeRow,
        "th" to ::closeCell,
        "td" to ::closeCell,
        // Their content is dropped.
        "script" to { _ -> emptyList() },
        "style" to { _ -> emptyList() },
    )

/** Returns the image for an `img`. An image with a missing or unsafe `src` leaves its alt text, as a markdown image does. */
private fun closeImage(element: OpenElement): List<ElementContent> {
    val src = normalizeAddress(element.attributes["src"] ?: "")
    val alt = element.attributes["alt"] ?: ""
    if (src.isEmpty() || !isSafeAddress(src)) return if (alt.isEmpty()) emptyList() else listOf(wrapInline(MarkdownInline.Text(alt)))
    return listOf(
        wrapInline(
            MarkdownInline.Image(
                src = src,
                alt = alt,
                title = readAttribute(element, "title"),
                width = parsePositiveInteger(element.attributes["width"]),
                height = parsePositiveInteger(element.attributes["height"]),
            ),
        ),
    )
}

/** The elements that have no closing tag, each with the function that makes the content it leaves. */
private val VOID_ELEMENTS: Map<String, (OpenElement) -> List<ElementContent>> =
    hashMapOf(
        "br" to { _ -> listOf(wrapInline(MarkdownInline.Break)) },
        "hr" to { _ -> listOf(wrapBlock(MarkdownBlock.Rule)) },
        "img" to ::closeImage,
    )

/** The tags of the elements an open tag closes when they were left open, and the tags that stop the search. */
private class ImpliedClose(val closes: Set<String>, val stopsAt: Set<String>)

/**
 * The open tags that close an element that was left open. `<li>one<li>two` is two items, and a
 * `<tr>` ends the row before it.
 */
private val IMPLIED_CLOSES: Map<String, ImpliedClose> =
    run {
        val cell = ImpliedClose(setOf("td", "th"), setOf("tr", "table"))
        val rowGroup = ImpliedClose(setOf("thead", "tbody", "tfoot"), setOf("table"))
        hashMapOf(
            "li" to ImpliedClose(setOf("li"), setOf("ul", "ol")),
            "td" to cell,
            "th" to cell,
            "tr" to ImpliedClose(setOf("tr"), setOf("table", "thead", "tbody", "tfoot")),
            "thead" to rowGroup,
            "tbody" to rowGroup,
            "tfoot" to rowGroup,
        )
    }

/**
 * Returns the index in [open] of the element that an open tag [tag] closes without a close tag, or
 * -1 when it closes none. The search goes from the innermost element outwards and stops at the
 * first element the tag closes or may not look past.
 */
private fun findImpliedlyClosedElement(open: List<OpenElement>, tag: String): Int {
    val rule = IMPLIED_CLOSES[tag] ?: return -1
    for (index in open.indices.reversed()) {
        val openTag = open[index].tag
        if (openTag in rule.closes) return index
        if (openTag in rule.stopsAt) return -1
    }
    return -1
}

/**
 * How many elements may be open at once in one level of markdown nodes. A tag that would open one
 * more is dropped and its content kept. The count starts again inside a quote or a list item, as
 * each of those is a level of its own, so this bounds the nesting of HTML only.
 */
private const val MAX_OPEN_ELEMENTS = 50

/**
 * Walks the pieces in order and returns the content of their level. Each piece of nodes joins the
 * element open at that point. The tags of an HTML piece open and close elements:
 *
 * - A close tag closes the nearest open element with its name, and every element opened inside
 *   that one. A close tag with no open element is ignored.
 * - An open tag closes the element it implies, see [IMPLIED_CLOSES]. No other tag closes an
 *   element by itself.
 * - `script` and `style` are dropped with their content when their close tag is in the same
 *   piece. If it is not, the tag is dropped and the content stays, since a lone `<script>` is
 *   prose.
 * - Whatever is open at the end of the pieces closes there, so a message cut short still parses.
 *
 * Text from HTML has its runs of spaces and line breaks collapsed to one space, except inside `pre`.
 */
private fun <Node> nestPieces(pieces: List<HtmlPiece<Node>>, wrapNode: (Node) -> ElementContent): List<ElementContent> {
    val root = OpenElement(tag = "", attributes = emptyMap(), preservesSpace = false, insideCode = false)
    val open = ArrayList<OpenElement>()
    fun findInnermostElement() = open.lastOrNull() ?: root
    fun appendContent(content: List<ElementContent>) {
        findInnermostElement().content.addAll(content)
    }
    fun closeInnermostElement() {
        val element = open.removeLastOrNull() ?: return
        appendContent(ELEMENTS[element.tag]?.invoke(element) ?: emptyList())
    }
    fun closeElementsDownTo(index: Int) {
        while (open.size > index) closeInnermostElement()
    }
    fun appendText(text: String) {
        val shown = if (findInnermostElement().preservesSpace) text else collapseHtmlSpace(text)
        if (shown.isNotEmpty()) appendContent(listOf(wrapInline(MarkdownInline.Text(shown))))
    }
    fun openElement(element: OpenElement, selfClosing: Boolean) {
        val closeVoidElement = VOID_ELEMENTS[element.tag]
        if (closeVoidElement != null) {
            appendContent(closeVoidElement(element))
            return
        }
        if (element.tag !in ELEMENTS || open.size >= MAX_OPEN_ELEMENTS) return
        val impliedlyClosed = findImpliedlyClosedElement(open, element.tag)
        if (impliedlyClosed != -1) closeElementsDownTo(impliedlyClosed)
        open.add(element)
        if (selfClosing) closeInnermostElement()
    }

    for (piece in pieces) {
        when (piece) {
            is HtmlPiece.Nodes -> appendContent(piece.createNodes(findInnermostElement().insideCode).map(wrapNode))
            is HtmlPiece.Html -> {
                for (token in scanHtmlTags(piece.html)) {
                    when (token) {
                        is HtmlToken.Text -> appendText(token.text)
                        is HtmlToken.OpenTag -> {
                            val parent = findInnermostElement()
                            openElement(
                                OpenElement(
                                    tag = token.name,
                                    attributes = token.attributes,
                                    preservesSpace = token.name == "pre" || parent.preservesSpace,
                                    insideCode = token.name == "code" || token.name == "pre" || parent.insideCode,
                                ),
                                token.selfClosing,
                            )
                        }
                        is HtmlToken.CloseTag -> {
                            val index = open.indexOfLast { it.tag == token.name }
                            if (index != -1) closeElementsDownTo(index)
                        }
                    }
                }
                // A script or style whose close tag is not in this piece is not a script:
                // `<script> tags are bad` is prose. Its content stays.
                val unclosedScript = open.indexOfFirst { it.tag == "script" || it.tag == "style" }
                if (unclosedScript != -1) {
                    closeElementsDownTo(unclosedScript + 1)
                    open.removeLastOrNull()?.let { script -> appendContent(script.content) }
                }
            }
        }
    }
    closeElementsDownTo(0)
    return root.content
}

/** Returns [text] with each run of HTML white space replaced by one space. */
private fun collapseHtmlSpace(text: String): String {
    val out = StringBuilder(text.length)
    var inSpace = false
    for (character in text) {
        if (isHtmlSpace(character)) {
            if (!inSpace) out.append(' ')
            inSpace = true
        } else {
            out.append(character)
            inSpace = false
        }
    }
    return out.toString()
}
