/**
 * Tests the HTML that `parseMarkdown` reads inside markdown. Each test gives
 * the markdown or HTML a GitHub comment can hold and the whole tree it parses
 * to.
 */
import { describe, expect, it } from "vitest";
import {
  parseMarkdown,
  type ColumnAlignment,
  type MarkdownBlock,
  type MarkdownInline,
  type MarkdownTableCell,
} from "./markdown";

const text = (value: string): MarkdownInline => ({ type: "text", text: value });

const paragraph = (...children: MarkdownInline[]): MarkdownBlock => ({
  type: "paragraph",
  children,
});

const cell = (
  children: MarkdownInline[],
  columnSpan = 1,
  align: ColumnAlignment = undefined,
): MarkdownTableCell => ({ children, columnSpan, align });

const strong = (...children: MarkdownInline[]): MarkdownInline => ({ type: "strong", children });

const link = (href: string, ...children: MarkdownInline[]): MarkdownInline => ({
  type: "link",
  href,
  title: undefined,
  children,
});

/** The tree of a document with these blocks and no footnotes. */
const blocks = (...expected: MarkdownBlock[]) => ({ blocks: expected, footnotes: [] });

describe("parseMarkdown embedded HTML in a bot comment", () => {
  it("parses a Cypress comment: empty rows, a header cell across two columns, images, code and a footer", () => {
    const runUrl = "https://cloud.cypress.io/projects/hb1gva/runs/27699";
    const comment = [
      `<h3><a href="${runUrl}">Cypress run 27699</a></h3>`,
      "<table>",
      "  <thead>",
      "    <tr />",
      '    <tr height="48">',
      '      <th colspan="2" align="left" width="744">Test results</th>',
      "    </tr />",
      "  </thead>",
      "  <tbody>",
      "    <tr />",
      "    <tr>",
      '      <td width="224"><picture><img src="https://assets.cypress.io/github-pr-comment-icons/failed.svg" alt="Tests that failed" width="10" height="10" /></picture>&nbsp; <a href="https://cloud.cypress.io/projects/hb1gva/runs/27699/overview?reviewViewBy=FAILED&utm_source=github"><strong>Failures</strong></a></td>',
      "      <td><code><strong>0</strong></code></td>",
      "    </tr>",
      "  </tbody>",
      "  <tfoot>",
      '    <tr height="48">',
      `      <td colspan="2"><a href="${runUrl}">View all changes introduced in this branch ↗︎</a></td>`,
      "    </tr>",
      "  </tfoot>",
      "</table>",
    ].join("\n");

    expect(parseMarkdown(comment)).toEqual(
      blocks(
        { type: "heading", depth: 3, children: [link(runUrl, text("Cypress run 27699"))] },
        {
          type: "table",
          header: [cell([text("Test results")], 2, "left")],
          rows: [
            [
              cell(
                [
                  {
                    type: "image",
                    src: "https://assets.cypress.io/github-pr-comment-icons/failed.svg",
                    alt: "Tests that failed",
                    title: undefined,
                    width: 10,
                    height: 10,
                  },
                  text("  "),
                  link(
                    `${runUrl}/overview?reviewViewBy=FAILED&utm_source=github`,
                    strong(text("Failures")),
                  ),
                ],
                1,
                "left",
              ),
              cell([{ type: "inlineCode", text: "0" }], 1, "left"),
            ],
            [cell([link(runUrl, text("View all changes introduced in this branch ↗︎"))], 2, "left")],
          ],
        },
      ),
    );
  });

  it("parses a Renovate details block that holds markdown between its tags", () => {
    const comment = [
      "<details>",
      "<summary>renovatebot/renovate (renovate)</summary>",
      "",
      "### v1.2.3",
      "",
      "- fix: a **thing**",
      "",
      "</details>",
      "",
      "After.",
    ].join("\n");

    expect(parseMarkdown(comment)).toEqual(
      blocks(
        {
          type: "details",
          summary: [text("renovatebot/renovate (renovate)")],
          children: [
            { type: "heading", depth: 3, children: [text("v1.2.3")] },
            {
              type: "list",
              start: undefined,
              loose: false,
              items: [{ children: [paragraph(text("fix: a "), strong(text("thing")))] }],
            },
          ],
        },
        paragraph(text("After.")),
      ),
    );
  });

  it("nests one details block in another, and gives a missing summary a name", () => {
    expect(
      parseMarkdown(
        "<details>\n<summary>Outer</summary>\n\n<details>\n\ninner text\n\n</details>\n\n</details>",
      ),
    ).toEqual(
      blocks({
        type: "details",
        summary: [text("Outer")],
        children: [
          {
            type: "details",
            summary: [text("Details")],
            children: [paragraph(text("inner text"))],
          },
        ],
      }),
    );
  });
});

