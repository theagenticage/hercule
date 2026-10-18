package dev.hercule.android.markdown

import java.io.File
import kotlin.test.assertEquals
import kotlin.test.fail
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Test

/**
 * Checks that [parseMarkdown] builds the same tree as client-core's `parseMarkdown` for every
 * input of the parity fixture, in each of the three ways the apps parse a message. The fixture,
 * `markdown/parity.json`, is generated from client-core by `pnpm gen:markdown-parity`
 * (scripts/gen-markdown-parity-fixtures.ts) and must never be edited by hand.
 *
 * A case where client-core refuses the text as too deep holds `"fallback"`: the port must then
 * show the raw text, as client-core's callers do.
 *
 * The cases of [KNOWN_DIFFERENCES] differ, each for the reason it gives; none is accepted until
 * Rogier approves it. Each must still differ, so that a fix shows here and its entry goes. Every
 * case that differs is listed, with its input and both trees, in
 * `build/markdown-parity-report.txt`.
 */
class MarkdownParityTest {
    private val modes = mapOf("agent" to Pair(false, true), "user" to Pair(true, false), "otherAgent" to Pair(true, true))

    /** A case of the fixture where the port differs from client-core: its [id], its [input], and why. */
    private class KnownDifference(val id: String, val input: String, val reason: String)

    @Test
    fun `builds the same tree as client-core for every case of the fixture`() {
        val fixture = Json.parseToJsonElement(javaClass.getResource("/markdown/parity.json")!!.readText()).jsonArray
        val known = KNOWN_DIFFERENCES.associateBy { it.id }
        val failures = StringBuilder()
        val knownReport = StringBuilder()
        val stillDiffering = HashSet<String>()
        var failed = 0
        var compared = 0
        for (case in fixture) {
            val fields = case.jsonObject
            val id = fields.getValue("id").jsonPrimitive.content
            val input = fields.getValue("input").jsonPrimitive.content
            known[id]?.let { assertEquals(it.input, input, "The input of the known difference $id") }
            for ((mode, options) in modes) {
                val (breaks, embeddedHtml) = options
                val expectedField = fields.getValue(mode)
                val expected: JsonElement =
                    if (expectedField is JsonPrimitive && expectedField.content == "fallback") encodeDocument(showAsWritten(input)) else expectedField
                val actual = encodeDocument(parseMarkdown(input, breaks = breaks, embeddedHtml = embeddedHtml))
                compared++
                if (actual == expected) continue
                val entry = "### $id [$mode] ${JsonPrimitive(input)}\n  client-core: $expected\n  port:        $actual\n\n"
                if (id in known) {
                    stillDiffering.add(id)
                    knownReport.append(entry)
                } else {
                    failed++
                    failures.append(entry)
                }
            }
        }
        val fixed = known.keys - stillDiffering
        File("build/markdown-parity-report.txt").writeText(
            "$failed of $compared differ, besides the known differences\n\n$failures\nKnown differences:\n\n$knownReport",
        )
        if (failed > 0) fail("$failed of $compared parses differ from client-core; see build/markdown-parity-report.txt\n\n${failures.take(6000)}")
        if (fixed.isNotEmpty()) fail("These known differences no longer differ; take them out of KNOWN_DIFFERENCES: $fixed")
    }

