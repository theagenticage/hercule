/**
 * Tests `parseMarkdown`, which turns the markdown in a message into the tree
 * both apps draw. Each test gives a small input and the whole tree it parses to.
 */
import { describe, expect, it } from "vitest";
import { parseMarkdown, type MarkdownBlock, type MarkdownInline } from "./markdown";

const text = (value: string): MarkdownInline => ({ type: "text", text: value });

const paragraph = (...children: MarkdownInline[]): MarkdownBlock => ({
  type: "paragraph",
  children,
});

/** The tree of a document with these blocks and no footnotes. */
const blocks = (...expected: MarkdownBlock[]) => ({ blocks: expected, footnotes: [] });

describe("parseMarkdown blocks", () => {
  it("parses a paragraph", () => {
    expect(parseMarkdown("Hello there.")).toEqual(blocks(paragraph(text("Hello there."))));
  });

  it("parses headings of every depth", () => {
    expect(
      parseMarkdown("# One\n\n## Two\n\n### Three\n\n#### Four\n\n##### Five\n\n###### Six"),
    ).toEqual(
      blocks(
        { type: "heading", depth: 1, children: [text("One")] },
        { type: "heading", depth: 2, children: [text("Two")] },
        { type: "heading", depth: 3, children: [text("Three")] },
        { type: "heading", depth: 4, children: [text("Four")] },
        { type: "heading", depth: 5, children: [text("Five")] },
        { type: "heading", depth: 6, children: [text("Six")] },
      ),
    );
  });

  it("parses a tight bulleted list", () => {
    expect(parseMarkdown("- a\n- b")).toEqual(
      blocks({
        type: "list",
        start: undefined,
        loose: false,
        items: [
          { checked: undefined, children: [paragraph(text("a"))] },
          { checked: undefined, children: [paragraph(text("b"))] },
        ],
      }),
    );
  });

  it("starts a numbered list at its first number", () => {
    expect(parseMarkdown("3. a\n4. b")).toEqual(
      blocks({
        type: "list",
        start: 3,
        loose: false,
        items: [
          { checked: undefined, children: [paragraph(text("a"))] },
          { checked: undefined, children: [paragraph(text("b"))] },
        ],
      }),
    );
  });

  it("keeps a list that starts at zero numbered", () => {
    expect(parseMarkdown("0. a")).toEqual(
      blocks({
        type: "list",
        start: 0,
        loose: false,
        items: [{ checked: undefined, children: [paragraph(text("a"))] }],
      }),
    );
  });

  it("marks a list loose when blank lines separate its items", () => {
    expect(parseMarkdown("- a\n\n- b")).toEqual(
      blocks({
        type: "list",
        start: undefined,
        loose: true,
        items: [
          { checked: undefined, children: [paragraph(text("a"))] },
          { checked: undefined, children: [paragraph(text("b"))] },
        ],
      }),
    );
  });

  it("nests a list inside an item", () => {
    expect(parseMarkdown("- a\n  1. b")).toEqual(
      blocks({
        type: "list",
        start: undefined,
        loose: false,
        items: [
          {
            checked: undefined,
            children: [
              paragraph(text("a")),
              {
                type: "list",
                start: 1,
                loose: false,
                items: [{ checked: undefined, children: [paragraph(text("b"))] }],
              },
            ],
          },
        ],
      }),
    );
  });

  it("parses task items as checked or unchecked, with no checkbox in the text", () => {
    expect(parseMarkdown("- [x] done\n- [ ] open")).toEqual(
      blocks({
        type: "list",
        start: undefined,
        loose: false,
        items: [
          { checked: true, children: [paragraph(text("done"))] },
          { checked: false, children: [paragraph(text("open"))] },
        ],
      }),
    );
  });

  it("parses a blockquote and the blocks inside it", () => {
    expect(parseMarkdown("> quoted\n>\n> - item")).toEqual(
      blocks({
        type: "blockquote",
        children: [
          paragraph(text("quoted")),
          {
            type: "list",
            start: undefined,
            loose: false,
            items: [{ checked: undefined, children: [paragraph(text("item"))] }],
          },
        ],
      }),
    );
  });

  it("parses a thematic break as a rule", () => {
    expect(parseMarkdown("a\n\n---\n\nb")).toEqual(
      blocks(paragraph(text("a")), { type: "rule" }, paragraph(text("b"))),
    );
  });

  it("keeps the text of a fenced code block as written, with no decoding", () => {
    expect(parseMarkdown("```ts\nconst a = 1 &amp; 2;\n\nb();\n```")).toEqual(
      blocks({ type: "code", text: "const a = 1 &amp; 2;\n\nb();" }),
    );
  });

  it("keeps the text of an indented code block as written, with no decoding", () => {
    expect(parseMarkdown("    a &lt; b")).toEqual(blocks({ type: "code", text: "a &lt; b" }));
  });

  it("parses a table with the alignment of each column", () => {
    expect(parseMarkdown("| a | b | c | d |\n|:--|:-:|--:|---|\n| 1 | 2 | 3 | **4** |")).toEqual(
      blocks({
        type: "table",
        align: ["left", "center", "right", undefined],
        header: [[text("a")], [text("b")], [text("c")], [text("d")]],
        rows: [
          [[text("1")], [text("2")], [text("3")], [{ type: "strong", children: [text("4")] }]],
        ],
      }),
    );
  });
});