describe("parseMarkdown embedded HTML inside a line", () => {
  it("wraps the text between an open tag and its close tag", () => {
    expect(
      parseMarkdown("a <strong>b</strong> c <em>d</em> <del>e</del> <b>f</b> <i>g</i>"),
    ).toEqual(
      blocks(
        paragraph(
          text("a "),
          strong(text("b")),
          text(" c "),
          { type: "emphasis", children: [text("d")] },
          text(" "),
          { type: "strikethrough", children: [text("e")] },
          text(" "),
          strong(text("f")),
          text(" "),
          { type: "emphasis", children: [text("g")] },
        ),
      ),
    );
  });

  it("wraps markdown that sits between the tags", () => {
    expect(parseMarkdown("<b>a **b** [c](/c)</b>")).toEqual(
      blocks(paragraph(strong(text("a "), strong(text("b")), text(" "), link("/c", text("c"))))),
    );
  });

  it("parses a break, a link with a title, and an image with unquoted attributes", () => {
    expect(
      parseMarkdown(
        'one<br>two<br/>three <a href="https://e.com/?a=1&amp;b=2" title="x &amp; y">l</a> <img src=https://e.com/a.png alt=pic width=10 height=20 hidden>',
      ),
    ).toEqual(
      blocks(
        paragraph(
          text("one"),
          { type: "break" },
          text("two"),
          { type: "break" },
          text("three "),
          {
            type: "link",
            href: "https://e.com/?a=1&b=2",
            title: "x & y",
            children: [text("l")],
          },
          text(" "),
          {
            type: "image",
            src: "https://e.com/a.png",
            alt: "pic",
            title: undefined,
            width: 10,
            height: 20,
          },
        ),
      ),
    );
  });

  it("reads tag and attribute names in any case", () => {
    expect(parseMarkdown('<A HREF="/x">y</A> <STRONG>z</STRONG>')).toEqual(
      blocks(paragraph(link("/x", text("y")), text(" "), strong(text("z")))),
    );
  });

  it("ignores a close tag that nothing opened, and closes an open tag at the end", () => {
    expect(parseMarkdown("a</b> b <strong>c")).toEqual(
      blocks(paragraph(text("a b "), strong(text("c")))),
    );
  });

  it("keeps a less-than sign that does not start a tag as text", () => {
    expect(parseMarkdown("1 < 2 and 3 <4")).toEqual(blocks(paragraph(text("1 < 2 and 3 <4"))));
  });
});

