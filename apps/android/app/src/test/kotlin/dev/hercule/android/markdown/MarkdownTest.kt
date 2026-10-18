package dev.hercule.android.markdown

import kotlin.test.assertEquals
import org.junit.Test

/**
 * Tests [parseMarkdown], which turns the markdown in a message into the tree the app draws.
 *
 * The cases are copied one for one from packages/client-core/src/markdown.test.ts, in its order and under its names, each
 * with the tree that client-core builds for it.
 */
class MarkdownTest {
    // parseMarkdown blocks

    @Test
    fun `parses a paragraph`() {
        assertEquals(
            document(paragraph(text("Hello there."))),
            parseMarkdown("Hello there."),
        )
    }

    @Test
    fun `parses headings of every depth`() {
        assertEquals(
            document(heading(1, text("One")), heading(2, text("Two")), heading(3, text("Three")), heading(4, text("Four")), heading(5, text("Five")), heading(6, text("Six"))),
            parseMarkdown("# One\n\n## Two\n\n### Three\n\n#### Four\n\n##### Five\n\n###### Six"),
        )
    }

    @Test
    fun `parses a tight bulleted list`() {
        assertEquals(
            document(list(start = null, loose = false,
                    item(paragraph(text("a"))),
                    item(paragraph(text("b"))),
                )),
            parseMarkdown("- a\n- b"),
        )
    }

    @Test
    fun `starts a numbered list at its first number`() {
        assertEquals(
            document(list(start = 3, loose = false,
                    item(paragraph(text("a"))),
                    item(paragraph(text("b"))),
                )),
            parseMarkdown("3. a\n4. b"),
        )
    }

    @Test
    fun `keeps a list that starts at zero numbered`() {
        assertEquals(
            document(list(start = 0, loose = false,
                    item(paragraph(text("a"))),
                )),
            parseMarkdown("0. a"),
        )
    }

    @Test
    fun `marks a list loose when blank lines separate its items`() {
        assertEquals(
            document(list(start = null, loose = true,
                    item(paragraph(text("a"))),
                    item(paragraph(text("b"))),
                )),
            parseMarkdown("- a\n\n- b"),
        )
    }

    @Test
    fun `nests a list inside an item`() {
        assertEquals(
            document(list(start = null, loose = false,
                    item(paragraph(text("a")), list(start = 1, loose = false,
                            item(paragraph(text("b"))),
                        )),
                )),
            parseMarkdown("- a\n  1. b"),
        )
    }

    @Test
    fun `starts a task item with its checkbox, ticked or not`() {
        assertEquals(
            document(list(start = null, loose = false,
                    item(paragraph(MarkdownInline.Checkbox(true), text("done"))),
                    item(paragraph(MarkdownInline.Checkbox(false), text("open"))),
                )),
            parseMarkdown("- [x] done\n- [ ] open"),
        )
    }

    @Test
    fun `starts the first paragraph of a loose task item with its checkbox`() {
        assertEquals(
            document(list(start = null, loose = true,
                    item(paragraph(MarkdownInline.Checkbox(true), text("done"))),
                    item(paragraph(MarkdownInline.Checkbox(false), text("open")), paragraph(text("more"))),
                )),
            parseMarkdown("- [x] done\n\n- [ ] open\n\n  more"),
        )
    }

    @Test
    fun `keeps the blocks that follow the first paragraph of a task item`() {
        assertEquals(
            document(list(start = null, loose = false,
                    item(paragraph(MarkdownInline.Checkbox(false), text("a")), list(start = null, loose = false,
                            item(paragraph(text("b"))),
                        )),
                )),
            parseMarkdown("- [ ] a\n  - b"),
        )
    }

    @Test
    fun `leaves a box with no text after it as text`() {
        assertEquals(
            document(list(start = null, loose = false,
                    item(paragraph(text("[ ]"))),
                )),
            parseMarkdown("- [ ]"),
        )
    }

    @Test
    fun `parses a blockquote and the blocks inside it`() {
        assertEquals(
            document(blockquote(paragraph(text("quoted")), list(start = null, loose = false,
                        item(paragraph(text("item"))),
                    ))),
            parseMarkdown("> quoted\n>\n> - item"),
        )
    }

    @Test
    fun `parses a thematic break as a rule`() {
        assertEquals(
            document(paragraph(text("a")), MarkdownBlock.Rule, paragraph(text("b"))),
            parseMarkdown("a\n\n---\n\nb"),
        )
    }

    @Test
    fun `keeps the text of a fenced code block as written, with no decoding`() {
        assertEquals(
            document(code("const a = 1 &amp; 2;\n\nb();")),
            parseMarkdown("```ts\nconst a = 1 &amp; 2;\n\nb();\n```"),
        )
    }

