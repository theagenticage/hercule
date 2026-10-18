package dev.hercule.android.markdown

import kotlin.math.ceil

/*
 * The worst-case inputs of parseMarkdown, shared by MarkdownWorstCaseTest, which checks the output
 * of each, and MarkdownSpeedTest, which times each. A port of
 * packages/client-core/src/markdown-worst-case.testing.ts, input for input.
 *
 * A comment is untrusted and can be hundreds of kilobytes long, and the parse runs on the phone.
 * These inputs are the ones that once made client-core's parse take seconds, and the kinds of
 * input that tend to.
 */

/** The size of each input, in characters. */
const val WORST_CASE_BYTES = 200_000

/**
 * One worst-case input. [shownText] is the text the parse must show, without white space, in
 * document order, or null when that is not simple to say. An empty string means the parse must
 * show nothing.
 */
class WorstCaseInput(val name: String, val text: String, val shownText: String?)

/** Makes an input of [WORST_CASE_BYTES] characters by repeating [fragment] between [before] and [after]. */
private fun repeated(
    name: String,
    fragment: String,
    before: String = "",
    after: String = "",
    shows: String? = null,
    showsBefore: String = "",
    showsAfter: String = "",
): WorstCaseInput {
    val count = ceil(WORST_CASE_BYTES.toDouble() / fragment.length).toInt()
    return WorstCaseInput(name, before + fragment.repeat(count) + after, shows?.let { showsBefore + it.repeat(count) + showsAfter })
}

val WORST_CASE_INPUTS: List<WorstCaseInput> =
    listOf(
        // Tags and brackets without white space, in a block of HTML.
        repeated("open tags `<a`", "<a", before = "<div>\n"),
        repeated("open tags `<a=`", "<a=", before = "<div>\n"),
        repeated("open tags `<a \"`", "<a \"", before = "<div>\n"),
        repeated("open tags `<a/`", "<a/", before = "<div>\n"),
        repeated("open tags `<a<b`", "<a<b", before = "<div>\n"),
        repeated("open tags with an unclosed quote", "<a b='", before = "<div>\n"),
        repeated("end tags `</x`", "</x", before = "<div>\n"),
        repeated("declarations `<!-`", "<!-", before = "<div>\n"),
        repeated("declarations `<!`", "<!", before = "<div>\n"),
        repeated("open tags closed at the end", "<x", before = "<div>\n", after = ">"),
        repeated("comments `<!--`", "<!--", before = "<div>\n"),
        // Text next to tags that are not HTML or are dropped.
        repeated("generic types `x<T>` in a block", "x<T>", before = "<div>\n", shows = "x<T>"),
        repeated("generic types `x<T>` in a line", "x<T>", shows = "x<T>"),
        repeated("dropped tags `x<span>`", "x<span>", before = "<div>\n", shows = "x"),
        repeated("dropped tags `x<span>` in a line", "x<span>", shows = "x"),
        // White space.
        WorstCaseInput("spaces kept in pre", "<pre><p>x${" ".repeat(WORST_CASE_BYTES)}y</p></pre>", "xy"),
        WorstCaseInput("spaces in a paragraph", "<p>x${" ".repeat(WORST_CASE_BYTES)}y</p>", "xy"),
        WorstCaseInput("spaces in a cell", "<table><tr><td>x${" ".repeat(WORST_CASE_BYTES)}y</td></tr></table>", "xy"),
        WorstCaseInput("spaces in a heading", "<h1>x${" ".repeat(WORST_CASE_BYTES)}y</h1>", "xy"),
        repeated("spaces between words", "x  \n  ", before = "<div>\n", shows = "x"),
        WorstCaseInput("spaces kept in code in pre", "<pre><code>x${" ".repeat(WORST_CASE_BYTES)}<b>y</b></code></pre>", "xy"),
        // Parts that close each other, and parts without a parent.
        repeated("cells `<td>x` in a block", "<td>x", before = "<div>\n", shows = "x"),
        repeated("cells `<td>x` in a row", "<td>x", before = "<table><tr>", shows = "x"),
        repeated("rows `<tr><td>x`", "<tr><td>x", before = "<table>", shows = "x"),
        WorstCaseInput(
            "wide rows",
            "<table><tr>${"<td>x".repeat(WORST_CASE_BYTES / 5)}</tr>${"<tr><td>y".repeat(WORST_CASE_BYTES / 20)}",
            "x".repeat(WORST_CASE_BYTES / 5) + "y".repeat(WORST_CASE_BYTES / 20),
        ),
        repeated("items `<li>x`", "<li>x", before = "<ul>", shows = "x"),
        repeated("items `<li>x</li>` without a list", "<li>x</li>", shows = "x"),
        repeated("summaries `<summary>x`", "<summary>x", before = "<details>", shows = "x"),
        // Elements that are never closed.
        repeated("unclosed `<b>`", "<b>", shows = ""),
        repeated("unclosed `<b>x`", "<b>x", before = "<div>\n", shows = "x"),
        repeated("unclosed `<div>`", "<div>", after = "x", shows = "", showsAfter = "x"),
        repeated("close tags without an open tag", "</b>x", before = "<div>\n", shows = "x"),
        repeated("scripts `<script>x`", "<script>x", before = "<div>\n"),
        // Markdown mixed with HTML.
        repeated("markdown paragraphs inside details", "para **x**\n\n", before = "<details>\n\n", shows = "parax", showsBefore = "Details"),
        repeated("html blocks and paragraphs", "<b>x</b>\n\nword\n\n", shows = "xword"),
        repeated("headings inside a quote", "> # h <i>x</i>\n", shows = "hx"),
        repeated("links and images in HTML", "<a href=\"https://e.com/a b\">[x](/y)</a><img src=\"/i.png\"> ", shows = "x"),
        repeated("nested links", "<a href=\"/a\">[x](/y) ", after = "</a>", shows = "x"),
        repeated("list items with HTML", "1. <b>x</b>\n", shows = "x"),
        repeated("table rows with HTML", "| <b>x</b> | <i>y</i> |\n", before = "| a | b |\n|---|---|\n", shows = "xy", showsBefore = "ab"),
        // Footnotes, with HTML.
        repeated("footnote references", "x[^1] ", after = "\n\n[^1]: note", shows = "x", showsAfter = "note"),
        repeated("footnote references in HTML code", "<code>[^1]</code> ", after = "\n\n[^1]: note", shows = "[^1]"),
        repeated("footnotes with HTML", "[^1]", after = "\n\n[^1]: <b>x</b> note", shows = "", showsAfter = "xnote"),
        // The inputs that once made the footnote parser or marked slow.
        WorstCaseInput("an unterminated comment and many blank lines", "<!--${"\n".repeat(WORST_CASE_BYTES)}x", ""),
        repeated("a long run of footnote-like brackets", "[^", shows = "[^"),
        WorstCaseInput("many footnote definitions and references", "[^a]: x\n".repeat(20_000) + "[^a] ".repeat(20_000), null),
        WorstCaseInput("a footnote definition with many lazy continuation lines", "[^a]: first\n${"lazy\n".repeat(20_000)}", null),
        repeated("many paragraphs cut by headings", "a\n# h\n", shows = "ah"),
    )
