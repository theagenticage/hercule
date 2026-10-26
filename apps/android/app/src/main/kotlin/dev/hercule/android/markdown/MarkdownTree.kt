package dev.hercule.android.markdown

import androidx.compose.runtime.Immutable

/*
 * The tree that parseMarkdown produces: plain data that the app draws in its own look. A port of
 * packages/client-core/src/markdown-tree.ts, field by field. See Markdown.kt for what goes into it
 * and what stays out.
 *
 * Every type is marked Immutable, so Compose compares a tree rebuilt by the next streamed token
 * with the one before by its value, and skips a block that is equal. The lists inside are built
 * once by the parser and never changed after.
 */

/** The alignment a table's delimiter row sets for a column. A column with none is null. */
enum class ColumnAlignment { Left, Center, Right }

/**
 * A block of a message: a paragraph, a heading, a list, a quote, a code block, a table, a rule,
 * or a collapsible `details` block from embedded HTML.
 */
@Immutable
sealed interface MarkdownBlock {
    @Immutable
    data class Paragraph(val children: kotlin.collections.List<MarkdownInline>) : MarkdownBlock

    /** A heading of [depth] 1 to 6. */
    @Immutable
    data class Heading(val depth: Int, val children: kotlin.collections.List<MarkdownInline>) :
        MarkdownBlock

    /**
     * A bulleted or numbered list.
     *
     * - [start] is the first item's number in a numbered list, or null in a bulleted list. It is
     *   1 for a list that gives no number, and can be zero or below for a list written in HTML.
     * - [loose] tells whether blank lines separate the items. In a tight list, an item's
     *   paragraphs are drawn as bare text, with no paragraph spacing.
     */
    @Immutable
    data class List(
        val start: Int?,
        val loose: Boolean,
        val items: kotlin.collections.List<MarkdownListItem>,
    ) : MarkdownBlock

    @Immutable
    data class Blockquote(val children: kotlin.collections.List<MarkdownBlock>) : MarkdownBlock

    /**
     * A fenced or indented code block. Its text is exactly as written, with no trailing newline.
     * [language] is the first word of a fenced block's info string, with backslash escapes
     * removed and character references decoded: `ts` for both "```ts" and "```ts title="a.ts"".
     * It is null when the block names no language: an indented block, a bare fence, an info
     * string of only white space, or an HTML `<pre>`.
     */
    @Immutable
    data class Code(val text: String, val language: String? = null) : MarkdownBlock

    /**
     * A table. [header] holds the header row's cells, and [rows] the body rows' cells. The header
     * is empty for a table written in HTML without a header row. Every row covers the same
     * number of columns: the column spans of its cells add up to the table's width, and a short
     * row ends in one empty cell that covers the rest.
     */
    @Immutable
    data class Table(
        val header: kotlin.collections.List<MarkdownTableCell>,
        val rows: kotlin.collections.List<kotlin.collections.List<MarkdownTableCell>>,
    ) : MarkdownBlock

    @Immutable
    data object Rule : MarkdownBlock

    /**
     * A block that collapses to its one-line [summary] and opens to show its [children], from a
     * `<details>` element. A `<details>` without a `<summary>` gets the summary text "Details",
     * as a browser draws it.
     */
    @Immutable
    data class Details(
        val summary: kotlin.collections.List<MarkdownInline>,
        val children: kotlin.collections.List<MarkdownBlock>,
    ) : MarkdownBlock
}

/**
 * One cell of a table: a run of inlines, in one or more columns, with the alignment of its first
 * column.
 *
 * - [columnSpan] is how many columns the cell covers: 1, unless an HTML cell has a `colspan`.
 * - [align] is the alignment of the cell's first column, from a markdown table's delimiter row or
 *   an HTML header row's cells, or null for none.
 */
@Immutable
data class MarkdownTableCell(
    val children: List<MarkdownInline>,
    val columnSpan: Int,
    val align: ColumnAlignment?,
)

/** An item of a list. A task item's box is a [MarkdownInline.Checkbox] at the start of the item's first paragraph. */
@Immutable
data class MarkdownListItem(val children: List<MarkdownBlock>)

/** An inline element: text, its markup, a link, an image or a footnote's mark. */
@Immutable
sealed interface MarkdownInline {
    @Immutable
    data class Text(val text: String) : MarkdownInline

    @Immutable
    data class Strong(val children: List<MarkdownInline>) : MarkdownInline

    @Immutable
    data class Emphasis(val children: List<MarkdownInline>) : MarkdownInline

    @Immutable
    data class Strikethrough(val children: List<MarkdownInline>) : MarkdownInline

    @Immutable
    data class InlineCode(val text: String) : MarkdownInline

    @Immutable
    data object Break : MarkdownInline

    /**
     * A link whose address passed the safety check: relative, or a safe scheme. The [href] is
     * percent-encoded, and [title] is the tooltip it was written with.
     */
    @Immutable
    data class Link(val href: String, val title: String?, val children: List<MarkdownInline>) :
        MarkdownInline

    /**
     * An image whose address passed the same check as a link's, encoded the same way. [width] and
     * [height] are in pixels. They are set only for an HTML `<img>` that gives a whole number,
     * and are null for any other value.
     */
    @Immutable
    data class Image(
        val src: String,
        val alt: String,
        val title: String?,
        val width: Int? = null,
        val height: Int? = null,
    ) : MarkdownInline

    /** A task item's box, ticked or not. It is drawn read-only. */
    @Immutable
    data class Checkbox(val checked: Boolean) : MarkdownInline

    /**
     * A reference to the footnote with the same [number]. The footnote's back reference returns
     * to its first reference, the one with [isFirstReference].
     */
    @Immutable
    data class FootnoteReference(val number: Int, val isFirstReference: Boolean) : MarkdownInline

    /** The link at the end of a footnote back to the footnote's first reference. */
    @Immutable
    data class FootnoteBackReference(val number: Int) : MarkdownInline
}

/**
 * A footnote, numbered by the order in which the message first shows a reference to it. Its last
 * paragraph ends with a [MarkdownInline.FootnoteBackReference].
 */
@Immutable
data class MarkdownFootnote(val number: Int, val children: List<MarkdownBlock>)

/**
 * A parsed message: its [blocks], then the [footnotes] it references, in number order. The
 * footnotes are empty when the message references no footnote. A footnote no reference names is
 * left out.
 */
@Immutable
data class MarkdownDocument(val blocks: List<MarkdownBlock>, val footnotes: List<MarkdownFootnote>)