describe("parseMarkdown inline elements", () => {
  it("parses a link", () => {
    expect(parseMarkdown("[docs](https://example.com/a?b=1)")).toEqual(
      blocks(
        paragraph({ type: "link", href: "https://example.com/a?b=1", children: [text("docs")] }),
      ),
    );
  });

  it("parses emphasis", () => {
    expect(parseMarkdown("*a*")).toEqual(
      blocks(paragraph({ type: "emphasis", children: [text("a")] })),
    );
  });

  it("parses strong text", () => {
    expect(parseMarkdown("**a**")).toEqual(
      blocks(paragraph({ type: "strong", children: [text("a")] })),
    );
  });

  it("parses strikethrough", () => {
    expect(parseMarkdown("~~a~~")).toEqual(
      blocks(paragraph({ type: "strikethrough", children: [text("a")] })),
    );
  });

  it("parses inline code without decoding it", () => {
    expect(parseMarkdown("`a &amp; b`")).toEqual(
      blocks(paragraph({ type: "inlineCode", text: "a &amp; b" })),
    );
  });

  it("parses an image", () => {
    expect(parseMarkdown("![A *small* cat](/cat.png)")).toEqual(
      blocks(paragraph({ type: "image", src: "/cat.png", alt: "A small cat" })),
    );
  });

  it("turns a bare URL into a link", () => {
    expect(parseMarkdown("See https://example.com/a and www.example.org.")).toEqual(
      blocks(
        paragraph(
          text("See "),
          {
            type: "link",
            href: "https://example.com/a",
            children: [text("https://example.com/a")],
          },
          text(" and "),
          { type: "link", href: "http://www.example.org", children: [text("www.example.org")] },
          text("."),
        ),
      ),
    );
  });

  it("turns an angle-bracket URL and an email address into links", () => {
    expect(parseMarkdown("<https://example.com> <me@example.com>")).toEqual(
      blocks(
        paragraph(
          { type: "link", href: "https://example.com", children: [text("https://example.com")] },
          text(" "),
          { type: "link", href: "mailto:me@example.com", children: [text("me@example.com")] },
        ),
      ),
    );
  });
});

describe("parseMarkdown line breaks", () => {
  it("joins two lines into one text when breaks is off", () => {
    expect(parseMarkdown("one\ntwo")).toEqual(blocks(paragraph(text("one\ntwo"))));
  });

  it("turns a single newline into a break when breaks is on", () => {
    expect(parseMarkdown("one\ntwo", { breaks: true })).toEqual(
      blocks(paragraph(text("one"), { type: "break" }, text("two"))),
    );
  });

  it("turns two trailing spaces into a break whether breaks is on or off", () => {
    const expected = blocks(paragraph(text("one"), { type: "break" }, text("two")));
    expect(parseMarkdown("one  \ntwo")).toEqual(expected);
    expect(parseMarkdown("one  \ntwo", { breaks: true })).toEqual(expected);
  });

  it("uses the breaks value of each call, not of an earlier one", () => {
    parseMarkdown("one\ntwo", { breaks: true });
    expect(parseMarkdown("one\ntwo")).toEqual(blocks(paragraph(text("one\ntwo"))));
  });
});