    private companion object {
        private const val QUOTE_LAZY_LINES =
            "marked reads the lines that continue a quote's paragraph lazily on their own, as blocks: a line that is a lone HTML " +
                "tag is an HTML block there, and a backslash before it ends the paragraph. commonmark-java continues the " +
                "paragraph with them. Closing it means reading those lines again as blocks: re-lexing."

        private const val LIST_LAZY_LINES =
            "marked reads a list item's lines one at a time, as blocks: a lazy line that is a lone HTML tag is an HTML block, " +
                "and a lazy `=` makes the line before an underlined heading. commonmark-java continues the paragraph. " +
                "Closing it means reading the item's lines again as blocks: re-lexing."

        private const val CLOSING_PRE_TAG =
            "marked's pattern for an HTML block that ends at a blank line leaves out `pre`, `script`, `style` and `textarea`, " +
                "so a line that starts with `</pre>` is a paragraph with a tag in it to marked, and an HTML block to " +
                "commonmark-java. Closing it means reading the block's lines again as a paragraph: re-lexing."

        private const val EMPHASIS =
            "marked pairs `*` and `_` by its own rules, which differ from CommonMark's delimiter algorithm in commonmark-java: " +
                "it judges a `*` after `_` by the character before the underscores, and nests and closes runs of " +
                "different lengths otherwise. Closing it means porting marked's emphasis rules: re-lexing."

        private const val QUOTE_AFTER_BLANK =
            "marked's quote takes the lines after a quote line that holds anything after its `>` and one space, a tab or " +
                "spaces too, and reads them as the quote's own: a paragraph, code, a definition, a nested quote's line. " +
                "commonmark-java reads such a line as blank and ends the quote. The port moves a plain paragraph into the " +
                "quote; closing the other shapes means reading the lines again as blocks of the quote: re-lexing."

        private const val TAB_AFTER_QUOTE_MARKER =
            "marked takes away a whole tab after a quote's `>`, where commonmark-java counts it as spaces up to the next tab " +
                "stop, so the line's indentation differs, and with it what the line is: code, or paragraph text. " +
                "Closing it means reading the quote's lines again with marked's indentation: re-lexing."

        private val KNOWN_DIFFERENCES =
            listOf(
                KnownDifference("known:quote-lazy-html-line-1", ">\\\n<b>", QUOTE_LAZY_LINES),
                KnownDifference("known:quote-lazy-html-line-2", "><b>\n\\", QUOTE_LAZY_LINES),
                KnownDifference("known:quote-lazy-html-line-3", "><\n<b>", QUOTE_LAZY_LINES),
                KnownDifference("known:list-lazy-html-line-1", "* \\\n<a>", LIST_LAZY_LINES),
                KnownDifference("known:list-lazy-html-line-2", "- [\n<b>", LIST_LAZY_LINES),
                KnownDifference("known:list-lazy-underline", "- \\\n=", LIST_LAZY_LINES),
                KnownDifference("known:closing-pre-tag-line-1", "</pre>\n-", CLOSING_PRE_TAG),
                KnownDifference("known:closing-pre-tag-line-2", "</pre> ", CLOSING_PRE_TAG),
                KnownDifference("known:closing-pre-tag-line-3", "</pre>\n~", CLOSING_PRE_TAG),
                KnownDifference("known:closing-pre-tag-line-4", "```\n```\n</pre>\n<", CLOSING_PRE_TAG),
                KnownDifference("known:emphasis-delimiters-1", "*a**~", EMPHASIS),
                KnownDifference("known:emphasis-delimiters-2", "<*a*>", EMPHASIS),
                KnownDifference("known:emphasis-delimiters-3", "*s**b**", EMPHASIS),
                KnownDifference("known:emphasis-after-underscore", "Use the a_*, b_* and c_* prefixes.", EMPHASIS),
                KnownDifference("known:tab-after-quote-marker-1", ">\t  ;", TAB_AFTER_QUOTE_MARKER),
                KnownDifference("known:tab-after-quote-marker-2", ">\t  `", TAB_AFTER_QUOTE_MARKER),
                KnownDifference("known:tab-after-quote-marker-3", ">>|\n>\t\t~", TAB_AFTER_QUOTE_MARKER),
                KnownDifference("known:tab-after-quote-marker-4", ">><\n>\t<\n[", TAB_AFTER_QUOTE_MARKER),
                KnownDifference("known:tab-after-quote-marker-5", ">\t<a>", TAB_AFTER_QUOTE_MARKER),
                KnownDifference("known:tab-after-quote-marker-6", ">>\\\n>\t|\n[", TAB_AFTER_QUOTE_MARKER),
                KnownDifference("known:list-lazy-underline-2", "- a\n--", LIST_LAZY_LINES),
                KnownDifference("known:list-lazy-underline-3", "1. a\n--", LIST_LAZY_LINES),
                KnownDifference("known:list-lazy-lines-1", "- - #\n)", LIST_LAZY_LINES),
                KnownDifference("known:list-lazy-lines-2", "- c\n  -\n\\", LIST_LAZY_LINES),
                KnownDifference("known:list-lazy-lines-3", "- >\ng\n-", LIST_LAZY_LINES),
                KnownDifference("known:quote-lazy-html-line-4", ">(\n<a>", QUOTE_LAZY_LINES),
                KnownDifference("known:quote-lazy-table", ">p\na||\n-|-", QUOTE_LAZY_LINES),
                KnownDifference("known:quote-lazy-after-blank-1", ">\t\nb\n>", QUOTE_AFTER_BLANK),
                KnownDifference("known:quote-lazy-after-blank-2", ">>  \n(", QUOTE_AFTER_BLANK),
                KnownDifference("known:quote-lazy-after-blank-3", ">\t\n    &", QUOTE_AFTER_BLANK),
                KnownDifference("known:quote-lazy-after-blank-4", ">\t\n[^x]:", QUOTE_AFTER_BLANK),
                KnownDifference(
                    "known:table-header-count",
                    "|\n|-",
                    "marked reads a table only when its header row splits into as many cells as its delimiter row, and `|` is no " +
                        "cell to marked, so it reads a paragraph where commonmark-java reads a table. Closing it means reading the " +
                        "rows again as a paragraph: re-lexing.",
                ),
                KnownDifference(
                    "known:link-definition-tab",
                    "[x]:\tl",
                    "marked's pattern for a link definition allows only spaces after the colon, so a tab there makes it a paragraph " +
                        "to marked and a definition to commonmark-java. Closing it means reading the definition again as a " +
                        "paragraph: re-lexing.",
                ),
                KnownDifference(
                    "known:link-definition-then-indented-line",
                    "[x]:u\n    \\",
                    "marked ends a link definition at its line, so an indented line after it is code, where commonmark-java " +
                        "continues the paragraph that held the definition. Closing it means reading the lines again as blocks: " +
                        "re-lexing.",
                ),
                KnownDifference(
                    "known:link-destination-paren",
                    "[](()",
                    "marked takes `(` as a link's address where CommonMark asks for balanced parentheses, so commonmark-java reads no " +
                        "link. Closing it means reading the brackets again as marked's link pattern: re-lexing.",
                ),
            )
    }
}
