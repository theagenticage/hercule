package dev.hercule.android.markdown

import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.junit.Test

/**
 * Tests the HTML that [parseMarkdown] reads inside markdown: the markdown or HTML a GitHub comment can hold, and the whole tree it parses to.
 *
 * The cases are copied one for one from packages/client-core/src/markdown-html.test.ts, in its order and under its names, each
 * with the tree that client-core builds for it.
 */
class MarkdownHtmlTest {
    // parseMarkdown embedded HTML in a bot comment

    @Test
    fun `parses a Cypress comment empty rows, a header cell across two columns, images, code and a footer`() {
        assertEquals(
            document(heading(3, link("https://cloud.cypress.io/projects/hb1gva/runs/27699", null, text("Cypress run 27699"))), table(
                    header = listOf(cell(listOf(text("Test results")), 2, ColumnAlignment.Left)),
                    rows = listOf(listOf(cell(listOf(MarkdownInline.Image("https://assets.cypress.io/github-pr-comment-icons/failed.svg", "Tests that failed", null, width = 10, height = 10), text("\u00A0 "), link("https://cloud.cypress.io/projects/hb1gva/runs/27699/overview?reviewViewBy=FAILED&utm_source=github", null, strong(text("Failures")))), 1, ColumnAlignment.Left), cell(listOf(inlineCode("0")), 1, ColumnAlignment.Left)), listOf(cell(listOf(link("https://cloud.cypress.io/projects/hb1gva/runs/27699", null, text("View all changes introduced in this branch ↗︎"))), 2, ColumnAlignment.Left))),
                )),
            parseMarkdown("<h3><a href=\"https://cloud.cypress.io/projects/hb1gva/runs/27699\">Cypress run 27699</a></h3>\n<table>\n  <thead>\n    <tr />\n    <tr height=\"48\">\n      <th colspan=\"2\" align=\"left\" width=\"744\">Test results</th>\n    </tr />\n  </thead>\n  <tbody>\n    <tr />\n    <tr>\n      <td width=\"224\"><picture><img src=\"https://assets.cypress.io/github-pr-comment-icons/failed.svg\" alt=\"Tests that failed\" width=\"10\" height=\"10\" /></picture>&nbsp; <a href=\"https://cloud.cypress.io/projects/hb1gva/runs/27699/overview?reviewViewBy=FAILED&utm_source=github\"><strong>Failures</strong></a></td>\n      <td><code><strong>0</strong></code></td>\n    </tr>\n  </tbody>\n  <tfoot>\n    <tr height=\"48\">\n      <td colspan=\"2\"><a href=\"https://cloud.cypress.io/projects/hb1gva/runs/27699\">View all changes introduced in this branch ↗︎</a></td>\n    </tr>\n  </tfoot>\n</table>"),
        )
    }

    @Test
    fun `parses a Renovate details block that holds markdown between its tags`() {
        assertEquals(
            document(details(listOf(text("renovatebot/renovate (renovate)")), heading(3, text("v1.2.3")), list(start = null, loose = false,
                        item(paragraph(text("fix: a "), strong(text("thing")))),
                    )), paragraph(text("After."))),
            parseMarkdown("<details>\n<summary>renovatebot/renovate (renovate)</summary>\n\n### v1.2.3\n\n- fix: a **thing**\n\n</details>\n\nAfter."),
        )
    }

    @Test
    fun `nests one details block in another, and gives a missing summary a name`() {
        assertEquals(
            document(details(listOf(text("Outer")), details(listOf(text("Details")), paragraph(text("inner text"))))),
            parseMarkdown("<details>\n<summary>Outer</summary>\n\n<details>\n\ninner text\n\n</details>\n\n</details>"),
        )
    }

    // parseMarkdown embedded HTML inside a line

    @Test
    fun `wraps the text between an open tag and its close tag`() {
        assertEquals(
            document(paragraph(text("a "), strong(text("b")), text(" c "), emphasis(text("d")), text(" "), strikethrough(text("e")), text(" "), strong(text("f")), text(" "), emphasis(text("g")))),
            parseMarkdown("a <strong>b</strong> c <em>d</em> <del>e</del> <b>f</b> <i>g</i>"),
        )
    }