    @Test
    fun `keeps the text of an indented code block as written, with no decoding`() {
        assertEquals(
            document(code("a &lt; b")),
            parseMarkdown("    a &lt; b"),
        )
    }

    @Test
    fun `ends an indented code block's text without the line break after its last line`() {
        assertEquals(
            document(code("a")),
            parseMarkdown("    a\n"),
        )
        assertEquals(
            document(code("a\n\n  b")),
            parseMarkdown("    a\n\n      b\n"),
        )
        assertEquals(
            document(code("a")),
            parseMarkdown("    a\n    \n"),
        )
        assertEquals(
            document(list(start = null, loose = true,
                    item(paragraph(text("a")), code("code")),
                )),
            parseMarkdown("- a\n\n      code\n"),
        )
    }

    @Test
    fun `keeps a blank last line of a fenced code block as part of its text`() {
        assertEquals(
            document(code("a")),
            parseMarkdown("```\na\n```\n"),
        )
        assertEquals(
            document(code("a\n")),
            parseMarkdown("```\na\n\n```"),
        )
        assertEquals(
            document(code("a")),
            parseMarkdown("<pre>a\n\n</pre>"),
        )
    }

    @Test
    fun `parses a table with the alignment of each column`() {
        assertEquals(
            document(table(
                    header = listOf(cell(listOf(text("a")), 1, ColumnAlignment.Left), cell(listOf(text("b")), 1, ColumnAlignment.Center), cell(listOf(text("c")), 1, ColumnAlignment.Right), cell(listOf(text("d")), 1, null)),
                    rows = listOf(listOf(cell(listOf(text("1")), 1, ColumnAlignment.Left), cell(listOf(text("2")), 1, ColumnAlignment.Center), cell(listOf(text("3")), 1, ColumnAlignment.Right), cell(listOf(strong(text("4"))), 1, null))),
                )),
            parseMarkdown("| a | b | c | d |\n|:--|:-:|--:|---|\n| 1 | 2 | 3 | **4** |"),
        )
    }

    // parseMarkdown inline elements

    @Test
    fun `parses a link`() {
        assertEquals(
            document(paragraph(link("https://example.com/a?b=1", null, text("docs")))),
            parseMarkdown("[docs](https://example.com/a?b=1)"),
        )
    }

    @Test
    fun `parses emphasis`() {
        assertEquals(
            document(paragraph(emphasis(text("a")))),
            parseMarkdown("*a*"),
        )
    }

    @Test
    fun `parses strong text`() {
        assertEquals(
            document(paragraph(strong(text("a")))),
            parseMarkdown("**a**"),
        )
    }

    @Test
    fun `parses strikethrough`() {
        assertEquals(
            document(paragraph(strikethrough(text("a")))),
            parseMarkdown("~~a~~"),
        )
    }

    @Test
    fun `parses inline code without decoding it`() {
        assertEquals(
            document(paragraph(inlineCode("a &amp; b"))),
            parseMarkdown("`a &amp; b`"),
        )
    }

    @Test
    fun `parses an image`() {
        assertEquals(
            document(paragraph(MarkdownInline.Image("/cat.png", "A small cat", null))),
            parseMarkdown("![A *small* cat](/cat.png)"),
        )
    }

    @Test
    fun `turns a bare URL into a link`() {
        assertEquals(
            document(paragraph(text("See "), link("https://example.com/a", null, text("https://example.com/a")), text(" and "), link("http://www.example.org", null, text("www.example.org")), text("."))),
            parseMarkdown("See https://example.com/a and www.example.org."),
        )
    }

    @Test
    fun `turns an angle-bracket URL and an email address into links`() {
        assertEquals(
            document(paragraph(link("https://example.com", null, text("https://example.com")), text(" "), link("mailto:me@example.com", null, text("me@example.com")))),
            parseMarkdown("<https://example.com> <me@example.com>"),
        )
    }

    // parseMarkdown line breaks

    @Test
    fun `joins two lines into one text when breaks is off`() {
        assertEquals(
            document(paragraph(text("one\ntwo"))),
            parseMarkdown("one\ntwo"),
        )
    }

    @Test
    fun `turns a single newline into a break when breaks is on`() {
        assertEquals(
            document(paragraph(text("one"), MarkdownInline.Break, text("two"))),
            parseMarkdown("one\ntwo", breaks = true),
        )
    }

    @Test
    fun `turns two trailing spaces into a break whether breaks is on or off`() {
        assertEquals(
            document(paragraph(text("one"), MarkdownInline.Break, text("two"))),
            parseMarkdown("one  \ntwo"),
        )
        assertEquals(
            document(paragraph(text("one"), MarkdownInline.Break, text("two"))),
            parseMarkdown("one  \ntwo", breaks = true),
        )
    }