describe("parseMarkdown embedded HTML blocks", () => {
  it("numbers an ordered list from 1 when it gives no number, and keeps a given number", () => {
    const numbered = (start: number | undefined): MarkdownBlock => ({
      type: "list",
      start,
      loose: false,
      items: [{ children: [paragraph(text("a"))] }],
    });

    expect(parseMarkdown("<ol><li>a</li></ol>")).toEqual(blocks(numbered(1)));
    expect(parseMarkdown('<ol start="oops"><li>a</li></ol>')).toEqual(blocks(numbered(1)));
    expect(parseMarkdown('<ol start="0"><li>a</li></ol>')).toEqual(blocks(numbered(0)));
    expect(parseMarkdown('<ol start="-3"><li>a</li></ol>')).toEqual(blocks(numbered(-3)));
    expect(parseMarkdown('<ul start="5"><li>a</li></ul>')).toEqual(blocks(numbered(undefined)));
  });

  it("parses paragraphs, headings, a quote, a rule, lists and preformatted text", () => {
    const html = [
      "<h2>Title</h2>",
      "<p>First <b>line</b></p>",
      "<blockquote><p>quoted</p></blockquote>",
      "<hr>",
      '<ol start="3"><li>three</li><li>four</li></ol>',
      "<ul><li>a</li></ul>",
      "<pre><code>x &lt; y\n  z</code></pre>",
    ].join("\n");

    expect(parseMarkdown(html)).toEqual(
      blocks(
        { type: "heading", depth: 2, children: [text("Title")] },
        paragraph(text("First "), strong(text("line"))),
        { type: "blockquote", children: [paragraph(text("quoted"))] },
        { type: "rule" },
        {
          type: "list",
          start: 3,
          loose: false,
          items: [
            { children: [paragraph(text("three"))] },
            { children: [paragraph(text("four"))] },
          ],
        },
        {
          type: "list",
          start: undefined,
          loose: false,
          items: [{ children: [paragraph(text("a"))] }],
        },
        { type: "code", text: "x < y\n  z" },
      ),
    );
  });

  it("makes each div its own paragraph and collapses the white space between words", () => {
    expect(parseMarkdown("<div>one\n   two</div><div>three</div>")).toEqual(
      blocks(paragraph(text("one two")), paragraph(text("three"))),
    );
  });
});

describe("parseMarkdown embedded HTML tables", () => {
  it("uses the first row as the header when all its cells are th, and pads short rows", () => {
    expect(
      parseMarkdown(
        '<table><tr><th align="center">A</th><th>B</th><th>C</th></tr><tr><td>1</td></tr><tr><td colspan="2">2</td><td>x</td></tr></table>',
      ),
    ).toEqual(
      blocks({
        type: "table",
        header: [cell([text("A")], 1, "center"), cell([text("B")]), cell([text("C")])],
        rows: [
          [cell([text("1")], 1, "center"), cell([], 2)],
          [cell([text("2")], 2, "center"), cell([text("x")])],
        ],
      }),
    );
  });

  it("covers columns with a colspan and pads a short row by the columns it covers", () => {
    expect(
      parseMarkdown(
        '<table><tr><th>A</th><th>B</th><th>C</th></tr><tr><td colspan="2">ab</td></tr><tr><td colspan="2">xy</td><td>z</td></tr></table>',
      ),
    ).toEqual(
      blocks({
        type: "table",
        header: [cell([text("A")]), cell([text("B")]), cell([text("C")])],
        rows: [
          [cell([text("ab")], 2), cell([])],
          [cell([text("xy")], 2), cell([text("z")])],
        ],
      }),
    );
  });

  it("widens the table to the row that covers the most columns", () => {
    expect(
      parseMarkdown('<table><tr><td>a</td></tr><tr><td colspan="3">b</td></tr></table>'),
    ).toEqual(
      blocks({
        type: "table",
        header: [],
        rows: [[cell([text("a")]), cell([], 2)], [cell([text("b")], 3)]],
      }),
    );
  });

  it("reads a colspan that is not a whole number above zero as one column", () => {
    expect(
      parseMarkdown(
        '<table><tr><td colspan="0">a</td><td colspan="-2">b</td><td colspan="two">c</td><td colspan="1.5">d</td></tr></table>',
      ),
    ).toEqual(
      blocks({
        type: "table",
        header: [],
        rows: [[cell([text("a")]), cell([text("b")]), cell([text("c")]), cell([text("d")])]],
      }),
    );
  });

  it("cuts a colspan that reaches past the column limit, and joins the cells after it", () => {
    const [table] = parseMarkdown(
      `<table><tr><td>a</td><td colspan="500">b</td><td>c</td></tr><tr><td colspan="99999">d</td></tr></table>`,
    ).blocks;

    expect(table).toEqual({
      type: "table",
      header: [],
      rows: [
        [cell([text("a")]), cell([text("b"), text(" "), text("c")], 63)],
        [cell([text("d")], 64)],
      ],
    });
  });

  it("leaves the header empty for a table of td cells only", () => {
    expect(parseMarkdown("<table><tr><td>a</td><td>b</td></tr></table>")).toEqual(
      blocks({
        type: "table",
        header: [],
        rows: [[cell([text("a")]), cell([text("b")])]],
      }),
    );
  });

  it("flattens block content in a cell, such as markdown between blank lines, to inlines", () => {
    const html =
      "<table>\n<tr>\n<td>\n\n**a**\n\nb\n\n</td>\n<td><p>c</p><p>d</p></td>\n</tr>\n</table>";

    expect(parseMarkdown(html)).toEqual(
      blocks({
        type: "table",
        header: [],
        rows: [
          [
            cell([strong(text("a")), { type: "break" }, text("b")]),
            cell([text("c"), { type: "break" }, text("d")]),
          ],
        ],
      }),
    );
  });
});