    @Test
    fun `wraps markdown that sits between the tags`() {
        assertEquals(
            document(paragraph(strong(text("a "), strong(text("b")), text(" "), link("/c", null, text("c"))))),
            parseMarkdown("<b>a **b** [c](/c)</b>"),
        )
    }

    @Test
    fun `parses a break, a link with a title, and an image with unquoted attributes`() {
        assertEquals(
            document(paragraph(text("one"), MarkdownInline.Break, text("two"), MarkdownInline.Break, text("three "), link("https://e.com/?a=1&b=2", "x & y", text("l")), text(" "), MarkdownInline.Image("https://e.com/a.png", "pic", null, width = 10, height = 20))),
            parseMarkdown("one<br>two<br/>three <a href=\"https://e.com/?a=1&amp;b=2\" title=\"x &amp; y\">l</a> <img src=https://e.com/a.png alt=pic width=10 height=20 hidden>"),
        )
    }

    @Test
    fun `reads tag and attribute names in any case`() {
        assertEquals(
            document(paragraph(link("/x", null, text("y")), text(" "), strong(text("z")))),
            parseMarkdown("<A HREF=\"/x\">y</A> <STRONG>z</STRONG>"),
        )
    }

    @Test
    fun `ignores a close tag that nothing opened, and closes an open tag at the end`() {
        assertEquals(
            document(paragraph(text("a b "), strong(text("c")))),
            parseMarkdown("a</b> b <strong>c"),
        )
    }

    @Test
    fun `keeps a less-than sign that does not start a tag as text`() {
        assertEquals(
            document(paragraph(text("1 < 2 and 3 <4"))),
            parseMarkdown("1 < 2 and 3 <4"),
        )
    }

    // parseMarkdown embedded HTML blocks

    @Test
    fun `numbers an ordered list from 1 when it gives no number, and keeps a given number`() {
        assertEquals(
            document(list(start = 1, loose = false,
                    item(paragraph(text("a"))),
                )),
            parseMarkdown("<ol><li>a</li></ol>"),
        )
        assertEquals(
            document(list(start = 1, loose = false,
                    item(paragraph(text("a"))),
                )),
            parseMarkdown("<ol start=\"oops\"><li>a</li></ol>"),
        )
        assertEquals(
            document(list(start = 0, loose = false,
                    item(paragraph(text("a"))),
                )),
            parseMarkdown("<ol start=\"0\"><li>a</li></ol>"),
        )
        assertEquals(
            document(list(start = -3, loose = false,
                    item(paragraph(text("a"))),
                )),
            parseMarkdown("<ol start=\"-3\"><li>a</li></ol>"),
        )
        assertEquals(
            document(list(start = null, loose = false,
                    item(paragraph(text("a"))),
                )),
            parseMarkdown("<ul start=\"5\"><li>a</li></ul>"),
        )
    }

    @Test
    fun `parses paragraphs, headings, a quote, a rule, lists and preformatted text`() {
        assertEquals(
            document(heading(2, text("Title")), paragraph(text("First "), strong(text("line"))), blockquote(paragraph(text("quoted"))), MarkdownBlock.Rule, list(start = 3, loose = false,
                    item(paragraph(text("three"))),
                    item(paragraph(text("four"))),
                ), list(start = null, loose = false,
                    item(paragraph(text("a"))),
                ), code("x < y\n  z")),
            parseMarkdown("<h2>Title</h2>\n<p>First <b>line</b></p>\n<blockquote><p>quoted</p></blockquote>\n<hr>\n<ol start=\"3\"><li>three</li><li>four</li></ol>\n<ul><li>a</li></ul>\n<pre><code>x &lt; y\n  z</code></pre>"),
        )
    }

    @Test
    fun `makes each div its own paragraph and collapses the white space between words`() {
        assertEquals(
            document(paragraph(text("one two")), paragraph(text("three"))),
            parseMarkdown("<div>one\n   two</div><div>three</div>"),
        )
    }

