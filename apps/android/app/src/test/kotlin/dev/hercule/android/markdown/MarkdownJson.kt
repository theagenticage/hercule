package dev.hercule.android.markdown

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/*
 * Writes a markdown tree as the JSON that `JSON.stringify` makes of client-core's tree, so that a
 * tree from the port compares with one from client-core's fixture. A field client-core leaves
 * undefined is left out, as `JSON.stringify` leaves it out.
 */

/** Returns [document] as client-core's JSON. */
fun encodeDocument(document: MarkdownDocument): JsonElement =
    JsonObject(
        mapOf(
            "blocks" to JsonArray(document.blocks.map(::encodeBlock)),
            "footnotes" to
                JsonArray(
                    document.footnotes.map { footnote ->
                        JsonObject(mapOf("number" to JsonPrimitive(footnote.number), "children" to JsonArray(footnote.children.map(::encodeBlock))))
                    },
                ),
        ),
    )

private fun node(type: String, vararg fields: Pair<String, JsonElement?>): JsonObject =
    JsonObject(buildMap {
        put("type", JsonPrimitive(type))
        for ((key, value) in fields) if (value != null) put(key, value)
    })

private fun encodeInlines(inlines: List<MarkdownInline>): JsonArray = JsonArray(inlines.map(::encodeInline))

private fun encodeAlignment(align: ColumnAlignment?): JsonElement? = align?.let { JsonPrimitive(it.name.lowercase()) }

private fun encodeCell(cell: MarkdownTableCell): JsonObject =
    JsonObject(buildMap {
        put("children", encodeInlines(cell.children))
        put("columnSpan", JsonPrimitive(cell.columnSpan))
        encodeAlignment(cell.align)?.let { put("align", it) }
    })

private fun encodeBlock(block: MarkdownBlock): JsonObject =
    when (block) {
        is MarkdownBlock.Paragraph -> node("paragraph", "children" to encodeInlines(block.children))
        is MarkdownBlock.Heading -> node("heading", "depth" to JsonPrimitive(block.depth), "children" to encodeInlines(block.children))
        is MarkdownBlock.List ->
            node(
                "list",
                "start" to block.start?.let(::JsonPrimitive),
                "loose" to JsonPrimitive(block.loose),
                "items" to JsonArray(block.items.map { JsonObject(mapOf("children" to JsonArray(it.children.map(::encodeBlock)))) }),
            )
        is MarkdownBlock.Blockquote -> node("blockquote", "children" to JsonArray(block.children.map(::encodeBlock)))
        is MarkdownBlock.Code -> node("code", "text" to JsonPrimitive(block.text), "language" to block.language?.let(::JsonPrimitive))
        is MarkdownBlock.Table ->
            node(
                "table",
                "header" to JsonArray(block.header.map(::encodeCell)),
                "rows" to JsonArray(block.rows.map { row -> JsonArray(row.map(::encodeCell)) }),
            )
        MarkdownBlock.Rule -> node("rule")
        is MarkdownBlock.Details ->
            node("details", "summary" to encodeInlines(block.summary), "children" to JsonArray(block.children.map(::encodeBlock)))
    }

private fun encodeInline(inline: MarkdownInline): JsonObject =
    when (inline) {
        is MarkdownInline.Text -> node("text", "text" to JsonPrimitive(inline.text))
        is MarkdownInline.Strong -> node("strong", "children" to encodeInlines(inline.children))
        is MarkdownInline.Emphasis -> node("emphasis", "children" to encodeInlines(inline.children))
        is MarkdownInline.Strikethrough -> node("strikethrough", "children" to encodeInlines(inline.children))
        is MarkdownInline.InlineCode -> node("inlineCode", "text" to JsonPrimitive(inline.text))
        MarkdownInline.Break -> node("break")
        is MarkdownInline.Link ->
            node("link", "href" to JsonPrimitive(inline.href), "title" to inline.title?.let(::JsonPrimitive), "children" to encodeInlines(inline.children))
        is MarkdownInline.Image ->
            node(
                "image",
                "src" to JsonPrimitive(inline.src),
                "alt" to JsonPrimitive(inline.alt),
                "title" to inline.title?.let(::JsonPrimitive),
                "width" to inline.width?.let(::JsonPrimitive),
                "height" to inline.height?.let(::JsonPrimitive),
            )
        is MarkdownInline.Checkbox -> node("checkbox", "checked" to JsonPrimitive(inline.checked))
        is MarkdownInline.FootnoteReference ->
            node("footnoteReference", "number" to JsonPrimitive(inline.number), "isFirstReference" to JsonPrimitive(inline.isFirstReference))
        is MarkdownInline.FootnoteBackReference -> node("footnoteBackReference", "number" to JsonPrimitive(inline.number))
    }