describe("parseMarkdown embedded HTML safety", () => {
  it("drops a javascript link and keeps its text", () => {
    expect(
      parseMarkdown('<a href="javascript:alert(1)">x</a> <a href="java&#115;cript:alert(1)">y</a>'),
    ).toEqual(blocks(paragraph(text("x y"))));
  });

  it("drops an unsafe image and keeps its alt text", () => {
    expect(
      parseMarkdown('<img src="javascript:alert(1)" alt="pic"> <img src="data:text/html,hi">'),
    ).toEqual(blocks(paragraph(text("pic "))));
  });

  it("keeps the same links and images markdown would keep, percent-encoded the same way", () => {
    expect(parseMarkdown('<a href="/a b">x</a>')).toEqual(parseMarkdown("[x](/a%20b)"));
  });

  it("drops script and style with their content when one piece of HTML holds both tags", () => {
    expect(
      parseMarkdown(
        "<script>\nalert(1)\n\nif (a < b) {}\n</script>\n\n<style>p { color: red }</style>\n\nA<b>B</b>",
      ),
    ).toEqual(blocks(paragraph(text("A"), strong(text("B")))));
  });

  it("stops dropping at the end of a script tag that nothing closes, so prose is not lost", () => {
    expect(parseMarkdown("the <script> tag is dangerous and more")).toEqual(
      blocks(paragraph(text("the tag is dangerous and more"))),
    );
    expect(parseMarkdown("A<script>alert(2)</script>B")).toEqual(
      blocks(paragraph(text("Aalert(2)B"))),
    );
  });

  it("keeps the text of a script or style tag at a line start that nothing closes", () => {
    expect(parseMarkdown("<script> tags are bad.\n\nMore text here.")).toEqual(
      blocks(paragraph(text("tags are bad. More text here."))),
    );
    expect(parseMarkdown("<style> rules.\n\nMore text here.")).toEqual(
      blocks(paragraph(text("rules. More text here."))),
    );
  });

  it("drops comments, in a block and in a line, even one cut off", () => {
    expect(parseMarkdown("a<!-- hidden <b>x</b> -->b")).toEqual(blocks(paragraph(text("ab"))));
    expect(parseMarkdown("<!-- hidden\n\nstill hidden -->\n\nshown")).toEqual(
      blocks(paragraph(text("shown"))),
    );
    expect(parseMarkdown("<div>shown</div>\n<!-- cut off <b>")).toEqual(
      blocks(paragraph(text("shown"))),
    );
  });

  it("drops the tags of an element that is not in the list and keeps its text", () => {
    expect(
      parseMarkdown(
        '<span class="x">a</span> <sub>b</sub> <form action="/steal"><input type=password>c</form>',
      ),
    ).toEqual(blocks(paragraph(text("a b c"))));
  });

  it("ignores event handlers, styles and other attributes of a listed element", () => {
    expect(parseMarkdown('<b onclick="alert(1)" style="position:fixed">x</b>')).toEqual(
      blocks(paragraph(strong(text("x")))),
    );
  });

  it("ignores an image size that is not a whole number of pixels", () => {
    expect(
      parseMarkdown(
        '<img src="/a.png" width="50%" height="-4"> <img src="/b.png" width="0" height="1e3">',
      ),
    ).toEqual(
      blocks(
        paragraph({ type: "image", src: "/a.png", alt: "", title: undefined }, text(" "), {
          type: "image",
          src: "/b.png",
          alt: "",
          title: undefined,
        }),
      ),
    );
  });
});