    // parseMarkdown embedded HTML tables

    @Test
    fun `uses the first row as the header when all its cells are th, and pads short rows`() {
        assertEquals(
            document(table(
                    header = listOf(cell(listOf(text("A")), 1, ColumnAlignment.Center), cell(listOf(text("B")), 1, null), cell(listOf(text("C")), 1, null)),
                    rows = listOf(listOf(cell(listOf(text("1")), 1, ColumnAlignment.Center), cell(listOf(), 2, null)), listOf(cell(listOf(text("2")), 2, ColumnAlignment.Center), cell(listOf(text("x")), 1, null))),
                )),
            parseMarkdown("<table><tr><th align=\"center\">A</th><th>B</th><th>C</th></tr><tr><td>1</td></tr><tr><td colspan=\"2\">2</td><td>x</td></tr></table>"),
        )
    }

    @Test
    fun `covers columns with a colspan and pads a short row by the columns it covers`() {
        assertEquals(
            document(table(
                    header = listOf(cell(listOf(text("A")), 1, null), cell(listOf(text("B")), 1, null), cell(listOf(text("C")), 1, null)),
                    rows = listOf(listOf(cell(listOf(text("ab")), 2, null), cell(listOf(), 1, null)), listOf(cell(listOf(text("xy")), 2, null), cell(listOf(text("z")), 1, null))),
                )),
            parseMarkdown("<table><tr><th>A</th><th>B</th><th>C</th></tr><tr><td colspan=\"2\">ab</td></tr><tr><td colspan=\"2\">xy</td><td>z</td></tr></table>"),
        )
    }

    @Test
    fun `widens the table to the row that covers the most columns`() {
        assertEquals(
            document(table(
                    header = listOf(),
                    rows = listOf(listOf(cell(listOf(text("a")), 1, null), cell(listOf(), 2, null)), listOf(cell(listOf(text("b")), 3, null))),
                )),
            parseMarkdown("<table><tr><td>a</td></tr><tr><td colspan=\"3\">b</td></tr></table>"),
        )
    }

    @Test
    fun `reads a colspan that is not a whole number above zero as one column`() {
        assertEquals(
            document(table(
                    header = listOf(),
                    rows = listOf(listOf(cell(listOf(text("a")), 1, null), cell(listOf(text("b")), 1, null), cell(listOf(text("c")), 1, null), cell(listOf(text("d")), 1, null))),
                )),
            parseMarkdown("<table><tr><td colspan=\"0\">a</td><td colspan=\"-2\">b</td><td colspan=\"two\">c</td><td colspan=\"1.5\">d</td></tr></table>"),
        )
    }

    @Test
    fun `cuts a colspan that reaches past the column limit, and joins the cells after it`() {
        assertEquals(
            document(table(
                    header = listOf(),
                    rows = listOf(listOf(cell(listOf(text("a")), 1, null), cell(listOf(text("b c")), 63, null)), listOf(cell(listOf(text("d")), 64, null))),
                )),
            parseMarkdown("<table><tr><td>a</td><td colspan=\"500\">b</td><td>c</td></tr><tr><td colspan=\"99999\">d</td></tr></table>"),
        )
    }

    @Test
    fun `leaves the header empty for a table of td cells only`() {
        assertEquals(
            document(table(
                    header = listOf(),
                    rows = listOf(listOf(cell(listOf(text("a")), 1, null), cell(listOf(text("b")), 1, null))),
                )),
            parseMarkdown("<table><tr><td>a</td><td>b</td></tr></table>"),
        )
    }

    @Test
    fun `flattens block content in a cell, such as markdown between blank lines, to inlines`() {
        assertEquals(
            document(table(
                    header = listOf(),
                    rows = listOf(listOf(cell(listOf(strong(text("a")), MarkdownInline.Break, text("b")), 1, null), cell(listOf(text("c"), MarkdownInline.Break, text("d")), 1, null))),
                )),
            parseMarkdown("<table>\n<tr>\n<td>\n\n**a**\n\nb\n\n</td>\n<td><p>c</p><p>d</p></td>\n</tr>\n</table>"),
        )
    }

