/**
 * Tests the HTML that `parseMarkdown` reads inside markdown. Each test gives
 * the markdown or HTML a GitHub comment can hold and the whole tree it parses
 * to.
 */
import { describe, expect, it } from "vitest";
import { parseMarkdown, type MarkdownBlock, type MarkdownInline } from "./markdown";

const text = (value: string): MarkdownInline => ({ type: "text", text: value });

const paragraph = (...children: MarkdownInline[]): MarkdownBlock => ({
  type: "paragraph",
  children,
});

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
  it("parses a Cypress comment: a table of images, links, code and a footer", () => {
    const comment = [
      '<h3><a href="https://cloud.cypress.io/runs/42">Cypress run 42</a></h3>',
      "<table>",
      "<thead><tr><th>Result</th><th align=right>Spec</th></tr></thead>",
      "<tbody>",
      '<tr><td><picture><source srcset="/dark.svg"><img src="https://cloud.cypress.io/failed.svg" alt="failed" width="10" height="10"></picture></td>',
      '<td><a href="https://cloud.cypress.io/specs/1"><strong>login.cy.ts</strong></a> <code>2 of 5</code></td></tr>',
      '<tr><td colspan="2">&nbsp;</td></tr>',
      "</tbody>",
      '<tfoot><tr><td colspan="2">Ran in 3m&nbsp;12s</td></tr></tfoot>',
      "</table>",
    ].join("\n");

    expect(parseMarkdown(comment)).toEqual(
      blocks(
        {
          type: "heading",
          depth: 3,
          children: [link("https://cloud.cypress.io/runs/42", text("Cypress run 42"))],
        },
        {
          type: "table",
          align: [undefined, "right"],
          header: [[text("Result")], [text("Spec")]],
          rows: [
            [
              [
                {
                  type: "image",
                  src: "https://cloud.cypress.io/failed.svg",
                  alt: "failed",
                  title: undefined,
                  width: 10,
                  height: 10,
                },
              ],
              [
                link("https://cloud.cypress.io/specs/1", strong(text("login.cy.ts"))),
                text(" "),
                { type: "inlineCode", text: "2 of 5" },
              ],
            ],
            [[text(" ")], []],
            [[text("Ran in 3m 12s")], []],
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
        '<table><tr><th align="center">A</th><th>B</th><th>C</th></tr><tr><td>1</td></tr><tr><td colspan="3">2</td><td>x</td></tr></table>',
      ),
    ).toEqual(
      blocks({
        type: "table",
        align: ["center", undefined, undefined],
        header: [[text("A")], [text("B")], [text("C")]],
        rows: [
          [[text("1")], [], []],
          [[text("2")], [text("x")], []],
        ],
      }),
    );
  });

  it("leaves the header empty for a table of td cells only", () => {
    expect(parseMarkdown("<table><tr><td>a</td><td>b</td></tr></table>")).toEqual(
      blocks({
        type: "table",
        align: [undefined, undefined],
        header: [],
        rows: [[[text("a")], [text("b")]]],
      }),
    );
  });

  it("flattens block content in a cell, such as markdown between blank lines, to inlines", () => {
    const html =
      "<table>\n<tr>\n<td>\n\n**a**\n\nb\n\n</td>\n<td><p>c</p><p>d</p></td>\n</tr>\n</table>";

    expect(parseMarkdown(html)).toEqual(
      blocks({
        type: "table",
        align: [undefined, undefined],
        header: [],
        rows: [
          [
            [strong(text("a")), { type: "break" }, text("b")],
            [text("c"), { type: "break" }, text("d")],
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

  it("drops script and style with their content, in a block and in a line", () => {
    expect(
      parseMarkdown(
        "<script>\nalert(1)\n\nif (a < b) {}\n</script>\n\n<style>p { color: red }</style>\n\nA<script>alert(2)</script>B",
      ),
    ).toEqual(blocks(paragraph(text("AB"))));
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
            align: [undefined],
            header: [],
            rows: [[[strong(text("half"))]], [[text("text")]]],
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