describe("parseMarkdown embedded HTML never loses text", () => {
  it("keeps content that a table or a list does not use, in front of the block", () => {
    expect(parseMarkdown("<table>\n\nnext para **after**\n\n# heading")).toEqual(
      blocks(paragraph(text("next para "), strong(text("after"))), {
        type: "heading",
        depth: 1,
        children: [text("heading")],
      }),
    );
    expect(parseMarkdown("<ul>\n\nrest")).toEqual(blocks(paragraph(text("rest"))));
    expect(parseMarkdown("the <table> tag here and more")).toEqual(
      blocks(paragraph(text("the tag here and more"))),
    );
    expect(parseMarkdown("<table><tr>stray<td>cell</td></tr></table>")).toEqual(
      blocks(paragraph(text("stray")), {
        type: "table",
        header: [],
        rows: [[cell([text("cell")])]],
      }),
    );
  });

  it("keeps words apart in content that a table or a list passes through", () => {
    expect(parseMarkdown("<table><tr>stray<td>cell</td></tr>between</table>")).toEqual(
      blocks(paragraph(text("stray between")), {
        type: "table",
        header: [],
        rows: [[cell([text("cell")])]],
      }),
    );
    expect(parseMarkdown("<ul>one<li>item</li>two</ul>")).toEqual(
      blocks(paragraph(text("one two")), {
        type: "list",
        start: undefined,
        loose: false,
        items: [{ children: [paragraph(text("item"))] }],
      }),
    );
  });

  it("closes an item, a cell, a row or a section that the next one implies", () => {
    expect(parseMarkdown("<ul><li>one<li>two</ul>")).toEqual(
      blocks({
        type: "list",
        start: undefined,
        loose: false,
        items: [{ children: [paragraph(text("one"))] }, { children: [paragraph(text("two"))] }],
      }),
    );
    expect(parseMarkdown("<table><tr><td>a<td>b</tr></table>")).toEqual(
      blocks({
        type: "table",
        header: [],
        rows: [[cell([text("a")]), cell([text("b")])]],
      }),
    );
    expect(parseMarkdown("<table><tr><td>a<tr><td>b</table>")).toEqual(
      blocks({
        type: "table",
        header: [],
        rows: [[cell([text("a")])], [cell([text("b")])]],
      }),
    );
    expect(parseMarkdown("<table><thead><tr><th>h<tbody><tr><td>x</table>")).toEqual(
      blocks({
        type: "table",
        header: [cell([text("h")])],
        rows: [[cell([text("x")])]],
      }),
    );
  });

  it("does not close the item of an outer list for an item of a list inside it", () => {
    expect(parseMarkdown("<ul><li>a<ul><li>b</ul><li>c</ul>")).toEqual(
      blocks({
        type: "list",
        start: undefined,
        loose: false,
        items: [
          {
            children: [
              paragraph(text("a")),
              {
                type: "list",
                start: undefined,
                loose: false,
                items: [{ children: [paragraph(text("b"))] }],
              },
            ],
          },
          { children: [paragraph(text("c"))] },
        ],
      }),
    );
  });

  it("keeps the text of a part that has no parent", () => {
    expect(parseMarkdown("<li>solo</li>")).toEqual(blocks(paragraph(text("solo"))));
    expect(parseMarkdown("<td>a</td><td>b</td>")).toEqual(blocks(paragraph(text("a b"))));
    expect(parseMarkdown("<tr><td>a</td><td>b</td></tr>")).toEqual(blocks(paragraph(text("a b"))));
    expect(parseMarkdown("<summary>alone</summary>")).toEqual(blocks(paragraph(text("alone"))));
  });

  it("keeps the text of a second summary in a details block", () => {
    expect(
      parseMarkdown("<details><summary>A</summary><summary>B</summary>body</details>"),
    ).toEqual(
      blocks({
        type: "details",
        summary: [text("A")],
        children: [paragraph(text("B body"))],
      }),
    );
  });

  it("keeps white space between inline tags", () => {
    expect(parseMarkdown("a<b> </b>b")).toEqual(blocks(paragraph(text("a b"))));
    expect(parseMarkdown("<b>x</b><i> </i><b>y</b>")).toEqual(
      blocks(paragraph(strong(text("x")), text(" "), strong(text("y")))),
    );
  });

  it("draws no paragraph for an element that is empty", () => {
    expect(parseMarkdown("<b></b>")).toEqual(blocks());
    expect(parseMarkdown("x\n\n<p></p>\n\ny")).toEqual(
      blocks(paragraph(text("x")), paragraph(text("y"))),
    );
  });

  it("flattens a link inside a link to its children", () => {
    expect(parseMarkdown('<a href="/a">[x](/b) <b>[y](/c)</b></a>')).toEqual(
      blocks(paragraph(link("/a", text("x"), text(" "), strong(text("y"))))),
    );
  });
});