    // parseMarkdown embedded HTML safety

    @Test
    fun `drops a javascript link and keeps its text`() {
        assertEquals(
            document(paragraph(text("x y"))),
            parseMarkdown("<a href=\"javascript:alert(1)\">x</a> <a href=\"java&#115;cript:alert(1)\">y</a>"),
        )
    }

    @Test
    fun `drops an unsafe image and keeps its alt text`() {
        assertEquals(
            document(paragraph(text("pic "))),
            parseMarkdown("<img src=\"javascript:alert(1)\" alt=\"pic\"> <img src=\"data:text/html,hi\">"),
        )
    }

    @Test
    fun `keeps the same links and images markdown would keep, percent-encoded the same way`() {
        assertEquals(
            document(paragraph(link("/a%20b", null, text("x")))),
            parseMarkdown("<a href=\"/a b\">x</a>"),
        )
        assertEquals(
            document(paragraph(link("/a%20b", null, text("x")))),
            parseMarkdown("[x](/a%20b)"),
        )
    }

    @Test
    fun `drops script and style with their content when one piece of HTML holds both tags`() {
        assertEquals(
            document(paragraph(text("A"), strong(text("B")))),
            parseMarkdown("<script>\nalert(1)\n\nif (a < b) {}\n</script>\n\n<style>p { color: red }</style>\n\nA<b>B</b>"),
        )
    }

    @Test
    fun `stops dropping at the end of a script tag that nothing closes, so prose is not lost`() {
        assertEquals(
            document(paragraph(text("the tag is dangerous and more"))),
            parseMarkdown("the <script> tag is dangerous and more"),
        )
        assertEquals(
            document(paragraph(text("Aalert(2)B"))),
            parseMarkdown("A<script>alert(2)</script>B"),
        )
    }

    @Test
    fun `keeps the text of a script or style tag at a line start that nothing closes`() {
        assertEquals(
            document(paragraph(text("tags are bad. More text here."))),
            parseMarkdown("<script> tags are bad.\n\nMore text here."),
        )
        assertEquals(
            document(paragraph(text("rules. More text here."))),
            parseMarkdown("<style> rules.\n\nMore text here."),
        )
    }

    @Test
    fun `drops comments, in a block and in a line, even one cut off`() {
        assertEquals(
            document(paragraph(text("ab"))),
            parseMarkdown("a<!-- hidden <b>x</b> -->b"),
        )
        assertEquals(
            document(paragraph(text("shown"))),
            parseMarkdown("<!-- hidden\n\nstill hidden -->\n\nshown"),
        )
        assertEquals(
            document(paragraph(text("shown"))),
            parseMarkdown("<div>shown</div>\n<!-- cut off <b>"),
        )
    }

    @Test
    fun `drops the tags of an element that is not in the list and keeps its text`() {
        assertEquals(
            document(paragraph(text("a b c"))),
            parseMarkdown("<span class=\"x\">a</span> <sub>b</sub> <form action=\"/steal\"><input type=password>c</form>"),
        )
    }

    @Test
    fun `ignores event handlers, styles and other attributes of a listed element`() {
        assertEquals(
            document(paragraph(strong(text("x")))),
            parseMarkdown("<b onclick=\"alert(1)\" style=\"position:fixed\">x</b>"),
        )
    }

    @Test
    fun `ignores an image size that is not a whole number of pixels`() {
        assertEquals(
            document(paragraph(MarkdownInline.Image("/a.png", "", null), text(" "), MarkdownInline.Image("/b.png", "", null))),
            parseMarkdown("<img src=\"/a.png\" width=\"50%\" height=\"-4\"> <img src=\"/b.png\" width=\"0\" height=\"1e3\">"),
        )
    }

    // parseMarkdown embedded HTML never loses text