    @Test
    fun `uses the breaks value of each call, not of an earlier one`() {
        assertEquals(
            document(paragraph(text("one"), MarkdownInline.Break, text("two"))),
            parseMarkdown("one\ntwo", breaks = true),
        )
        assertEquals(
            document(paragraph(text("one\ntwo"))),
            parseMarkdown("one\ntwo"),
        )
    }

    // parseMarkdown footnotes

    @Test
    fun `numbers footnotes by their first reference, not by their definition`() {
        assertEquals(
            MarkdownDocument(
                listOf(paragraph(text("a"), reference(1), text(" c"), reference(2))),
                listOf(footnote(1, paragraph(text("Bravo."), backReference(1))), footnote(2, paragraph(text("Alpha."), backReference(2)))),
            ),
            parseMarkdown("a[^b] c[^a]\n\n[^a]: Alpha.\n[^b]: Bravo."),
        )
    }

    @Test
    fun `marks only the first reference to a footnote as the first`() {
        assertEquals(
            MarkdownDocument(
                listOf(paragraph(text("a"), reference(1), text(" b"), reference(1, isFirstReference = false)), blockquote(paragraph(text("c"), reference(1, isFirstReference = false)))),
                listOf(footnote(1, paragraph(text("One."), backReference(1)))),
            ),
            parseMarkdown("a[^1] b[^1]\n\n> c[^1]\n\n[^1]: One."),
        )
    }

    @Test
    fun `leaves out a footnote that no reference names`() {
        assertEquals(
            MarkdownDocument(
                listOf(paragraph(text("a"), reference(1))),
                listOf(footnote(1, paragraph(text("Used."), backReference(1)))),
            ),
            parseMarkdown("a[^1]\n\n[^1]: Used.\n[^2]: Unused."),
        )
    }

    @Test
    fun `leaves out a chain of footnotes that no visible text starts`() {
        assertEquals(
            document(paragraph(text("text"))),
            parseMarkdown("text\n\n[^a]: A with [^b].\n[^b]: B."),
        )
    }

    @Test
    fun `keeps a reference to a missing footnote as text`() {
        assertEquals(
            document(paragraph(text("a[^nope]"))),
            parseMarkdown("a[^nope]"),
        )
    }

    @Test
    fun `matches a label without regard to case`() {
        assertEquals(
            MarkdownDocument(
                listOf(paragraph(text("a"), reference(1), text(" b"), reference(2))),
                listOf(footnote(1, paragraph(text("One."), backReference(1))), footnote(2, paragraph(text("Two."), backReference(2)))),
            ),
            parseMarkdown("a[^A] b[^xY]\n\n[^a]: One.\n[^Xy]: Two."),
        )
    }

    @Test
    fun `uses the first definition of a label`() {
        assertEquals(
            MarkdownDocument(
                listOf(paragraph(text("a"), reference(1))),
                listOf(footnote(1, paragraph(text("First."), backReference(1)))),
            ),
            parseMarkdown("a[^1]\n\n[^1]: First.\n[^1]: Second."),
        )
    }

    @Test
    fun `numbers a footnote that another footnote references after the footnotes already waiting`() {
        assertEquals(
            MarkdownDocument(
                listOf(paragraph(text("a"), reference(1), text(" b"), reference(2))),
                listOf(footnote(1, paragraph(text("A with "), reference(3), text("."), backReference(1))), footnote(2, paragraph(text("C."), backReference(2))), footnote(3, paragraph(text("B."), backReference(3)))),
            ),
            parseMarkdown("a[^a] b[^c]\n\n[^a]: A with [^b].\n[^b]: B.\n[^c]: C."),
        )
    }

    @Test
    fun `numbers a footnote that only a footnote references`() {
        assertEquals(
            MarkdownDocument(
                listOf(paragraph(text("x"), reference(1))),
                listOf(footnote(1, paragraph(text("A with "), reference(2), text("."), backReference(1))), footnote(2, paragraph(text("B."), backReference(2)))),
            ),
            parseMarkdown("[^a]: A with [^b].\n[^b]: B.\n\nx[^a]"),
        )
    }

    @Test
    fun `does not let a reference in an image's alt text take a number or mark a reference`() {
        assertEquals(
            MarkdownDocument(
                listOf(paragraph(MarkdownInline.Image("/i.png", "ab", null), text(" c"), reference(1))),
                listOf(footnote(1, paragraph(text("One."), backReference(1)))),
            ),
            parseMarkdown("![a[^1]b](/i.png) c[^1]\n\n[^1]: One."),
        )
    }

    @Test
    fun `parses a footnote that holds several blocks and puts the back reference in the last paragraph`() {
        assertEquals(
            MarkdownDocument(
                listOf(paragraph(text("a"), reference(1))),
                listOf(footnote(1, paragraph(text("First.")), paragraph(text("Second, with "), inlineCode("code"), text("."), backReference(1)))),
            ),
            parseMarkdown("a[^1]\n\n[^1]: First.\n\n    Second, with `code`."),
        )
    }

