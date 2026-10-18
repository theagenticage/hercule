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
 * Rogier approves it. In each mode where one differs, the port's tree is pinned, and must still
 * differ from client-core's, so that a fix shows here and its entry goes; in its other modes it
 * is checked like any case. Every
 * case that differs is listed, with its input and both trees, in
 * `build/markdown-parity-report.txt`.
 */
class MarkdownParityTest {
    private val modes = mapOf("agent" to Pair(false, true), "user" to Pair(true, false), "otherAgent" to Pair(true, true))

    /**
     * A case of the fixture where the port differs from client-core: its [id], its [input], why,
     * and the tree the port builds, as JSON, in each mode where it differs. In the other modes the
     * port must build client-core's tree, as for any case.
     */
    private class KnownDifference(val id: String, val input: String, val reason: String, val port: Map<String, String>)

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
                val pinned = known[id]?.port?.get(mode)
                val entry = "### $id [$mode] ${JsonPrimitive(input)}\n  client-core: $expected\n  port:        $actual\n\n"
                if (pinned != null) {
                    // A known difference: the port's tree is the one pinned, and it still differs from client-core's.
                    assertEquals(Json.parseToJsonElement(pinned), actual, "The port's tree for the known difference $id in $mode")
                    if (actual != expected) stillDiffering.add(id)
                    knownReport.append(entry)
                } else if (actual != expected) {
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
            "marked reads a line that starts with `</pre>` as a paragraph, and the port reads such an HTML block's lines " +
                "again as one. It does not when a later line starts with `<`, which may end marked's paragraph as an " +
                "HTML block: telling which would mean reading those lines as marked's blocks: re-lexing."

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
                KnownDifference("known:quote-lazy-html-line-1", ">\\\n<b>", QUOTE_LAZY_LINES, mapOf("agent" to """{"blocks":[{"type":"blockquote","children":[{"type":"paragraph","children":[{"type":"break"}]}]}],"footnotes":[]}""", "user" to """{"blocks":[{"type":"blockquote","children":[{"type":"paragraph","children":[{"type":"break"},{"type":"text","text":"<b>"}]}]}],"footnotes":[]}""", "otherAgent" to """{"blocks":[{"type":"blockquote","children":[{"type":"paragraph","children":[{"type":"break"}]}]}],"footnotes":[]}""")),
                KnownDifference("known:quote-lazy-html-line-2", "><b>\n\\", QUOTE_LAZY_LINES, mapOf("agent" to """{"blocks":[{"type":"blockquote","children":[]},{"type":"paragraph","children":[{"type":"text","text":"\\"}]}],"footnotes":[]}""", "user" to """{"blocks":[{"type":"blockquote","children":[{"type":"paragraph","children":[{"type":"text","text":"<b>"}]}]},{"type":"paragraph","children":[{"type":"text","text":"\\"}]}],"footnotes":[]}""", "otherAgent" to """{"blocks":[{"type":"blockquote","children":[]},{"type":"paragraph","children":[{"type":"text","text":"\\"}]}],"footnotes":[]}""")),
                KnownDifference("known:quote-lazy-html-line-3", "><\n<b>", QUOTE_LAZY_LINES, mapOf("agent" to """{"blocks":[{"type":"blockquote","children":[{"type":"paragraph","children":[{"type":"text","text":"<\n"}]}]}],"footnotes":[]}""", "user" to """{"blocks":[{"type":"blockquote","children":[{"type":"paragraph","children":[{"type":"text","text":"<"},{"type":"break"},{"type":"text","text":"<b>"}]}]}],"footnotes":[]}""", "otherAgent" to """{"blocks":[{"type":"blockquote","children":[{"type":"paragraph","children":[{"type":"text","text":"<"},{"type":"break"}]}]}],"footnotes":[]}""")),
                KnownDifference("known:list-lazy-html-line-1", "* \\\n<a>", LIST_LAZY_LINES, mapOf("agent" to """{"blocks":[{"type":"list","loose":false,"items":[{"children":[{"type":"paragraph","children":[{"type":"break"}]}]}]}],"footnotes":[]}""", "user" to """{"blocks":[{"type":"list","loose":false,"items":[{"children":[{"type":"paragraph","children":[{"type":"break"},{"type":"text","text":"<a>"}]}]}]}],"footnotes":[]}""", "otherAgent" to """{"blocks":[{"type":"list","loose":false,"items":[{"children":[{"type":"paragraph","children":[{"type":"break"}]}]}]}],"footnotes":[]}""")),
                KnownDifference("known:list-lazy-html-line-2", "- [\n<b>", LIST_LAZY_LINES, mapOf("agent" to """{"blocks":[{"type":"list","loose":false,"items":[{"children":[{"type":"paragraph","children":[{"type":"text","text":"[\n"}]}]}]}],"footnotes":[]}""", "user" to """{"blocks":[{"type":"list","loose":false,"items":[{"children":[{"type":"paragraph","children":[{"type":"text","text":"["},{"type":"break"},{"type":"text","text":"<b>"}]}]}]}],"footnotes":[]}""", "otherAgent" to """{"blocks":[{"type":"list","loose":false,"items":[{"children":[{"type":"paragraph","children":[{"type":"text","text":"["},{"type":"break"}]}]}]}],"footnotes":[]}""")),
                KnownDifference("known:list-lazy-underline", "- \\\n=", LIST_LAZY_LINES, mapOf("agent" to """{"blocks":[{"type":"list","loose":false,"items":[{"children":[{"type":"paragraph","children":[{"type":"break"},{"type":"text","text":"="}]}]}]}],"footnotes":[]}""", "user" to """{"blocks":[{"type":"list","loose":false,"items":[{"children":[{"type":"paragraph","children":[{"type":"break"},{"type":"text","text":"="}]}]}]}],"footnotes":[]}""", "otherAgent" to """{"blocks":[{"type":"list","loose":false,"items":[{"children":[{"type":"paragraph","children":[{"type":"break"},{"type":"text","text":"="}]}]}]}],"footnotes":[]}""")),
                KnownDifference("known:closing-pre-tag-then-html-line", "```\n```\n</pre>\n<", CLOSING_PRE_TAG, mapOf("agent" to """{"blocks":[{"type":"code","text":""},{"type":"paragraph","children":[{"type":"text","text":"<"}]}],"footnotes":[]}""", "user" to """{"blocks":[{"type":"code","text":""},{"type":"paragraph","children":[{"type":"text","text":"</pre>\n<"}]}],"footnotes":[]}""", "otherAgent" to """{"blocks":[{"type":"code","text":""},{"type":"paragraph","children":[{"type":"text","text":"<"}]}],"footnotes":[]}""")),
                KnownDifference("known:emphasis-delimiters-1", "*a**~", EMPHASIS, mapOf("agent" to """{"blocks":[{"type":"paragraph","children":[{"type":"emphasis","children":[{"type":"text","text":"a"}]},{"type":"text","text":"*~"}]}],"footnotes":[]}""", "user" to """{"blocks":[{"type":"paragraph","children":[{"type":"emphasis","children":[{"type":"text","text":"a"}]},{"type":"text","text":"*~"}]}],"footnotes":[]}""", "otherAgent" to """{"blocks":[{"type":"paragraph","children":[{"type":"emphasis","children":[{"type":"text","text":"a"}]},{"type":"text","text":"*~"}]}],"footnotes":[]}""")),
                KnownDifference("known:emphasis-delimiters-2", "<*a*>", EMPHASIS, mapOf("agent" to """{"blocks":[{"type":"paragraph","children":[{"type":"text","text":"<"},{"type":"emphasis","children":[{"type":"text","text":"a"}]},{"type":"text","text":">"}]}],"footnotes":[]}""", "user" to """{"blocks":[{"type":"paragraph","children":[{"type":"text","text":"<"},{"type":"emphasis","children":[{"type":"text","text":"a"}]},{"type":"text","text":">"}]}],"footnotes":[]}""", "otherAgent" to """{"blocks":[{"type":"paragraph","children":[{"type":"text","text":"<"},{"type":"emphasis","children":[{"type":"text","text":"a"}]},{"type":"text","text":">"}]}],"footnotes":[]}""")),
                KnownDifference("known:emphasis-delimiters-3", "*s**b**", EMPHASIS, mapOf("agent" to """{"blocks":[{"type":"paragraph","children":[{"type":"text","text":"*s"},{"type":"strong","children":[{"type":"text","text":"b"}]}]}],"footnotes":[]}""", "user" to """{"blocks":[{"type":"paragraph","children":[{"type":"text","text":"*s"},{"type":"strong","children":[{"type":"text","text":"b"}]}]}],"footnotes":[]}""", "otherAgent" to """{"blocks":[{"type":"paragraph","children":[{"type":"text","text":"*s"},{"type":"strong","children":[{"type":"text","text":"b"}]}]}],"footnotes":[]}""")),
                KnownDifference("known:emphasis-after-underscore", "Use the a_*, b_* and c_* prefixes.", EMPHASIS, mapOf("agent" to """{"blocks":[{"type":"paragraph","children":[{"type":"text","text":"Use the a_"},{"type":"emphasis","children":[{"type":"text","text":", b_"}]},{"type":"text","text":" and c_* prefixes."}]}],"footnotes":[]}""", "user" to """{"blocks":[{"type":"paragraph","children":[{"type":"text","text":"Use the a_"},{"type":"emphasis","children":[{"type":"text","text":", b_"}]},{"type":"text","text":" and c_* prefixes."}]}],"footnotes":[]}""", "otherAgent" to """{"blocks":[{"type":"paragraph","children":[{"type":"text","text":"Use the a_"},{"type":"emphasis","children":[{"type":"text","text":", b_"}]},{"type":"text","text":" and c_* prefixes."}]}],"footnotes":[]}""")),
                KnownDifference("known:tab-after-quote-marker-1", ">\t  ;", TAB_AFTER_QUOTE_MARKER, mapOf("agent" to """{"blocks":[{"type":"blockquote","children":[{"type":"code","text":";"}]}],"footnotes":[]}""", "user" to """{"blocks":[{"type":"blockquote","children":[{"type":"code","text":";"}]}],"footnotes":[]}""", "otherAgent" to """{"blocks":[{"type":"blockquote","children":[{"type":"code","text":";"}]}],"footnotes":[]}""")),
                KnownDifference("known:tab-after-quote-marker-2", ">\t  `", TAB_AFTER_QUOTE_MARKER, mapOf("agent" to """{"blocks":[{"type":"blockquote","children":[{"type":"code","text":"`"}]}],"footnotes":[]}""", "user" to """{"blocks":[{"type":"blockquote","children":[{"type":"code","text":"`"}]}],"footnotes":[]}""", "otherAgent" to """{"blocks":[{"type":"blockquote","children":[{"type":"code","text":"`"}]}],"footnotes":[]}""")),
                KnownDifference("known:tab-after-quote-marker-3", ">>|\n>\t\t~", TAB_AFTER_QUOTE_MARKER, mapOf("agent" to """{"blocks":[{"type":"blockquote","children":[{"type":"blockquote","children":[{"type":"paragraph","children":[{"type":"text","text":"|\n\t~"}]}]}]}],"footnotes":[]}""")),
                KnownDifference("known:tab-after-quote-marker-4", ">><\n>\t<\n[", TAB_AFTER_QUOTE_MARKER, mapOf("agent" to """{"blocks":[{"type":"blockquote","children":[{"type":"blockquote","children":[{"type":"paragraph","children":[{"type":"text","text":"<\n<\n\n["}]}]}]}],"footnotes":[]}""", "user" to """{"blocks":[{"type":"blockquote","children":[{"type":"blockquote","children":[{"type":"paragraph","children":[{"type":"text","text":"<"},{"type":"break"},{"type":"text","text":"<"},{"type":"break"},{"type":"break"},{"type":"text","text":"["}]}]}]}],"footnotes":[]}""", "otherAgent" to """{"blocks":[{"type":"blockquote","children":[{"type":"blockquote","children":[{"type":"paragraph","children":[{"type":"text","text":"<"},{"type":"break"},{"type":"text","text":"<"},{"type":"break"},{"type":"break"},{"type":"text","text":"["}]}]}]}],"footnotes":[]}""")),
                KnownDifference("known:tab-after-quote-marker-5", ">\t<a>", TAB_AFTER_QUOTE_MARKER, mapOf("user" to """{"blocks":[{"type":"blockquote","children":[{"type":"paragraph","children":[{"type":"text","text":"\t<a>"}]}]}],"footnotes":[]}""")),
                KnownDifference("known:tab-after-quote-marker-6", ">>\\\n>\t|\n[", TAB_AFTER_QUOTE_MARKER, mapOf("agent" to """{"blocks":[{"type":"blockquote","children":[{"type":"blockquote","children":[{"type":"paragraph","children":[{"type":"break"},{"type":"text","text":"|\n\n["}]}]}]}],"footnotes":[]}""", "user" to """{"blocks":[{"type":"blockquote","children":[{"type":"blockquote","children":[{"type":"paragraph","children":[{"type":"break"},{"type":"text","text":"|"},{"type":"break"},{"type":"break"},{"type":"text","text":"["}]}]}]}],"footnotes":[]}""", "otherAgent" to """{"blocks":[{"type":"blockquote","children":[{"type":"blockquote","children":[{"type":"paragraph","children":[{"type":"break"},{"type":"text","text":"|"},{"type":"break"},{"type":"break"},{"type":"text","text":"["}]}]}]}],"footnotes":[]}""")),
                KnownDifference("known:list-lazy-underline-2", "- a\n--", LIST_LAZY_LINES, mapOf("agent" to """{"blocks":[{"type":"list","loose":false,"items":[{"children":[{"type":"paragraph","children":[{"type":"text","text":"a\n--"}]}]}]}],"footnotes":[]}""", "user" to """{"blocks":[{"type":"list","loose":false,"items":[{"children":[{"type":"paragraph","children":[{"type":"text","text":"a"},{"type":"break"},{"type":"text","text":"--"}]}]}]}],"footnotes":[]}""", "otherAgent" to """{"blocks":[{"type":"list","loose":false,"items":[{"children":[{"type":"paragraph","children":[{"type":"text","text":"a"},{"type":"break"},{"type":"text","text":"--"}]}]}]}],"footnotes":[]}""")),
                KnownDifference("known:list-lazy-underline-3", "1. a\n--", LIST_LAZY_LINES, mapOf("agent" to """{"blocks":[{"type":"list","start":1,"loose":false,"items":[{"children":[{"type":"paragraph","children":[{"type":"text","text":"a\n--"}]}]}]}],"footnotes":[]}""", "user" to """{"blocks":[{"type":"list","start":1,"loose":false,"items":[{"children":[{"type":"paragraph","children":[{"type":"text","text":"a"},{"type":"break"},{"type":"text","text":"--"}]}]}]}],"footnotes":[]}""", "otherAgent" to """{"blocks":[{"type":"list","start":1,"loose":false,"items":[{"children":[{"type":"paragraph","children":[{"type":"text","text":"a"},{"type":"break"},{"type":"text","text":"--"}]}]}]}],"footnotes":[]}""")),
                KnownDifference("known:list-lazy-lines-1", "- - #\n)", LIST_LAZY_LINES, mapOf("agent" to """{"blocks":[{"type":"list","loose":false,"items":[{"children":[{"type":"list","loose":false,"items":[{"children":[{"type":"heading","depth":1,"children":[]}]}]}]}]},{"type":"paragraph","children":[{"type":"text","text":")"}]}],"footnotes":[]}""", "user" to """{"blocks":[{"type":"list","loose":false,"items":[{"children":[{"type":"list","loose":false,"items":[{"children":[{"type":"heading","depth":1,"children":[]}]}]}]}]},{"type":"paragraph","children":[{"type":"text","text":")"}]}],"footnotes":[]}""", "otherAgent" to """{"blocks":[{"type":"list","loose":false,"items":[{"children":[{"type":"list","loose":false,"items":[{"children":[{"type":"heading","depth":1,"children":[]}]}]}]}]},{"type":"paragraph","children":[{"type":"text","text":")"}]}],"footnotes":[]}""")),
                KnownDifference("known:list-lazy-lines-2", "- c\n  -\n\\", LIST_LAZY_LINES, mapOf("agent" to """{"blocks":[{"type":"list","loose":false,"items":[{"children":[{"type":"heading","depth":2,"children":[{"type":"text","text":"c"}]}]}]},{"type":"paragraph","children":[{"type":"text","text":"\\"}]}],"footnotes":[]}""", "user" to """{"blocks":[{"type":"list","loose":false,"items":[{"children":[{"type":"heading","depth":2,"children":[{"type":"text","text":"c"}]}]}]},{"type":"paragraph","children":[{"type":"text","text":"\\"}]}],"footnotes":[]}""", "otherAgent" to """{"blocks":[{"type":"list","loose":false,"items":[{"children":[{"type":"heading","depth":2,"children":[{"type":"text","text":"c"}]}]}]},{"type":"paragraph","children":[{"type":"text","text":"\\"}]}],"footnotes":[]}""")),
                KnownDifference("known:list-lazy-lines-3", "- >\ng\n-", LIST_LAZY_LINES, mapOf("agent" to """{"blocks":[{"type":"list","loose":false,"items":[{"children":[{"type":"blockquote","children":[]}]}]},{"type":"heading","depth":2,"children":[{"type":"text","text":"g"}]}],"footnotes":[]}""", "user" to """{"blocks":[{"type":"list","loose":false,"items":[{"children":[{"type":"blockquote","children":[]}]}]},{"type":"heading","depth":2,"children":[{"type":"text","text":"g"}]}],"footnotes":[]}""", "otherAgent" to """{"blocks":[{"type":"list","loose":false,"items":[{"children":[{"type":"blockquote","children":[]}]}]},{"type":"heading","depth":2,"children":[{"type":"text","text":"g"}]}],"footnotes":[]}""")),
                KnownDifference("known:quote-lazy-html-line-4", ">(\n<a>", QUOTE_LAZY_LINES, mapOf("agent" to """{"blocks":[{"type":"blockquote","children":[{"type":"paragraph","children":[{"type":"text","text":"(\n"}]}]}],"footnotes":[]}""", "user" to """{"blocks":[{"type":"blockquote","children":[{"type":"paragraph","children":[{"type":"text","text":"("},{"type":"break"},{"type":"text","text":"<a>"}]}]}],"footnotes":[]}""", "otherAgent" to """{"blocks":[{"type":"blockquote","children":[{"type":"paragraph","children":[{"type":"text","text":"("},{"type":"break"}]}]}],"footnotes":[]}""")),
                KnownDifference("known:quote-lazy-table", ">p\na||\n-|-", QUOTE_LAZY_LINES, mapOf("agent" to """{"blocks":[{"type":"blockquote","children":[{"type":"paragraph","children":[{"type":"text","text":"p\na||\n-|-"}]}]}],"footnotes":[]}""", "user" to """{"blocks":[{"type":"blockquote","children":[{"type":"paragraph","children":[{"type":"text","text":"p"},{"type":"break"},{"type":"text","text":"a||"},{"type":"break"},{"type":"text","text":"-|-"}]}]}],"footnotes":[]}""", "otherAgent" to """{"blocks":[{"type":"blockquote","children":[{"type":"paragraph","children":[{"type":"text","text":"p"},{"type":"break"},{"type":"text","text":"a||"},{"type":"break"},{"type":"text","text":"-|-"}]}]}],"footnotes":[]}""")),
                KnownDifference("known:quote-lazy-after-blank-1", ">\t\nb\n>", QUOTE_AFTER_BLANK, mapOf("agent" to """{"blocks":[{"type":"blockquote","children":[{"type":"paragraph","children":[{"type":"text","text":"b"}]}]},{"type":"blockquote","children":[]}],"footnotes":[]}""", "user" to """{"blocks":[{"type":"blockquote","children":[{"type":"paragraph","children":[{"type":"text","text":"b"}]}]},{"type":"blockquote","children":[]}],"footnotes":[]}""", "otherAgent" to """{"blocks":[{"type":"blockquote","children":[{"type":"paragraph","children":[{"type":"text","text":"b"}]}]},{"type":"blockquote","children":[]}],"footnotes":[]}""")),
                KnownDifference("known:quote-lazy-after-blank-2", ">>  \n(", QUOTE_AFTER_BLANK, mapOf("agent" to """{"blocks":[{"type":"blockquote","children":[{"type":"blockquote","children":[]}]},{"type":"paragraph","children":[{"type":"text","text":"("}]}],"footnotes":[]}""", "user" to """{"blocks":[{"type":"blockquote","children":[{"type":"blockquote","children":[]}]},{"type":"paragraph","children":[{"type":"text","text":"("}]}],"footnotes":[]}""", "otherAgent" to """{"blocks":[{"type":"blockquote","children":[{"type":"blockquote","children":[]}]},{"type":"paragraph","children":[{"type":"text","text":"("}]}],"footnotes":[]}""")),
                KnownDifference("known:quote-lazy-after-blank-3", ">\t\n    &", QUOTE_AFTER_BLANK, mapOf("agent" to """{"blocks":[{"type":"blockquote","children":[]},{"type":"code","text":"&"}],"footnotes":[]}""", "user" to """{"blocks":[{"type":"blockquote","children":[]},{"type":"code","text":"&"}],"footnotes":[]}""", "otherAgent" to """{"blocks":[{"type":"blockquote","children":[]},{"type":"code","text":"&"}],"footnotes":[]}""")),
                KnownDifference("known:quote-lazy-after-blank-4", ">\t\n[^x]:", QUOTE_AFTER_BLANK, mapOf("agent" to """{"blocks":[{"type":"blockquote","children":[]}],"footnotes":[]}""", "user" to """{"blocks":[{"type":"blockquote","children":[]}],"footnotes":[]}""", "otherAgent" to """{"blocks":[{"type":"blockquote","children":[]}],"footnotes":[]}""")),
                KnownDifference(
                    "known:link-definition-tab",
                    "[x]:\tl",
                    "marked's pattern for a link definition allows only spaces after the colon, so a tab there makes it a paragraph " +
                        "to marked and a definition to commonmark-java. Closing it means reading the definition again as a " +
                        "paragraph: re-lexing.",
                    mapOf("agent" to """{"blocks":[],"footnotes":[]}""", "user" to """{"blocks":[],"footnotes":[]}""", "otherAgent" to """{"blocks":[],"footnotes":[]}"""),
                ),
                KnownDifference(
                    "known:link-definition-then-indented-line",
                    "[x]:u\n    \\",
                    "marked ends a link definition at its line, so an indented line after it is code, where commonmark-java " +
                        "continues the paragraph that held the definition. Closing it means reading the lines again as blocks: " +
                        "re-lexing.",
                    mapOf("agent" to """{"blocks":[{"type":"paragraph","children":[{"type":"text","text":"    \\"}]}],"footnotes":[]}""", "user" to """{"blocks":[{"type":"paragraph","children":[{"type":"text","text":"    \\"}]}],"footnotes":[]}""", "otherAgent" to """{"blocks":[{"type":"paragraph","children":[{"type":"text","text":"    \\"}]}],"footnotes":[]}"""),
                ),
                KnownDifference(
                    "known:link-destination-paren",
                    "[](()",
                    "marked takes `(` as a link's address where CommonMark asks for balanced parentheses, so commonmark-java reads no " +
                        "link. Closing it means reading the brackets again as marked's link pattern: re-lexing.",
                    mapOf("agent" to """{"blocks":[{"type":"paragraph","children":[{"type":"text","text":"[](()"}]}],"footnotes":[]}""", "user" to """{"blocks":[{"type":"paragraph","children":[{"type":"text","text":"[](()"}]}],"footnotes":[]}""", "otherAgent" to """{"blocks":[{"type":"paragraph","children":[{"type":"text","text":"[](()"}]}],"footnotes":[]}"""),
                ),
            )
    }
}