describe("parseMarkdown embedded HTML spacing", () => {
  it("puts a space on both sides of a part that has no parent", () => {
    expect(parseMarkdown("x<td>c</td>y")).toEqual(blocks(paragraph(text("x c y"))));
    expect(parseMarkdown("see<summary>S</summary>")).toEqual(blocks(paragraph(text("see S"))));
    expect(parseMarkdown("x <td>c</td> y")).toEqual(blocks(paragraph(text("x c y"))));
  });

  it("holds no double space where text meets text across a dropped tag", () => {
    expect(parseMarkdown("a <span> b</span> c")).toEqual(blocks(paragraph(text("a b c"))));
    expect(parseMarkdown("<div>a <span> b</span></div>")).toEqual(blocks(paragraph(text("a b"))));
  });

  it("keeps the spaces of preformatted text", () => {
    expect(parseMarkdown("<pre>a  <span>  b</span></pre>")).toEqual(
      blocks({ type: "code", text: "a    b" }),
    );
  });

  it("keeps the indentation of highlighted code", () => {
    expect(
      parseMarkdown("<pre><code>x\n<span>    </span><span>  return x;</span></code></pre>"),
    ).toEqual(blocks({ type: "code", text: "x\n      return x;" }));
    expect(parseMarkdown("<pre><code>a  <span>  b</span></code></pre>")).toEqual(
      blocks({ type: "code", text: "a    b" }),
    );
  });

  it("keeps the spaces at the ends of preformatted text inside an element", () => {
    const spaces = " ".repeat(50);
    expect(parseMarkdown(`<pre><p>x${spaces}y</p></pre>`)).toEqual(
      blocks({ type: "code", text: `x${spaces}y` }),
    );
    expect(parseMarkdown(`<pre><b>  x${spaces}</b></pre>`)).toEqual(
      blocks({ type: "code", text: `  x${spaces}` }),
    );
  });

  it("reads a line break as a space in code and as a line break in preformatted text", () => {
    expect(parseMarkdown("a <code>x<br>y</code>")).toEqual(
      blocks(paragraph(text("a "), { type: "inlineCode", text: "x y" })),
    );
    expect(parseMarkdown("<pre><code>x<br>y</code></pre>")).toEqual(
      blocks({ type: "code", text: "x\ny" }),
    );
    expect(parseMarkdown("<pre>x<br>y\nz</pre>")).toEqual(
      blocks({ type: "code", text: "x\ny\nz" }),
    );
  });
});