    @Test
    fun `puts the back reference in a new paragraph when the footnote does not end in one`() {
        assertEquals(
            MarkdownDocument(
                listOf(paragraph(text("a"), reference(1))),
                listOf(footnote(1, paragraph(text("Intro.")), code("code"), paragraph(backReference(1)))),
            ),
            parseMarkdown("a[^1]\n\n[^1]: Intro.\n\n    ```\n    code\n    ```"),
        )
    }

    @Test
    fun `numbers footnotes from 1 in every call`() {
        assertEquals(
            MarkdownDocument(
                listOf(paragraph(text("a"), reference(1))),
                listOf(footnote(1, paragraph(text("One."), backReference(1)))),
            ),
            parseMarkdown("a[^1]\n\n[^1]: One."),
        )
        assertEquals(
            MarkdownDocument(
                listOf(paragraph(text("b"), reference(1), text(" c"), reference(2))),
                listOf(footnote(1, paragraph(text("X."), backReference(1))), footnote(2, paragraph(text("Y."), backReference(2)))),
            ),
            parseMarkdown("b[^x] c[^y]\n\n[^x]: X.\n[^y]: Y."),
        )
        assertEquals(
            MarkdownDocument(
                listOf(paragraph(text("a"), reference(1))),
                listOf(footnote(1, paragraph(text("One."), backReference(1)))),
            ),
            parseMarkdown("a[^1]\n\n[^1]: One."),
        )
    }

    @Test
    fun `takes a footnote definition inside a quote as text`() {
        assertEquals(
            document(blockquote(paragraph(text("[^1]: One."))), paragraph(text("a[^1]"))),
            parseMarkdown("> [^1]: One.\n\na[^1]"),
        )
    }

    @Test
    fun `recognises a definition on the line right after a paragraph line`() {
        assertEquals(
            MarkdownDocument(
                listOf(paragraph(text("a"), reference(1))),
                listOf(footnote(1, paragraph(text("Note"), backReference(1)))),
            ),
            parseMarkdown("a[^a]\n[^a]: Note"),
        )
    }

    @Test
    fun `does not cut a paragraph at a bracket in the middle of a line`() {
        assertEquals(
            document(paragraph(text("a [^a]: not a definition"))),
            parseMarkdown("a [^a]: not a definition"),
        )
    }

    @Test
    fun `allows 1 to 3 spaces before a definition`() {
        assertEquals(
            MarkdownDocument(
                listOf(paragraph(reference(1))),
                listOf(footnote(1, paragraph(text("Note"), backReference(1)))),
            ),
            parseMarkdown("[^a]\n\n [^a]: Note"),
        )
        assertEquals(
            MarkdownDocument(
                listOf(paragraph(reference(1))),
                listOf(footnote(1, paragraph(text("Note"), backReference(1)))),
            ),
            parseMarkdown("[^a]\n\n   [^a]: Note"),
        )
    }

    @Test
    fun `does not take a definition indented by 4 spaces, which is code`() {
        assertEquals(
            document(paragraph(text("[^a]")), code("[^a]: Note")),
            parseMarkdown("[^a]\n\n    [^a]: Note"),
        )
    }

    @Test
    fun `keeps a line indented by a tab in the footnote`() {
        assertEquals(
            MarkdownDocument(
                listOf(paragraph(reference(1))),
                listOf(footnote(1, paragraph(text("first\nsecond")), paragraph(text("third"), backReference(1)))),
            ),
            parseMarkdown("[^a]\n\n[^a]: first\n\tsecond\n\n\tthird"),
        )
    }

    @Test
    fun `keeps a line without indentation in the footnote when it continues the first paragraph`() {
        assertEquals(
            MarkdownDocument(
                listOf(paragraph(reference(1))),
                listOf(footnote(1, paragraph(text("first\nlazy continuation"), backReference(1)))),
            ),
            parseMarkdown("[^a]\n\n[^a]: first\nlazy continuation"),
        )
    }

    @Test
    fun `continues a paragraph that an indented line extended with a line without indentation`() {
        assertEquals(
            MarkdownDocument(
                listOf(paragraph(reference(1))),
                listOf(footnote(1, paragraph(text("first\nsecond\nthird"), backReference(1)))),
            ),
            parseMarkdown("[^a]\n\n[^a]: first\n    second\nthird"),
        )
    }

    @Test
    fun `keeps a heading-like word without a space in the footnote`() {
        assertEquals(
            MarkdownDocument(
                listOf(paragraph(reference(1))),
                listOf(footnote(1, paragraph(text("note\n#hashtag"), backReference(1)))),
            ),
            parseMarkdown("[^a]\n\n[^a]: note\n#hashtag"),
        )
    }

