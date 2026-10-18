package dev.hercule.android.markdown

/*
 * Short builders for the trees the markdown tests expect, after the helpers of client-core's
 * markdown.test.ts and markdown-html.test.ts.
 */

fun text(value: String): MarkdownInline = MarkdownInline.Text(value)

fun strong(vararg children: MarkdownInline): MarkdownInline = MarkdownInline.Strong(children.toList())

fun emphasis(vararg children: MarkdownInline): MarkdownInline = MarkdownInline.Emphasis(children.toList())

fun strikethrough(vararg children: MarkdownInline): MarkdownInline = MarkdownInline.Strikethrough(children.toList())

fun inlineCode(value: String): MarkdownInline = MarkdownInline.InlineCode(value)

fun link(href: String, title: String?, vararg children: MarkdownInline): MarkdownInline = MarkdownInline.Link(href, title, children.toList())

/** A reference to the footnote with this number. */
fun reference(number: Int, isFirstReference: Boolean = true): MarkdownInline = MarkdownInline.FootnoteReference(number, isFirstReference)

/** The back reference that ends the footnote with this number. */
fun backReference(number: Int): MarkdownInline = MarkdownInline.FootnoteBackReference(number)

fun paragraph(vararg children: MarkdownInline): MarkdownBlock = MarkdownBlock.Paragraph(children.toList())

fun heading(depth: Int, vararg children: MarkdownInline): MarkdownBlock = MarkdownBlock.Heading(depth, children.toList())

fun list(start: Int?, loose: Boolean, vararg items: MarkdownListItem): MarkdownBlock = MarkdownBlock.List(start, loose, items.toList())

fun item(vararg children: MarkdownBlock): MarkdownListItem = MarkdownListItem(children.toList())

fun blockquote(vararg children: MarkdownBlock): MarkdownBlock = MarkdownBlock.Blockquote(children.toList())

fun code(value: String): MarkdownBlock = MarkdownBlock.Code(value)

fun table(header: List<MarkdownTableCell>, rows: List<List<MarkdownTableCell>>): MarkdownBlock = MarkdownBlock.Table(header, rows)

fun cell(children: List<MarkdownInline>, columnSpan: Int, align: ColumnAlignment?): MarkdownTableCell = MarkdownTableCell(children, columnSpan, align)

fun details(summary: List<MarkdownInline>, vararg children: MarkdownBlock): MarkdownBlock = MarkdownBlock.Details(summary, children.toList())

fun footnote(number: Int, vararg children: MarkdownBlock): MarkdownFootnote = MarkdownFootnote(number, children.toList())

/** The tree of a document with these blocks and no footnotes. */
fun document(vararg blocks: MarkdownBlock): MarkdownDocument = MarkdownDocument(blocks.toList(), emptyList())

/** The tree that shows [text] as written, as client-core's callers show a message that it fails to parse. */
fun showAsWritten(text: String): MarkdownDocument = document(paragraph(text(text)))