    @Test
    fun `keeps content that a table or a list does not use, in front of the block`() {
        assertEquals(
            document(paragraph(text("next para "), strong(text("after"))), heading(1, text("heading"))),
            parseMarkdown("<table>\n\nnext para **after**\n\n# heading"),
        )
        assertEquals(
            document(paragraph(text("rest"))),
            parseMarkdown("<ul>\n\nrest"),
        )
        assertEquals(
            document(paragraph(text("the tag here and more"))),
            parseMarkdown("the <table> tag here and more"),
        )
        assertEquals(
            document(paragraph(text("stray")), table(
                    header = listOf(),
                    rows = listOf(listOf(cell(listOf(text("cell")), 1, null))),
                )),
            parseMarkdown("<table><tr>stray<td>cell</td></tr></table>"),
        )
    }

    @Test
    fun `keeps words apart in content that a table or a list passes through`() {
        assertEquals(
            document(paragraph(text("stray between")), table(
                    header = listOf(),
                    rows = listOf(listOf(cell(listOf(text("cell")), 1, null))),
                )),
            parseMarkdown("<table><tr>stray<td>cell</td></tr>between</table>"),
        )
        assertEquals(
            document(paragraph(text("one two")), list(start = null, loose = false,
                    item(paragraph(text("item"))),
                )),
            parseMarkdown("<ul>one<li>item</li>two</ul>"),
        )
    }

    @Test
    fun `closes an item, a cell, a row or a section that the next one implies`() {
        assertEquals(
            document(list(start = null, loose = false,
                    item(paragraph(text("one"))),
                    item(paragraph(text("two"))),
                )),
            parseMarkdown("<ul><li>one<li>two</ul>"),
        )
        assertEquals(
            document(table(
                    header = listOf(),
                    rows = listOf(listOf(cell(listOf(text("a")), 1, null), cell(listOf(text("b")), 1, null))),
                )),
            parseMarkdown("<table><tr><td>a<td>b</tr></table>"),
        )
        assertEquals(
            document(table(
                    header = listOf(),
                    rows = listOf(listOf(cell(listOf(text("a")), 1, null)), listOf(cell(listOf(text("b")), 1, null))),
                )),
            parseMarkdown("<table><tr><td>a<tr><td>b</table>"),
        )
        assertEquals(
            document(table(
                    header = listOf(cell(listOf(text("h")), 1, null)),
                    rows = listOf(listOf(cell(listOf(text("x")), 1, null))),
                )),
            parseMarkdown("<table><thead><tr><th>h<tbody><tr><td>x</table>"),
        )
    }

    @Test
    fun `does not close the item of an outer list for an item of a list inside it`() {
        assertEquals(
            document(list(start = null, loose = false,
                    item(paragraph(text("a")), list(start = null, loose = false,
                            item(paragraph(text("b"))),
                        )),
                    item(paragraph(text("c"))),
                )),
            parseMarkdown("<ul><li>a<ul><li>b</ul><li>c</ul>"),
        )
    }

    @Test
    fun `keeps the text of a part that has no parent`() {
        assertEquals(
            document(paragraph(text("solo"))),
            parseMarkdown("<li>solo</li>"),
        )
        assertEquals(
            document(paragraph(text("a b"))),
            parseMarkdown("<td>a</td><td>b</td>"),
        )
        assertEquals(
            document(paragraph(text("a b"))),
            parseMarkdown("<tr><td>a</td><td>b</td></tr>"),
        )
        assertEquals(
            document(paragraph(text("alone"))),
            parseMarkdown("<summary>alone</summary>"),
        )
    }

    @Test
    fun `keeps the text of a second summary in a details block`() {
        assertEquals(
            document(details(listOf(text("A")), paragraph(text("B body")))),
            parseMarkdown("<details><summary>A</summary><summary>B</summary>body</details>"),
        )
    }

    @Test
    fun `keeps white space between inline tags`() {
        assertEquals(
            document(paragraph(text("a b"))),
            parseMarkdown("a<b> </b>b"),
        )
        assertEquals(
            document(paragraph(strong(text("x")), text(" "), strong(text("y")))),
            parseMarkdown("<b>x</b><i> </i><b>y</b>"),
        )
    }

    @Test
    fun `draws no paragraph for an element that is empty`() {
        assertEquals(
            document(),
            parseMarkdown("<b></b>"),
        )
        assertEquals(
            document(paragraph(text("x")), paragraph(text("y"))),
            parseMarkdown("x\n\n<p></p>\n\ny"),
        )
    }