    @Test
    fun `shows a line without indentation after a code fence in a footnote`() {
        assertEquals(
            document(paragraph(text("IMPORTANT"))),
            parseMarkdown("[^unused]: ```\n    example\nIMPORTANT"),
        )
    }

    @Test
    fun `shows a line without indentation after HTML in a footnote`() {
        assertEquals(
            document(paragraph(text("IMPORTANT"))),
            parseMarkdown("[^unused]: note\n    <div>\nIMPORTANT"),
        )
    }

    @Test
    fun `shows a line without indentation after indented code after a blank line in a footnote`() {
        assertEquals(
            document(paragraph(text("IMPORTANT"))),
            parseMarkdown("[^unused]: note\n\n        code\nIMPORTANT"),
        )
    }

    @Test
    fun `shows a line without indentation after a heading underline in a footnote`() {
        assertEquals(
            document(paragraph(text("IMPORTANT"))),
            parseMarkdown("[^unused]: note\n    ===\nIMPORTANT"),
        )
    }

    @Test
    fun `shows a line without indentation after a table in a footnote`() {
        assertEquals(
            document(paragraph(text("IMPORTANT"))),
            parseMarkdown("[^unused]: a | b\n    --- | ---\nIMPORTANT"),
        )
    }

    @Test
    fun `continues a later paragraph of the footnote with a line without indentation`() {
        assertEquals(
            MarkdownDocument(
                listOf(paragraph(reference(1))),
                listOf(footnote(1, paragraph(text("first")), paragraph(text("second,\ncontinued"), backReference(1)))),
            ),
            parseMarkdown("[^a]\n\n[^a]: first\n\n    second,\ncontinued"),
        )
    }

    @Test
    fun `keeps ^note 1 IMPORTANT WARNING as text, because a footnote label holds no whitespace`() {
        assertEquals(
            document(paragraph(text("[^note 1]: IMPORTANT WARNING"))),
            parseMarkdown("[^note 1]: IMPORTANT WARNING"),
        )
    }

    @Test
    fun `keeps ^ IMPORTANT WARNING as text, because a footnote label holds no whitespace`() {
        assertEquals(
            document(paragraph(text("[^ ]: IMPORTANT WARNING"))),
            parseMarkdown("[^ ]: IMPORTANT WARNING"),
        )
    }

    @Test
    fun `keeps ^a tb IMPORTANT WARNING as text, because a footnote label holds no whitespace`() {
        assertEquals(
            document(paragraph(text("[^a\tb]: IMPORTANT WARNING"))),
            parseMarkdown("[^a\tb]: IMPORTANT WARNING"),
        )
    }

    @Test
    fun `keeps a definition whose closing bracket is escaped as text`() {
        assertEquals(
            document(paragraph(text("[^a]: note\nIMPORTANT WARNING"))),
            parseMarkdown("[^a\\]: note\nIMPORTANT WARNING"),
        )
    }

    @Test
    fun `ends a footnote at a definition whose label holds an escaped bracket`() {
        assertEquals(
            MarkdownDocument(
                listOf(paragraph(text("See "), reference(1), text("."))),
                listOf(footnote(1, paragraph(text("IMPORTANT WARNING"), backReference(1)))),
            ),
            parseMarkdown("See [^a\\]b].\n\n[^unused]: note\n[^a\\]b]: IMPORTANT WARNING"),
        )
    }

    @Test
    fun `keeps a definition whose label is longer than 999 characters of source as text`() {
        val source = "[^${"a".repeat(998)}\\*]: IMPORTANT WARNING"
        val blocks = parseMarkdown(source).blocks
        assertEquals(document(paragraph(text("[^${"a".repeat(998)}*]: IMPORTANT WARNING"))).blocks, blocks)
    }

    @Test
    fun `keeps a link definition whose label starts with a caret but is not a footnote label`() {
        assertEquals(
            document(paragraph(link("https://example.com", null, text("use")))),
            parseMarkdown("[use][^a b]\n\n[^a b]: https://example.com"),
        )
    }

    @Test
    fun `ends the footnote at a blank line followed by a line without indentation`() {
        assertEquals(
            MarkdownDocument(
                listOf(paragraph(reference(1)), paragraph(text("after"))),
                listOf(footnote(1, paragraph(text("first"), backReference(1)))),
            ),
            parseMarkdown("[^a]\n\n[^a]: first\n\nafter"),
        )
    }

    @Test
    fun `ends the footnote at a heading, which is part of the body`() {
        assertEquals(
            MarkdownDocument(
                listOf(paragraph(reference(1)), heading(1, text("Heading"))),
                listOf(footnote(1, paragraph(text("note"), backReference(1)))),
            ),
            parseMarkdown("[^a]\n\n[^a]: note\n# Heading"),
        )
    }