describe("parseMarkdown markup inside HTML code", () => {
  it("shows a footnote reference as written and numbers no footnote", () => {
    expect(parseMarkdown("<code>[^n]</code>\n\n[^n]: hi")).toEqual(
      blocks(paragraph({ type: "inlineCode", text: "[^n]" })),
    );
  });

  it("still numbers a footnote reference outside the code", () => {
    expect(parseMarkdown("<code>[^n]</code> and [^n]\n\n[^n]: hi")).toEqual({
      blocks: [
        paragraph({ type: "inlineCode", text: "[^n]" }, text(" and "), {
          type: "footnoteReference",
          number: 1,
          isFirstReference: true,
        }),
      ],
      footnotes: [
        {
          number: 1,
          children: [paragraph(text("hi"), { type: "footnoteBackReference", number: 1 })],
        },
      ],
    });
  });

  it("shows emphasis, links and escapes as written", () => {
    expect(parseMarkdown("<code>**x** [a](/b) \\* <https://e.com></code>")).toEqual(
      blocks(paragraph({ type: "inlineCode", text: "**x** [a](/b) \\* <https://e.com>" })),
    );
  });

  it("shows markdown blocks inside code as written", () => {
    expect(parseMarkdown("<code>\n\n[^n]\n\n**x**\n\n</code>\n\n[^n]: hi")).toEqual(
      blocks(paragraph({ type: "inlineCode", text: "[^n] **x**" })),
    );
  });

  it("follows the same nesting as the elements: a stray end tag changes nothing", () => {
    expect(parseMarkdown("<code>[^n]</pre>[^n]</code>\n\n[^n]: note")).toEqual(
      blocks(paragraph({ type: "inlineCode", text: "[^n][^n]" })),
    );
  });

  it("follows the same nesting as the elements: a parent's end tag closes the code", () => {
    expect(parseMarkdown("<div><code>x</div>\n\n**bold**")).toEqual(
      blocks(paragraph({ type: "inlineCode", text: "x" }), paragraph(strong(text("bold")))),
    );
    expect(parseMarkdown("<b><code>x</b> **bold**")).toEqual(
      blocks(paragraph(strong({ type: "inlineCode", text: "x" }), text(" "), strong(text("bold")))),
    );
  });

  it("follows the same nesting as the elements: a tag in dropped script content opens nothing", () => {
    expect(parseMarkdown('<script>const s = "<code>";</script>\n\n**bold**')).toEqual(
      blocks(paragraph(strong(text("bold")))),
    );
  });

  it("reads markdown again after the code ends", () => {
    expect(parseMarkdown("<code>**x**</code> **y**")).toEqual(
      blocks(paragraph({ type: "inlineCode", text: "**x**" }, text(" "), strong(text("y")))),
    );
  });
});

describe("parseMarkdown embedded HTML in a link", () => {
  it("flattens an HTML link inside a markdown link, so the outer link wins", () => {
    expect(parseMarkdown('[<a href="https://b">x</a>](https://a)')).toEqual(
      blocks(paragraph(link("https://a", text("x")))),
    );
    expect(parseMarkdown('[<b><a href="https://b">x</a></b>](https://a)')).toEqual(
      blocks(paragraph(link("https://a", strong(text("x"))))),
    );
  });
});