    @Test
    fun `flattens a link inside a link to its children`() {
        assertEquals(
            document(paragraph(link("/a", null, text("x "), strong(text("y"))))),
            parseMarkdown("<a href=\"/a\">[x](/b) <b>[y](/c)</b></a>"),
        )
    }

    // parseMarkdown embedded HTML spacing

    @Test
    fun `puts a space on both sides of a part that has no parent`() {
        assertEquals(
            document(paragraph(text("x c y"))),
            parseMarkdown("x<td>c</td>y"),
        )
        assertEquals(
            document(paragraph(text("see S"))),
            parseMarkdown("see<summary>S</summary>"),
        )
        assertEquals(
            document(paragraph(text("x c y"))),
            parseMarkdown("x <td>c</td> y"),
        )
    }

    @Test
    fun `holds no double space where text meets text across a dropped tag`() {
        assertEquals(
            document(paragraph(text("a b c"))),
            parseMarkdown("a <span> b</span> c"),
        )
        assertEquals(
            document(paragraph(text("a b"))),
            parseMarkdown("<div>a <span> b</span></div>"),
        )
    }

    @Test
    fun `keeps the spaces of preformatted text`() {
        assertEquals(
            document(code("a    b")),
            parseMarkdown("<pre>a  <span>  b</span></pre>"),
        )
    }

    @Test
    fun `keeps the indentation of highlighted code`() {
        assertEquals(
            document(code("x\n      return x;")),
            parseMarkdown("<pre><code>x\n<span>    </span><span>  return x;</span></code></pre>"),
        )
        assertEquals(
            document(code("a    b")),
            parseMarkdown("<pre><code>a  <span>  b</span></code></pre>"),
        )
    }

    @Test
    fun `keeps the spaces at the ends of preformatted text inside an element`() {
        assertEquals(
            document(code("x                                                  y")),
            parseMarkdown("<pre><p>x                                                  y</p></pre>"),
        )
        assertEquals(
            document(code("  x                                                  ")),
            parseMarkdown("<pre><b>  x                                                  </b></pre>"),
        )
    }

    @Test
    fun `reads a line break as a space in code and as a line break in preformatted text`() {
        assertEquals(
            document(paragraph(text("a "), inlineCode("x y"))),
            parseMarkdown("a <code>x<br>y</code>"),
        )
        assertEquals(
            document(code("x\ny")),
            parseMarkdown("<pre><code>x<br>y</code></pre>"),
        )
        assertEquals(
            document(code("x\ny\nz")),
            parseMarkdown("<pre>x<br>y\nz</pre>"),
        )
    }

    // parseMarkdown markup inside HTML code

    @Test
    fun `shows a footnote reference as written and numbers no footnote`() {
        assertEquals(
            document(paragraph(inlineCode("[^n]"))),
            parseMarkdown("<code>[^n]</code>\n\n[^n]: hi"),
        )
    }

    @Test
    fun `still numbers a footnote reference outside the code`() {
        assertEquals(
            MarkdownDocument(
                listOf(paragraph(inlineCode("[^n]"), text(" and "), reference(1))),
                listOf(footnote(1, paragraph(text("hi"), backReference(1)))),
            ),
            parseMarkdown("<code>[^n]</code> and [^n]\n\n[^n]: hi"),
        )
    }

    @Test
    fun `shows emphasis, links and escapes as written`() {
        assertEquals(
            document(paragraph(inlineCode("**x** [a](/b) \\* <https://e.com>"))),
            parseMarkdown("<code>**x** [a](/b) \\* <https://e.com></code>"),
        )
    }

    @Test
    fun `shows markdown blocks inside code as written`() {
        assertEquals(
            document(paragraph(inlineCode("[^n] **x**"))),
            parseMarkdown("<code>\n\n[^n]\n\n**x**\n\n</code>\n\n[^n]: hi"),
        )
    }