    @Test
    fun `ends the footnote at a list, which is part of the body`() {
        assertEquals(
            MarkdownDocument(
                listOf(paragraph(reference(1)), list(start = null, loose = false,
                    item(paragraph(text("item"))),
                ), list(start = 2, loose = false,
                    item(paragraph(text("other"))),
                )),
                listOf(footnote(1, paragraph(text("note"), backReference(1)))),
            ),
            parseMarkdown("[^a]\n\n[^a]: note\n- item\n2) other"),
        )
    }

    @Test
    fun `does not continue a footnote whose first line is empty with a line without indentation`() {
        assertEquals(
            MarkdownDocument(
                listOf(paragraph(reference(1)), paragraph(text("body"))),
                listOf(footnote(1, paragraph(backReference(1)))),
            ),
            parseMarkdown("[^a]\n\n[^a]:\nbody"),
        )
    }

    @Test
    fun `keeps a link whose text looks like an undefined footnote reference`() {
        assertEquals(
            document(paragraph(link("https://e.com", null, text("^x")))),
            parseMarkdown("[^x](https://e.com)"),
        )
    }

    @Test
    fun `reads character references and escapes in an undefined footnote reference`() {
        assertEquals(
            document(paragraph(text("[^a&b]"))),
            parseMarkdown("[^a&amp;b]"),
        )
        assertEquals(
            document(paragraph(text("[^a*]"))),
            parseMarkdown("[^a\\*]"),
        )
    }

    @Test
    fun `knows a definition that comes after a reference inside a footnote and a list`() {
        assertEquals(
            MarkdownDocument(
                listOf(list(start = null, loose = false,
                    item(paragraph(text("x"), reference(1))),
                )),
                listOf(footnote(1, paragraph(text("A with "), reference(2), text("."), backReference(1))), footnote(2, paragraph(text("B."), backReference(2)))),
            ),
            parseMarkdown("- x[^a]\n\n[^a]: A with [^b].\n[^b]: B."),
        )
    }

    // parseMarkdown texts side by side

    @Test
    fun `joins the texts that escapes and brackets split, at every depth`() {
        assertEquals(
            document(paragraph(text("a*b "), strong(text("c*d "), link("/g", null, text("e*f"))), text(" "), strikethrough(text("h]i")))),
            parseMarkdown("a\\*b **c\\*d [e\\*f](/g)** ~~h\\]i~~"),
        )
    }

    @Test
    fun `joins texts in a table cell, a details summary and a footnote`() {
        assertEquals(
            MarkdownDocument(
                listOf(table(
                    header = listOf(cell(listOf(text("a*b")), 1, null)),
                    rows = listOf(listOf(cell(listOf(text("c*d")), 1, null))),
                ), details(listOf(text("ef")), paragraph(text("g"))), paragraph(text("x"), reference(1))),
                listOf(footnote(1, paragraph(text("h*i"), backReference(1)))),
            ),
            parseMarkdown("| a\\*b |\n|---|\n| c\\*d |\n\n<details><summary>e<span>f</span></summary>\n\ng\n\n</details>\n\nx[^1]\n\n[^1]: h\\*i"),
        )
    }

    @Test
    fun `does not join texts across a break, inline code or a footnote reference`() {
        assertEquals(
            MarkdownDocument(
                listOf(paragraph(text("a*"), MarkdownInline.Break, text("b"), inlineCode("c"), text("d"), reference(1), text("e"))),
                listOf(footnote(1, paragraph(text("f"), backReference(1)))),
            ),
            parseMarkdown("a\\*  \nb`c`d[^1]e\n\n[^1]: f"),
        )
    }

    // parseMarkdown with embeddedHtml off

    @Test
    fun `shows a block of HTML as the text of a paragraph`() {
        assertEquals(
            document(paragraph(text("<form><input type=password></form>")), paragraph(text("after"))),
            parseMarkdown("<form><input type=password></form>\n\nafter", embeddedHtml = false),
        )
    }

    @Test
    fun `shows HTML inside a line as text, without decoding it`() {
        assertEquals(
            document(paragraph(text("a <b title=\"&amp;\">bold</b> c"))),
            parseMarkdown("a <b title=\"&amp;\">bold</b> c", embeddedHtml = false),
        )
    }

    // parseMarkdown addresses

    @Test
    fun `keeps the text of a javascript link and drops the link`() {
        assertEquals(
            document(paragraph(text("x"))),
            parseMarkdown("[x](javascript:alert(1))"),
        )
    }

    @Test
    fun `refuses a scheme in capitals`() {
        assertEquals(
            document(paragraph(text("x"))),
            parseMarkdown("[x](JAVASCRIPT:alert(1))"),
        )
    }