describe("parseMarkdown footnotes", () => {
  it("numbers footnotes by their first reference, not by their definition", () => {
    expect(parseMarkdown("a[^b] c[^a]\n\n[^a]: Alpha.\n[^b]: Bravo.")).toEqual({
      blocks: [
        paragraph(
          text("a"),
          { type: "footnoteReference", number: 1, isFirstReference: true },
          text(" c"),
          { type: "footnoteReference", number: 2, isFirstReference: true },
        ),
      ],
      footnotes: [
        { number: 1, children: [paragraph(text("Bravo."))] },
        { number: 2, children: [paragraph(text("Alpha."))] },
      ],
    });
  });

  it("marks only the first reference to a footnote as the first", () => {
    expect(parseMarkdown("a[^1] b[^1]\n\n> c[^1]\n\n[^1]: One.")).toEqual({
      blocks: [
        paragraph(
          text("a"),
          { type: "footnoteReference", number: 1, isFirstReference: true },
          text(" b"),
          { type: "footnoteReference", number: 1, isFirstReference: false },
        ),
        {
          type: "blockquote",
          children: [
            paragraph(text("c"), {
              type: "footnoteReference",
              number: 1,
              isFirstReference: false,
            }),
          ],
        },
      ],
      footnotes: [{ number: 1, children: [paragraph(text("One."))] }],
    });
  });

  it("leaves out a footnote that no reference names", () => {
    expect(parseMarkdown("a[^1]\n\n[^1]: Used.\n[^2]: Unused.")).toEqual({
      blocks: [
        paragraph(text("a"), { type: "footnoteReference", number: 1, isFirstReference: true }),
      ],
      footnotes: [{ number: 1, children: [paragraph(text("Used."))] }],
    });
  });

  it("keeps a reference to a missing footnote as text", () => {
    expect(parseMarkdown("a[^x]")).toEqual(blocks(paragraph(text("a[^x]"))));
  });

  it("parses a footnote that holds several blocks", () => {
    expect(parseMarkdown("a[^1]\n\n[^1]: First.\n\n    Second, with `code`.")).toEqual({
      blocks: [
        paragraph(text("a"), { type: "footnoteReference", number: 1, isFirstReference: true }),
      ],
      footnotes: [
        {
          number: 1,
          children: [
            paragraph(text("First.")),
            paragraph(text("Second, with "), { type: "inlineCode", text: "code" }, text(".")),
          ],
        },
      ],
    });
  });

  it("numbers footnotes from 1 in every call", () => {
    const first = parseMarkdown("a[^1]\n\n[^1]: One.");
    parseMarkdown("b[^x] c[^y]\n\n[^x]: X.\n[^y]: Y.");
    expect(parseMarkdown("a[^1]\n\n[^1]: One.")).toEqual(first);
  });
});

describe("parseMarkdown raw HTML", () => {
  it("shows a block of HTML as the text of a paragraph", () => {
    expect(parseMarkdown("<form><input type=password></form>\n\nafter")).toEqual(
      blocks(paragraph(text("<form><input type=password></form>")), paragraph(text("after"))),
    );
  });

  it("shows HTML inside a line as text, without decoding it", () => {
    expect(parseMarkdown('a <b title="&amp;">bold</b> c')).toEqual(
      blocks(
        paragraph(text("a "), text('<b title="&amp;">'), text("bold"), text("</b>"), text(" c")),
      ),
    );
  });
});