    @Test
    fun `follows the same nesting as the elements a stray end tag changes nothing`() {
        assertEquals(
            document(paragraph(inlineCode("[^n][^n]"))),
            parseMarkdown("<code>[^n]</pre>[^n]</code>\n\n[^n]: note"),
        )
    }

    @Test
    fun `follows the same nesting as the elements a parent's end tag closes the code`() {
        assertEquals(
            document(paragraph(inlineCode("x")), paragraph(strong(text("bold")))),
            parseMarkdown("<div><code>x</div>\n\n**bold**"),
        )
        assertEquals(
            document(paragraph(strong(inlineCode("x")), text(" "), strong(text("bold")))),
            parseMarkdown("<b><code>x</b> **bold**"),
        )
    }

    @Test
    fun `follows the same nesting as the elements a tag in dropped script content opens nothing`() {
        assertEquals(
            document(paragraph(strong(text("bold")))),
            parseMarkdown("<script>const s = \"<code>\";</script>\n\n**bold**"),
        )
    }

    @Test
    fun `decodes character references once in emphasis shown as written`() {
        assertEquals(
            document(paragraph(inlineCode("**&**"))),
            parseMarkdown("<code>**&amp;**</code>"),
        )
    }

    @Test
    fun `decodes character references once in a link shown as written`() {
        assertEquals(
            document(paragraph(inlineCode("[&](/x)"))),
            parseMarkdown("<code>[&amp;](/x)</code>"),
        )
    }

    @Test
    fun `decodes character references once in a block shown as written`() {
        assertEquals(
            document(paragraph(inlineCode("&"))),
            parseMarkdown("<code>\n\n&amp;\n\n</code>"),
        )
    }

    @Test
    fun `decodes character references once in a reference after a backslash shown as written`() {
        assertEquals(
            document(paragraph(inlineCode("\\&"))),
            parseMarkdown("<code>\\&amp;</code>"),
        )
    }

    @Test
    fun `decodes character references once in a numeric reference after a backslash shown as written`() {
        assertEquals(
            document(paragraph(inlineCode("\\&"))),
            parseMarkdown("<code>\\&#38;</code>"),
        )
    }

    @Test
    fun `decodes character references once in a doubled reference after a backslash shown as written`() {
        assertEquals(
            document(paragraph(inlineCode("\\&amp;"))),
            parseMarkdown("<code>\\&amp;amp;</code>"),
        )
    }

    @Test
    fun `decodes character references once in plain text shown as written`() {
        assertEquals(
            document(paragraph(inlineCode("&"))),
            parseMarkdown("<code>&amp;</code>"),
        )
    }

    @Test
    fun `decodes character references once in a reference to a reference shown as written`() {
        assertEquals(
            document(paragraph(inlineCode("**&amp;**"))),
            parseMarkdown("<code>**&amp;amp;**</code>"),
        )
    }

    @Test
    fun `decodes character references once in a numeric reference to a reference shown as written`() {
        assertEquals(
            document(paragraph(inlineCode("**&#38;**"))),
            parseMarkdown("<code>**&amp;#38;**</code>"),
        )
    }

    @Test
    fun `reads markdown again after the code ends`() {
        assertEquals(
            document(paragraph(inlineCode("**x**"), text(" "), strong(text("y")))),
            parseMarkdown("<code>**x**</code> **y**"),
        )
    }

    // parseMarkdown embedded HTML in a link

    @Test
    fun `flattens an HTML link inside a markdown link, so the outer link wins`() {
        assertEquals(
            document(paragraph(link("https://a", null, text("x")))),
            parseMarkdown("[<a href=\"https://b\">x</a>](https://a)"),
        )
        assertEquals(
            document(paragraph(link("https://a", null, strong(text("x"))))),
            parseMarkdown("[<b><a href=\"https://b\">x</a></b>](https://a)"),
        )
    }

    // parseMarkdown embedded HTML table size