describe("parseMarkdown embedded HTML table size", () => {
  it("joins the cells past the column limit into the last cell, and stays fast", () => {
    const html = `<table><tr>${"<td>x</td>".repeat(25_000)}</tr>${"<tr><td>y</td></tr>".repeat(12_000)}</table>`;

    const started = performance.now();
    const [table] = parseMarkdown(html).blocks;

    expect(performance.now() - started).toBeLessThan(2000);
    if (table?.type !== "table") throw new Error("expected a table");
    expect(table.rows).toHaveLength(12_001);
    expect(table.header).toEqual([]);
    expect(table.rows[0]).toHaveLength(64);
    expect(table.rows[0]?.[62]).toEqual(cell([text("x")]));
    const lastCell = table.rows[0]?.[63]?.children ?? [];
    expect(lastCell.every((inline) => inline.type === "text")).toBe(true);
    expect(lastCell.map((inline) => (inline.type === "text" ? inline.text : "")).join("")).toBe(
      Array(25_000 - 63)
        .fill("x")
        .join(" "),
    );
    expect(table.rows[1]).toEqual([cell([text("y")]), cell([], 63)]);
  });
});

describe("parseMarkdown angle brackets that are not HTML", () => {
  it("keeps a tag that mixes upper and lower case as text, as a component", () => {
    expect(parseMarkdown("<Details>\n<Summary>S</Summary>\n\nbody\n\n</Details>")).toEqual(
      blocks(
        paragraph(text("<Details> <Summary>S</Summary>")),
        paragraph(text("body")),
        paragraph(text("</Details>")),
      ),
    );
  });

  it("keeps a generic type and a component tag as the text written", () => {
    expect(parseMarkdown("Use Array<string> or Promise<void> with <T> here")).toEqual(
      blocks(paragraph(text("Use Array<string> or Promise<void> with <T> here"))),
    );
    expect(parseMarkdown('<Button variant="primary" />')).toEqual(
      blocks(paragraph(text('<Button variant="primary" />'))),
    );
    expect(parseMarkdown("a <Button>click</Button> b <my-element>c</my-element>")).toEqual(
      blocks(paragraph(text("a <Button>click</Button> b <my-element>c</my-element>"))),
    );
  });

  it("keeps a tag that is not closed as text, however many there are", () => {
    expect(parseMarkdown("Map<string, Array<T")).toEqual(
      blocks(paragraph(text("Map<string, Array<T"))),
    );
    const started = performance.now();
    parseMarkdown("<Foo ".repeat(50_000));
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("still reads a standard element written in capitals", () => {
    expect(parseMarkdown("<STRONG>x</STRONG>")).toEqual(blocks(paragraph(strong(text("x")))));
  });
});

describe("parseMarkdown character references next to a tag", () => {
  it("reads a tag after an ampersand as the tag and keeps no handler", () => {
    expect(parseMarkdown("&<img src=x onerror=alert(1)>; and &a<b;")).toEqual(
      blocks(
        paragraph(
          text("&"),
          { type: "image", src: "x", alt: "", title: undefined },
          text("; and &a<b;"),
        ),
      ),
    );
  });
});

describe("parseMarkdown embedded HTML cut off", () => {
  it("closes what is open when the text ends in the middle of a tag", () => {
    expect(
      parseMarkdown(
        '<details><summary>Run</summary><table><tr><td><b>half</b></td></tr><tr><td>text <a href="https://exam',
      ),
    ).toEqual(
      blocks({
        type: "details",
        summary: [text("Run")],
        children: [
          {
            type: "table",
            header: [],
            rows: [[cell([strong(text("half"))])], [cell([text("text")])]],
          },
        ],
      }),
    );
  });

  it("drops a quoted attribute value that never closes, with its tag", () => {
    expect(parseMarkdown('<div>a <img src="https://e.com/a.png alt="x')).toEqual(
      blocks(paragraph(text("a"))),
    );
  });

  it("stays shallow however deep the tags nest", () => {
    const depth = (inlines: ReadonlyArray<MarkdownInline>): number => {
      const first = inlines[0];
      return first?.type === "strong" ? 1 + depth(first.children) : 0;
    };
    const [block] = parseMarkdown(`${"<b>".repeat(5000)}x`).blocks;

    expect(block?.type === "paragraph" ? depth(block.children) : -1).toBeLessThan(100);
  });
});