describe("parseMarkdown addresses", () => {
  it("keeps the text of a javascript link and drops the link", () => {
    expect(parseMarkdown("[x](javascript:alert(1))")).toEqual(blocks(paragraph(text("x"))));
  });

  it("refuses a scheme in capitals", () => {
    expect(parseMarkdown("[x](JAVASCRIPT:alert(1))")).toEqual(blocks(paragraph(text("x"))));
  });

  it("refuses a scheme written with a character reference", () => {
    expect(parseMarkdown("[x](javascript&#58;alert(1))")).toEqual(blocks(paragraph(text("x"))));
    expect(parseMarkdown("[x](&#x6A;avascript:alert(1))")).toEqual(blocks(paragraph(text("x"))));
  });

  it("refuses a data link and keeps the formatting of its text", () => {
    expect(parseMarkdown("[**x**](data:text/html,hi)")).toEqual(
      blocks(paragraph({ type: "strong", children: [text("x")] })),
    );
  });

  it("keeps relative, hash, query and allowed-scheme addresses", () => {
    expect(
      parseMarkdown(
        "[a](/docs/a:b) [b](#top) [c](?q=a:b) [d](mailto:me@example.com) [e](HTTP://example.com)",
      ),
    ).toEqual(
      blocks(
        paragraph(
          { type: "link", href: "/docs/a:b", children: [text("a")] },
          text(" "),
          { type: "link", href: "#top", children: [text("b")] },
          text(" "),
          { type: "link", href: "?q=a:b", children: [text("c")] },
          text(" "),
          { type: "link", href: "mailto:me@example.com", children: [text("d")] },
          text(" "),
          { type: "link", href: "HTTP://example.com", children: [text("e")] },
        ),
      ),
    );
  });

  it("replaces an image with an unsafe address by its alt text", () => {
    expect(parseMarkdown("![a cat](javascript:alert(1))")).toEqual(
      blocks(paragraph(text("a cat"))),
    );
  });

  it("drops an image with an unsafe address and no alt text", () => {
    expect(parseMarkdown("a![](javascript:alert(1))b")).toEqual(
      blocks(paragraph(text("a"), text("b"))),
    );
  });
});

describe("parseMarkdown character references", () => {
  it("decodes named and numeric references in text", () => {
    expect(parseMarkdown("AT&amp;T &copy; &#35; &#x23; &#X41;")).toEqual(
      blocks(paragraph(text("AT&T © # # A"))),
    );
  });

  it("keeps a name that is not a character reference as written", () => {
    expect(parseMarkdown("&foo; &amp &#; &#xZZ;")).toEqual(
      blocks(paragraph(text("&foo; &amp &#; &#xZZ;"))),
    );
  });

  it("replaces a number that is no character by the replacement character", () => {
    expect(parseMarkdown("&#0; &#xD800; &#1114112;")).toEqual(blocks(paragraph(text("� � �"))));
  });

  it("decodes references in a heading, a table cell and a link's text", () => {
    expect(parseMarkdown("# a &lt; b\n\n| x |\n|---|\n| &gt; |\n\n[&amp;](/a)")).toEqual(
      blocks(
        { type: "heading", depth: 1, children: [text("a < b")] },
        {
          type: "table",
          align: [undefined],
          header: [[text("x")]],
          rows: [[[text(">")]]],
        },
        paragraph({ type: "link", href: "/a", children: [text("&")] }),
      ),
    );
  });

  it("decodes references in a link address and an image's address and alt text", () => {
    expect(parseMarkdown("[a](/?x=1&amp;y=2) ![&lt;b&gt;](/i.png?x=1&amp;y=2)")).toEqual(
      blocks(
        paragraph({ type: "link", href: "/?x=1&y=2", children: [text("a")] }, text(" "), {
          type: "image",
          src: "/i.png?x=1&y=2",
          alt: "<b>",
        }),
      ),
    );
  });

  it("does not decode a reference whose ampersand is escaped", () => {
    expect(parseMarkdown("\\&amp;")).toEqual(blocks(paragraph(text("&"), text("amp;"))));
  });
});

describe("parseMarkdown deep nesting", () => {
  it("throws a RangeError when quotes nest deeper than the stack allows", () => {
    expect(() => parseMarkdown(`${">".repeat(50_000)} x`)).toThrow(RangeError);
  });

  it("parses footnotes correctly after a call that threw", () => {
    expect(() => parseMarkdown(`${">".repeat(50_000)} x`)).toThrow(RangeError);
    expect(parseMarkdown("a[^1]\n\n[^1]: One.")).toEqual({
      blocks: [
        paragraph(text("a"), { type: "footnoteReference", number: 1, isFirstReference: true }),
      ],
      footnotes: [{ number: 1, children: [paragraph(text("One."))] }],
    });
  });
});