    @Test
    fun `joins the cells past the column limit into the last cell, and stays fast`() {
        val html = "<table><tr>${"<td>x</td>".repeat(25_000)}</tr>${"<tr><td>y</td></tr>".repeat(12_000)}</table>"

        val started = System.nanoTime()
        val table = parseMarkdown(html).blocks.single() as MarkdownBlock.Table

        assertTrue((System.nanoTime() - started) / 1_000_000 < 2000)
        assertEquals(12_001, table.rows.size)
        assertEquals(emptyList(), table.header)
        assertEquals(64, table.rows[0].size)
        assertEquals(cell(listOf(text("x")), 1, null), table.rows[0][62])
        val lastCell = table.rows[0][63].children
        assertTrue(lastCell.all { it is MarkdownInline.Text })
        assertEquals(List(25_000 - 63) { "x" }.joinToString(" "), lastCell.joinToString("") { (it as MarkdownInline.Text).text })
        assertEquals(listOf(cell(listOf(text("y")), 1, null), cell(listOf(), 63, null)), table.rows[1])
    }

    // parseMarkdown angle brackets that are not HTML

    @Test
    fun `keeps a tag that mixes upper and lower case as text, as a component`() {
        assertEquals(
            document(paragraph(text("<Details> <Summary>S</Summary>")), paragraph(text("body")), paragraph(text("</Details>"))),
            parseMarkdown("<Details>\n<Summary>S</Summary>\n\nbody\n\n</Details>"),
        )
    }

    @Test
    fun `keeps a generic type and a component tag as the text written`() {
        assertEquals(
            document(paragraph(text("Use Array<string> or Promise<void> with <T> here"))),
            parseMarkdown("Use Array<string> or Promise<void> with <T> here"),
        )
        assertEquals(
            document(paragraph(text("<Button variant=\"primary\" />"))),
            parseMarkdown("<Button variant=\"primary\" />"),
        )
        assertEquals(
            document(paragraph(text("a <Button>click</Button> b <my-element>c</my-element>"))),
            parseMarkdown("a <Button>click</Button> b <my-element>c</my-element>"),
        )
    }

    @Test
    fun `keeps a tag that is not closed as text, however many there are`() {
        assertEquals(
            document(paragraph(text("Map<string, Array<T"))),
            parseMarkdown("Map<string, Array<T"),
        )
        val started = System.nanoTime()
        parseMarkdown("<Foo ".repeat(50_000))
        assertTrue((System.nanoTime() - started) / 1_000_000 < 2000)
    }

    @Test
    fun `still reads a standard element written in capitals`() {
        assertEquals(
            document(paragraph(strong(text("x")))),
            parseMarkdown("<STRONG>x</STRONG>"),
        )
    }

    // parseMarkdown character references next to a tag

    @Test
    fun `reads a tag after an ampersand as the tag and keeps no handler`() {
        assertEquals(
            document(paragraph(text("&"), MarkdownInline.Image("x", "", null), text("; and &a<b;"))),
            parseMarkdown("&<img src=x onerror=alert(1)>; and &a<b;"),
        )
    }

    // parseMarkdown embedded HTML cut off

    @Test
    fun `closes what is open when the text ends in the middle of a tag`() {
        assertEquals(
            document(details(listOf(text("Run")), table(
                        header = listOf(),
                        rows = listOf(listOf(cell(listOf(strong(text("half"))), 1, null)), listOf(cell(listOf(text("text")), 1, null))),
                    ))),
            parseMarkdown("<details><summary>Run</summary><table><tr><td><b>half</b></td></tr><tr><td>text <a href=\"https://exam"),
        )
    }

    @Test
    fun `drops a quoted attribute value that never closes, with its tag`() {
        assertEquals(
            document(paragraph(text("a"))),
            parseMarkdown("<div>a <img src=\"https://e.com/a.png alt=\"x"),
        )
    }

    @Test
    fun `stays shallow however deep the tags nest`() {
        fun depth(inlines: List<MarkdownInline>): Int = (inlines.firstOrNull() as? MarkdownInline.Strong)?.let { 1 + depth(it.children) } ?: 0
        val block = parseMarkdown("${"<b>".repeat(5000)}x").blocks.firstOrNull()

        assertTrue((if (block is MarkdownBlock.Paragraph) depth(block.children) else -1) < 100)
    }
}
