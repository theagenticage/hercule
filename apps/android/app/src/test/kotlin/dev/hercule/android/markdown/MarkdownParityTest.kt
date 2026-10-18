package dev.hercule.android.markdown

import java.io.File
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
 * A case where client-core's parser throws holds `"fallback"`: the port must then show the raw
 * text, as client-core's callers do.
 *
 * Every case that differs is listed, with its input and both trees, in
 * `build/markdown-parity-report.txt`.
 */
class MarkdownParityTest {
    private val modes = mapOf("agent" to Pair(false, true), "user" to Pair(true, false), "otherAgent" to Pair(true, true))

    @Test
    fun `builds the same tree as client-core for every case of the fixture`() {
        val fixture = Json.parseToJsonElement(javaClass.getResource("/markdown/parity.json")!!.readText()).jsonArray
        val failures = StringBuilder()
        var failed = 0
        var compared = 0
        for (case in fixture) {
            val fields = case.jsonObject
            val id = fields.getValue("id").jsonPrimitive.content
            val input = fields.getValue("input").jsonPrimitive.content
            for ((mode, options) in modes) {
                val (breaks, embeddedHtml) = options
                val expectedField = fields.getValue(mode)
                val expected: JsonElement =
                    if (expectedField is JsonPrimitive && expectedField.content == "fallback") {
                        encodeDocument(MarkdownDocument(listOf(MarkdownBlock.Paragraph(listOf(MarkdownInline.Text(input)))), emptyList()))
                    } else {
                        expectedField
                    }
                val actual = encodeDocument(parseMarkdown(input, breaks = breaks, embeddedHtml = embeddedHtml))
                compared++
                if (actual != expected) {
                    failed++
                    failures.append("### $id [$mode] ${JsonPrimitive(input)}\n  client-core: $expected\n  port:        $actual\n\n")
                }
            }
        }
        File("build/markdown-parity-report.txt").writeText("$failed of $compared differ\n\n$failures")
        if (failed > 0) fail("$failed of $compared parses differ from client-core; see build/markdown-parity-report.txt\n\n${failures.take(6000)}")
    }
}