    @Test
    fun `refuses a scheme written with a character reference`() {
        assertEquals(
            document(paragraph(text("x"))),
            parseMarkdown("[x](javascript&#58;alert(1))"),
        )
        assertEquals(
            document(paragraph(text("x"))),
            parseMarkdown("[x](&#x6A;avascript:alert(1))"),
        )
    }

    @Test
    fun `refuses a data link and keeps the formatting of its text`() {
        assertEquals(
            document(paragraph(strong(text("x")))),
            parseMarkdown("[**x**](data:text/html,hi)"),
        )
    }

    @Test
    fun `keeps relative, hash, query and allowed-scheme addresses`() {
        assertEquals(
            document(paragraph(link("/docs/a:b", null, text("a")), text(" "), link("#top", null, text("b")), text(" "), link("?q=a:b", null, text("c")), text(" "), link("mailto:me@example.com", null, text("d")), text(" "), link("HTTP://example.com", null, text("e")))),
            parseMarkdown("[a](/docs/a:b) [b](#top) [c](?q=a:b) [d](mailto:me@example.com) [e](HTTP://example.com)"),
        )
    }

    @Test
    fun `keeps a title on a link and an image, with its references decoded`() {
        assertEquals(
            document(paragraph(link("/a", "T & \" x", text("a")), text(" "), MarkdownInline.Image("/b.png", "b", "tt"))),
            parseMarkdown("[a](/a \"T &amp; \\\" x\") ![b](/b.png 'tt')"),
        )
    }

    @Test
    fun `takes the title of a link from its definition`() {
        assertEquals(
            document(paragraph(link("/a", "Title", text("a")))),
            parseMarkdown("[a][r]\n\n[r]: /a \"Title\""),
        )
    }

    @Test
    fun `keeps the ampersands of an autolink as written`() {
        assertEquals(
            document(paragraph(link("https://e.com/?a=1&amp;b=2", null, text("https://e.com/?a=1&amp;b=2")), text(" "), link("https://e.com/?c=1&amp;d", null, text("https://e.com/?c=1&amp;d")))),
            parseMarkdown("<https://e.com/?a=1&amp;b=2> https://e.com/?c=1&amp;d"),
        )
    }

    @Test
    fun `percent-encodes the address in x ( https example com a b )`() {
        assertEquals(
            document(paragraph(link("https://example.com/a%5Cb", null, text("x")))),
            parseMarkdown("[x](<https://example.com/a\\b>)"),
        )
    }

    @Test
    fun `percent-encodes the address in x (https e com a&#10 b)`() {
        assertEquals(
            document(paragraph(link("https://e.com/a%0Ab", null, text("x")))),
            parseMarkdown("[x](https://e.com/a&#10;b)"),
        )
    }

    @Test
    fun `percent-encodes the address in x (https e com caf C3 A9)`() {
        assertEquals(
            document(paragraph(link("https://e.com/caf%C3%A9", null, text("x")))),
            parseMarkdown("[x](https://e.com/caf%C3%A9)"),
        )
    }

    @Test
    fun `percent-encodes the address in x (https e com café)`() {
        assertEquals(
            document(paragraph(link("https://e.com/caf%C3%A9", null, text("x")))),
            parseMarkdown("[x](https://e.com/café)"),
        )
    }

    @Test
    fun `percent-encodes the address in x ( https e com a b )`() {
        assertEquals(
            document(paragraph(link("https://e.com/a%20b", null, text("x")))),
            parseMarkdown("[x](<https://e.com/a b>)"),
        )
    }

    @Test
    fun `percent-encodes the address in x (https e com 100 )`() {
        assertEquals(
            document(paragraph(link("https://e.com/100%25", null, text("x")))),
            parseMarkdown("[x](https://e.com/100%)"),
        )
    }

    @Test
    fun `percent-encodes the address in x (https e com zz 4)`() {
        assertEquals(
            document(paragraph(link("https://e.com/%zz%254", null, text("x")))),
            parseMarkdown("[x](https://e.com/%zz%4)"),
        )
    }

    @Test
    fun `percent-encodes the address in x (https e com &#x1F600 )`() {
        assertEquals(
            document(paragraph(link("https://e.com/%F0%9F%98%80", null, text("x")))),
            parseMarkdown("[x](https://e.com/&#x1F600;)"),
        )
    }

    @Test
    fun `percent-encodes the address in x (https e com a&#xD800 b)`() {
        assertEquals(
            document(paragraph(link("https://e.com/a%EF%BF%BDb", null, text("x")))),
            parseMarkdown("[x](https://e.com/a&#xD800;b)"),
        )
    }

    @Test
    fun `percent-encodes the address in x (https e com q=a b&r=(c)#d)`() {
        assertEquals(
            document(paragraph(link("https://e.com/?q=a:b&r=(c)#d", null, text("x")))),
            parseMarkdown("[x](https://e.com/?q=a:b&r=(c)#d)"),
        )
    }

    @Test
    fun `percent-encodes the address of an image and of an autolink`() {
        assertEquals(
            document(paragraph(MarkdownInline.Image("/a%20b.png", "a", null), text(" "), link("https://e.com/%5Cx", null, text("https://e.com/\\x")))),
            parseMarkdown("![a](</a b.png>) <https://e.com/\\x>"),
        )
    }

    @Test
    fun `encodes a lone surrogate in an address, as a replacement character`() {
        assertEquals(
            document(paragraph(link("/a%EF%BF%BDb", null, text("x")))),
            parseMarkdown("[x](/a\uD800b)"),
        )
    }

    @Test
    fun `checks the scheme after the address is normalized`() {
        assertEquals(
            document(paragraph(text("x"))),
            parseMarkdown("[x](java&#9;script:alert(1))"),
        )
    }

    @Test
    fun `replaces an image with an unsafe address by its alt text`() {
        assertEquals(
            document(paragraph(text("a cat"))),
            parseMarkdown("![a cat](javascript:alert(1))"),
        )
    }

    @Test
    fun `drops an image with an unsafe address and no alt text`() {
        assertEquals(
            document(paragraph(text("ab"))),
            parseMarkdown("a![](javascript:alert(1))b"),
        )
    }

    // parseMarkdown character references

    @Test
    fun `decodes named and numeric references in text`() {
        assertEquals(
            document(paragraph(text("AT&T © # # A"))),
            parseMarkdown("AT&amp;T &copy; &#35; &#x23; &#X41;"),
        )
    }

    @Test
    fun `keeps a name that is not a character reference as written`() {
        assertEquals(
            document(paragraph(text("&foo; &amp &#; &#xZZ;"))),
            parseMarkdown("&foo; &amp &#; &#xZZ;"),
        )
    }

    @Test
    fun `replaces a number that is no character by the replacement character`() {
        assertEquals(
            document(paragraph(text("� � �"))),
            parseMarkdown("&#0; &#xD800; &#1114112;"),
        )
    }

    @Test
    fun `replaces control characters written as numbers by the replacement character`() {
        assertEquals(
            document(paragraph(text("� � � � � � � \t"))),
            parseMarkdown("&#128; &#x9f; &#8; &#127; &#xFDD0; &#xFFFE; &#x1FFFF; &#9;"),
        )
    }

    @Test
    fun `decodes a reference once`() {
        assertEquals(
            document(paragraph(text("&#35; &amp;"))),
            parseMarkdown("&#38;#35; &amp;amp;"),
        )
    }

    @Test
    fun `shows a reference shaped like markup as the text it is`() {
        assertEquals(
            document(paragraph(text("&<img src=x onerror=alert(1)>; and &a<b;"))),
            parseMarkdown("&<img src=x onerror=alert(1)>; and &a<b;", embeddedHtml = false),
        )
    }

    @Test
    fun `decodes references in a heading, a table cell and a link's text`() {
        assertEquals(
            document(heading(1, text("a < b")), table(
                    header = listOf(cell(listOf(text("x")), 1, null)),
                    rows = listOf(listOf(cell(listOf(text(">")), 1, null))),
                ), paragraph(link("/a", null, text("&")))),
            parseMarkdown("# a &lt; b\n\n| x |\n|---|\n| &gt; |\n\n[&amp;](/a)"),
        )
    }

    @Test
    fun `decodes references in a link address and an image's address and alt text`() {
        assertEquals(
            document(paragraph(link("/?x=1&y=2", null, text("a")), text(" "), MarkdownInline.Image("/i.png?x=1&y=2", "<b>", null))),
            parseMarkdown("[a](/?x=1&amp;y=2) ![&lt;b&gt;](/i.png?x=1&amp;y=2)"),
        )
    }

    @Test
    fun `does not decode a reference whose ampersand is escaped`() {
        assertEquals(
            document(paragraph(text("&amp;"))),
            parseMarkdown("\\&amp;"),
        )
    }

    // parseMarkdown deep nesting
    // client-core's parseMarkdown throws a RangeError on these, and its callers show the raw text.
    // The port returns that raw text itself.

    @Test
    fun `throws a RangeError when quotes nest deeper than the stack allows`() {
        val source = "${">".repeat(50_000)} x"
        assertEquals(showAsWritten(source), parseMarkdown(source))
    }

    @Test
    fun `parses footnotes correctly after a call that threw`() {
        val source = "${">".repeat(50_000)} x"
        assertEquals(showAsWritten(source), parseMarkdown(source))
        assertEquals(
            MarkdownDocument(
                listOf(paragraph(text("a"), reference(1))),
                listOf(footnote(1, paragraph(text("One."), backReference(1)))),
            ),
            parseMarkdown("a[^1]\n\n[^1]: One."),
        )
    }
}
