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
        items: [{ children: [paragraph(text("a"))] }, { children: [paragraph(text("b"))] }],
      }),
    );
  });

  it("starts a numbered list at its first number", () => {
    expect(parseMarkdown("3. a\n4. b")).toEqual(
      blocks({
        type: "list",
        start: 3,
        loose: false,
        items: [{ children: [paragraph(text("a"))] }, { children: [paragraph(text("b"))] }],
      }),
    );
  });

  it("keeps a list that starts at zero numbered", () => {
    expect(parseMarkdown("0. a")).toEqual(
      blocks({
        type: "list",
        start: 0,
        loose: false,
        items: [{ children: [paragraph(text("a"))] }],
      }),
    );
  });

  it("marks a list loose when blank lines separate its items", () => {
    expect(parseMarkdown("- a\n\n- b")).toEqual(
      blocks({
        type: "list",
        start: undefined,
        loose: true,
        items: [{ children: [paragraph(text("a"))] }, { children: [paragraph(text("b"))] }],
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
            children: [
              paragraph(text("a")),
              {
                type: "list",
                start: 1,
                loose: false,
                items: [{ children: [paragraph(text("b"))] }],
              },
            ],
          },
        ],
      }),
    );
  });

  it("starts a task item with its checkbox, ticked or not", () => {
    expect(parseMarkdown("- [x] done\n- [ ] open")).toEqual(
      blocks({
        type: "list",
        start: undefined,
        loose: false,
        items: [
          { children: [paragraph({ type: "checkbox", checked: true }, text("done"))] },
          { children: [paragraph({ type: "checkbox", checked: false }, text("open"))] },
        ],
      }),
    );
  });

  it("starts the first paragraph of a loose task item with its checkbox", () => {
    expect(parseMarkdown("- [x] done\n\n- [ ] open\n\n  more")).toEqual(
      blocks({
        type: "list",
        start: undefined,
        loose: true,
        items: [
          { children: [paragraph({ type: "checkbox", checked: true }, text("done"))] },
          {
            children: [
              paragraph({ type: "checkbox", checked: false }, text("open")),
              paragraph(text("more")),
            ],
          },
        ],
      }),
    );
  });

  it("keeps the blocks that follow the first paragraph of a task item", () => {
    expect(parseMarkdown("- [ ] a\n  - b")).toEqual(
      blocks({
        type: "list",
        start: undefined,
        loose: false,
        items: [
          {
            children: [
              paragraph({ type: "checkbox", checked: false }, text("a")),
              {
                type: "list",
                start: undefined,
                loose: false,
                items: [{ children: [paragraph(text("b"))] }],
              },
            ],
          },
        ],
      }),
    );
  });

  it("leaves a box with no text after it as text", () => {
    expect(parseMarkdown("- [ ]")).toEqual(
      blocks({
        type: "list",
        start: undefined,
        loose: false,
        items: [{ children: [paragraph(text("[ ]"))] }],
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
            items: [{ children: [paragraph(text("item"))] }],
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
        paragraph({
          type: "link",
          href: "https://example.com/a?b=1",
          title: undefined,
          children: [text("docs")],
        }),
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
      blocks(paragraph({ type: "image", src: "/cat.png", alt: "A small cat", title: undefined })),
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
            title: undefined,
            children: [text("https://example.com/a")],
          },
          text(" and "),
          {
            type: "link",
            href: "http://www.example.org",
            title: undefined,
            children: [text("www.example.org")],
          },
          text("."),
        ),
      ),
    );
  });

  it("turns an angle-bracket URL and an email address into links", () => {
    expect(parseMarkdown("<https://example.com> <me@example.com>")).toEqual(
      blocks(
        paragraph(
          {
            type: "link",
            href: "https://example.com",
            title: undefined,
            children: [text("https://example.com")],
          },
          text(" "),
          {
            type: "link",
            href: "mailto:me@example.com",
            title: undefined,
            children: [text("me@example.com")],
          },
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

/** A reference to the footnote with this number. */
const reference = (number: number, isFirstReference = true): MarkdownInline => ({
  type: "footnoteReference",
  number,
  isFirstReference,
});

/** The back reference that ends the footnote with this number. */
const backReference = (number: number): MarkdownInline => ({
  type: "footnoteBackReference",
  number,
});

describe("parseMarkdown footnotes", () => {
  it("numbers footnotes by their first reference, not by their definition", () => {
    expect(parseMarkdown("a[^b] c[^a]\n\n[^a]: Alpha.\n[^b]: Bravo.")).toEqual({
      blocks: [paragraph(text("a"), reference(1), text(" c"), reference(2))],
      footnotes: [
        { number: 1, children: [paragraph(text("Bravo."), backReference(1))] },
        { number: 2, children: [paragraph(text("Alpha."), backReference(2))] },
      ],
    });
  });

  it("marks only the first reference to a footnote as the first", () => {
    expect(parseMarkdown("a[^1] b[^1]\n\n> c[^1]\n\n[^1]: One.")).toEqual({
      blocks: [
        paragraph(text("a"), reference(1), text(" b"), reference(1, false)),
        { type: "blockquote", children: [paragraph(text("c"), reference(1, false))] },
      ],
      footnotes: [{ number: 1, children: [paragraph(text("One."), backReference(1))] }],
    });
  });

  it("leaves out a footnote that no reference names", () => {
    expect(parseMarkdown("a[^1]\n\n[^1]: Used.\n[^2]: Unused.")).toEqual({
      blocks: [paragraph(text("a"), reference(1))],
      footnotes: [{ number: 1, children: [paragraph(text("Used."), backReference(1))] }],
    });
  });

  it("leaves out a chain of footnotes that no visible text starts", () => {
    expect(parseMarkdown("text\n\n[^a]: A with [^b].\n[^b]: B.")).toEqual(
      blocks(paragraph(text("text"))),
    );
  });

  it("keeps a reference to a missing footnote as text", () => {
    expect(parseMarkdown("a[^nope]")).toEqual(blocks(paragraph(text("a[^nope]"))));
  });

  it("matches a label without regard to case", () => {
    expect(parseMarkdown("a[^A] b[^xY]\n\n[^a]: One.\n[^Xy]: Two.")).toEqual({
      blocks: [paragraph(text("a"), reference(1), text(" b"), reference(2))],
      footnotes: [
        { number: 1, children: [paragraph(text("One."), backReference(1))] },
        { number: 2, children: [paragraph(text("Two."), backReference(2))] },
      ],
    });
  });

  it("uses the first definition of a label", () => {
    expect(parseMarkdown("a[^1]\n\n[^1]: First.\n[^1]: Second.")).toEqual({
      blocks: [paragraph(text("a"), reference(1))],
      footnotes: [{ number: 1, children: [paragraph(text("First."), backReference(1))] }],
    });
  });

  it("numbers a footnote that another footnote references after the footnotes already waiting", () => {
    expect(parseMarkdown("a[^a] b[^c]\n\n[^a]: A with [^b].\n[^b]: B.\n[^c]: C.")).toEqual({
      blocks: [paragraph(text("a"), reference(1), text(" b"), reference(2))],
      footnotes: [
        {
          number: 1,
          children: [paragraph(text("A with "), reference(3), text("."), backReference(1))],
        },
        { number: 2, children: [paragraph(text("C."), backReference(2))] },
        { number: 3, children: [paragraph(text("B."), backReference(3))] },
      ],
    });
  });

  it("numbers a footnote that only a footnote references", () => {
    expect(parseMarkdown("[^a]: A with [^b].\n[^b]: B.\n\nx[^a]")).toEqual({
      blocks: [paragraph(text("x"), reference(1))],
      footnotes: [
        {
          number: 1,
          children: [paragraph(text("A with "), reference(2), text("."), backReference(1))],
        },
        { number: 2, children: [paragraph(text("B."), backReference(2))] },
      ],
    });
  });

  it("does not let a reference in an image's alt text take a number or mark a reference", () => {
    expect(parseMarkdown("![a[^1]b](/i.png) c[^1]\n\n[^1]: One.")).toEqual({
      blocks: [
        paragraph(
          { type: "image", src: "/i.png", alt: "ab", title: undefined },
          text(" c"),
          reference(1),
        ),
      ],
      footnotes: [{ number: 1, children: [paragraph(text("One."), backReference(1))] }],
    });
  });

  it("parses a footnote that holds several blocks and puts the back reference in the last paragraph", () => {
    expect(parseMarkdown("a[^1]\n\n[^1]: First.\n\n    Second, with `code`.")).toEqual({
      blocks: [paragraph(text("a"), reference(1))],
      footnotes: [
        {
          number: 1,
          children: [
            paragraph(text("First.")),
            paragraph(
              text("Second, with "),
              { type: "inlineCode", text: "code" },
              text("."),
              backReference(1),
            ),
          ],
        },
      ],
    });
  });

  it("puts the back reference in a new paragraph when the footnote does not end in one", () => {
    expect(parseMarkdown("a[^1]\n\n[^1]: Intro.\n\n    ```\n    code\n    ```")).toEqual({
      blocks: [paragraph(text("a"), reference(1))],
      footnotes: [
        {
          number: 1,
          children: [
            paragraph(text("Intro.")),
            { type: "code", text: "code" },
            paragraph(backReference(1)),
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

  it("takes a footnote definition inside a quote as text", () => {
    expect(parseMarkdown("> [^1]: One.\n\na[^1]")).toEqual(
      blocks(
        { type: "blockquote", children: [paragraph(text("[^1]: One."))] },
        paragraph(text("a[^1]")),
      ),
    );
  });

  it("recognises a definition on the line right after a paragraph line", () => {
    expect(parseMarkdown("a[^a]\n[^a]: Note")).toEqual({
      blocks: [paragraph(text("a"), reference(1))],
      footnotes: [{ number: 1, children: [paragraph(text("Note"), backReference(1))] }],
    });
  });

  it("does not cut a paragraph at a bracket in the middle of a line", () => {
    expect(parseMarkdown("a [^a]: not a definition")).toEqual(
      blocks(paragraph(text("a [^a]: not a definition"))),
    );
  });

  it("allows 1 to 3 spaces before a definition", () => {
    const expected = {
      blocks: [paragraph(reference(1))],
      footnotes: [{ number: 1, children: [paragraph(text("Note"), backReference(1))] }],
    };
    expect(parseMarkdown("[^a]\n\n [^a]: Note")).toEqual(expected);
    expect(parseMarkdown("[^a]\n\n   [^a]: Note")).toEqual(expected);
  });

  it("does not take a definition indented by 4 spaces, which is code", () => {
    expect(parseMarkdown("[^a]\n\n    [^a]: Note")).toEqual(
      blocks(paragraph(text("[^a]")), { type: "code", text: "[^a]: Note" }),
    );
  });

  it("keeps a line indented by a tab in the footnote", () => {
    expect(parseMarkdown("[^a]\n\n[^a]: first\n\tsecond\n\n\tthird")).toEqual({
      blocks: [paragraph(reference(1))],
      footnotes: [
        {
          number: 1,
          children: [paragraph(text("first\nsecond")), paragraph(text("third"), backReference(1))],
        },
      ],
    });
  });

  it("keeps a line without indentation in the footnote when it continues the first paragraph", () => {
    expect(parseMarkdown("[^a]\n\n[^a]: first\nlazy continuation")).toEqual({
      blocks: [paragraph(reference(1))],
      footnotes: [
        {
          number: 1,
          children: [paragraph(text("first\nlazy continuation"), backReference(1))],
        },
      ],
    });
  });

  it("continues a paragraph that an indented line extended with a line without indentation", () => {
    expect(parseMarkdown("[^a]\n\n[^a]: first\n    second\nthird")).toEqual({
      blocks: [paragraph(reference(1))],
      footnotes: [
        { number: 1, children: [paragraph(text("first\nsecond\nthird"), backReference(1))] },
      ],
    });
  });

  it("keeps a heading-like word without a space in the footnote", () => {
    expect(parseMarkdown("[^a]\n\n[^a]: note\n#hashtag")).toEqual({
      blocks: [paragraph(reference(1))],
      footnotes: [{ number: 1, children: [paragraph(text("note\n#hashtag"), backReference(1))] }],
    });
  });

  it.each([
    ["a code fence", "[^unused]: ```\n    example\nIMPORTANT"],
    ["HTML", "[^unused]: note\n    <div>\nIMPORTANT"],
    ["indented code after a blank line", "[^unused]: note\n\n        code\nIMPORTANT"],
    ["a heading underline", "[^unused]: note\n    ===\nIMPORTANT"],
    ["a table", "[^unused]: a | b\n    --- | ---\nIMPORTANT"],
  ])("shows a line without indentation after %s in a footnote", (_, source) => {
    expect(parseMarkdown(source)).toEqual(blocks(paragraph(text("IMPORTANT"))));
  });

  it("continues a later paragraph of the footnote with a line without indentation", () => {
    expect(parseMarkdown("[^a]\n\n[^a]: first\n\n    second,\ncontinued")).toEqual({
      blocks: [paragraph(reference(1))],
      footnotes: [
        {
          number: 1,
          children: [
            paragraph(text("first")),
            paragraph(text("second,\ncontinued"), backReference(1)),
          ],
        },
      ],
    });
  });

  it.each([
    ["[^note 1]: IMPORTANT WARNING", "[^note 1]: IMPORTANT WARNING"],
    ["[^ ]: IMPORTANT WARNING", "[^ ]: IMPORTANT WARNING"],
    ["[^a\tb]: IMPORTANT WARNING", "[^a\tb]: IMPORTANT WARNING"],
  ])("keeps %j as text, because a footnote label holds no whitespace", (source, shown) => {
    expect(parseMarkdown(source)).toEqual(blocks(paragraph(text(shown))));
  });

  it("keeps a definition whose closing bracket is escaped as text", () => {
    expect(parseMarkdown("[^a\\]: note\nIMPORTANT WARNING")).toEqual(
      blocks(paragraph(text("[^a"), text("]"), text(": note\nIMPORTANT WARNING"))),
    );
  });

  it("ends a footnote at a definition whose label holds an escaped bracket", () => {
    expect(parseMarkdown("See [^a\\]b].\n\n[^unused]: note\n[^a\\]b]: IMPORTANT WARNING")).toEqual({
      blocks: [paragraph(text("See "), reference(1), text("."))],
      footnotes: [
        { number: 1, children: [paragraph(text("IMPORTANT WARNING"), backReference(1))] },
      ],
    });
  });

  it("keeps a definition whose label is longer than 999 characters of source as text", () => {
    const source = `[^${"a".repeat(998)}\\*]: IMPORTANT WARNING`;
    expect(JSON.stringify(parseMarkdown(source).blocks)).toContain("IMPORTANT WARNING");
  });

  it("keeps a link definition whose label starts with a caret but is not a footnote label", () => {
    expect(parseMarkdown("[use][^a b]\n\n[^a b]: https://example.com")).toEqual(
      blocks(
        paragraph({
          type: "link",
          href: "https://example.com",
          title: undefined,
          children: [text("use")],
        }),
      ),
    );
  });

  it("ends the footnote at a blank line followed by a line without indentation", () => {
    expect(parseMarkdown("[^a]\n\n[^a]: first\n\nafter")).toEqual({
      blocks: [paragraph(reference(1)), paragraph(text("after"))],
      footnotes: [{ number: 1, children: [paragraph(text("first"), backReference(1))] }],
    });
  });

  it("ends the footnote at a heading, which is part of the body", () => {
    expect(parseMarkdown("[^a]\n\n[^a]: note\n# Heading")).toEqual({
      blocks: [paragraph(reference(1)), { type: "heading", depth: 1, children: [text("Heading")] }],
      footnotes: [{ number: 1, children: [paragraph(text("note"), backReference(1))] }],
    });
  });

  it("ends the footnote at a list, which is part of the body", () => {
    expect(parseMarkdown("[^a]\n\n[^a]: note\n- item\n2) other")).toEqual({
      blocks: [
        paragraph(reference(1)),
        {
          type: "list",
          start: undefined,
          loose: false,
          items: [{ children: [paragraph(text("item"))] }],
        },
        { type: "list", start: 2, loose: false, items: [{ children: [paragraph(text("other"))] }] },
      ],
      footnotes: [{ number: 1, children: [paragraph(text("note"), backReference(1))] }],
    });
  });

  it("does not continue a footnote whose first line is empty with a line without indentation", () => {
    expect(parseMarkdown("[^a]\n\n[^a]:\nbody")).toEqual({
      blocks: [paragraph(reference(1)), paragraph(text("body"))],
      footnotes: [{ number: 1, children: [paragraph(backReference(1))] }],
    });
  });

  it("keeps a link whose text looks like an undefined footnote reference", () => {
    expect(parseMarkdown("[^x](https://e.com)")).toEqual(
      blocks(
        paragraph({
          type: "link",
          href: "https://e.com",
          title: undefined,
          children: [text("^x")],
        }),
      ),
    );
  });

  it("reads character references and escapes in an undefined footnote reference", () => {
    expect(parseMarkdown("[^a&amp;b]")).toEqual(blocks(paragraph(text("[^a&b]"))));
    expect(parseMarkdown("[^a\\*]")).toEqual(blocks(paragraph(text("[^a"), text("*"), text("]"))));
  });

  it("knows a definition that comes after a reference inside a footnote and a list", () => {
    expect(parseMarkdown("- x[^a]\n\n[^a]: A with [^b].\n[^b]: B.")).toEqual({
      blocks: [
        {
          type: "list",
          start: undefined,
          loose: false,
          items: [{ children: [paragraph(text("x"), reference(1))] }],
        },
      ],
      footnotes: [
        {
          number: 1,
          children: [paragraph(text("A with "), reference(2), text("."), backReference(1))],
        },
        { number: 2, children: [paragraph(text("B."), backReference(2))] },
      ],
    });
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
          { type: "link", href: "/docs/a:b", title: undefined, children: [text("a")] },
          text(" "),
          { type: "link", href: "#top", title: undefined, children: [text("b")] },
          text(" "),
          { type: "link", href: "?q=a:b", title: undefined, children: [text("c")] },
          text(" "),
          { type: "link", href: "mailto:me@example.com", title: undefined, children: [text("d")] },
          text(" "),
          { type: "link", href: "HTTP://example.com", title: undefined, children: [text("e")] },
        ),
      ),
    );
  });

  it("keeps a title on a link and an image, with its references decoded", () => {
    expect(parseMarkdown('[a](/a "T &amp; \\" x") ![b](/b.png \'tt\')')).toEqual(
      blocks(
        paragraph(
          { type: "link", href: "/a", title: 'T & " x', children: [text("a")] },
          text(" "),
          { type: "image", src: "/b.png", alt: "b", title: "tt" },
        ),
      ),
    );
  });

  it("takes the title of a link from its definition", () => {
    expect(parseMarkdown('[a][r]\n\n[r]: /a "Title"')).toEqual(
      blocks(paragraph({ type: "link", href: "/a", title: "Title", children: [text("a")] })),
    );
  });

  it("keeps the ampersands of an autolink as written", () => {
    expect(parseMarkdown("<https://e.com/?a=1&amp;b=2> https://e.com/?c=1&amp;d")).toEqual(
      blocks(
        paragraph(
          {
            type: "link",
            href: "https://e.com/?a=1&amp;b=2",
            title: undefined,
            children: [text("https://e.com/?a=1&amp;b=2")],
          },
          text(" "),
          {
            type: "link",
            href: "https://e.com/?c=1&amp;d",
            title: undefined,
            children: [text("https://e.com/?c=1&amp;d")],
          },
        ),
      ),
    );
  });

  it.each([
    ["[x](<https://example.com/a\\b>)", "https://example.com/a%5Cb"],
    ["[x](https://e.com/a&#10;b)", "https://e.com/a%0Ab"],
    ["[x](https://e.com/caf%C3%A9)", "https://e.com/caf%C3%A9"],
    ["[x](https://e.com/café)", "https://e.com/caf%C3%A9"],
    ["[x](<https://e.com/a b>)", "https://e.com/a%20b"],
    ["[x](https://e.com/100%)", "https://e.com/100%25"],
    ["[x](https://e.com/%zz%4)", "https://e.com/%zz%254"],
    ["[x](https://e.com/&#x1F600;)", "https://e.com/%F0%9F%98%80"],
    ["[x](https://e.com/a&#xD800;b)", "https://e.com/a%EF%BF%BDb"],
    ["[x](https://e.com/?q=a:b&r=(c)#d)", "https://e.com/?q=a:b&r=(c)#d"],
  ])("percent-encodes the address in %s", (markdown, href) => {
    expect(parseMarkdown(markdown)).toEqual(
      blocks(paragraph({ type: "link", href, title: undefined, children: [text("x")] })),
    );
  });

  it("percent-encodes the address of an image and of an autolink", () => {
    expect(parseMarkdown("![a](</a b.png>) <https://e.com/\\x>")).toEqual(
      blocks(
        paragraph({ type: "image", src: "/a%20b.png", alt: "a", title: undefined }, text(" "), {
          type: "link",
          href: "https://e.com/%5Cx",
          title: undefined,
          children: [text("https://e.com/\\x")],
        }),
      ),
    );
  });

  it("encodes a lone surrogate in an address, as a replacement character", () => {
    expect(parseMarkdown("[x](/a\uD800b)")).toEqual(
      blocks(
        paragraph({ type: "link", href: "/a%EF%BF%BDb", title: undefined, children: [text("x")] }),
      ),
    );
  });

  it("checks the scheme after the address is normalized", () => {
    expect(parseMarkdown("[x](java&#9;script:alert(1))")).toEqual(blocks(paragraph(text("x"))));
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

  it("replaces control characters written as numbers by the replacement character", () => {
    expect(parseMarkdown("&#128; &#x9f; &#8; &#127; &#xFDD0; &#xFFFE; &#x1FFFF; &#9;")).toEqual(
      blocks(paragraph(text("\uFFFD \uFFFD \uFFFD \uFFFD \uFFFD \uFFFD \uFFFD \t"))),
    );
  });

  it("decodes a reference once", () => {
    expect(parseMarkdown("&#38;#35; &amp;amp;")).toEqual(blocks(paragraph(text("&#35; &amp;"))));
  });

  it("shows a reference shaped like markup as the text it is", () => {
    expect(parseMarkdown("&<img src=x onerror=alert(1)>; and &a<b;")).toEqual(
      blocks(paragraph(text("&"), text("<img src=x onerror=alert(1)>"), text("; and &a<b;"))),
    );
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
        paragraph({ type: "link", href: "/a", title: undefined, children: [text("&")] }),
      ),
    );
  });

  it("decodes references in a link address and an image's address and alt text", () => {
    expect(parseMarkdown("[a](/?x=1&amp;y=2) ![&lt;b&gt;](/i.png?x=1&amp;y=2)")).toEqual(
      blocks(
        paragraph(
          { type: "link", href: "/?x=1&y=2", title: undefined, children: [text("a")] },
          text(" "),
          {
            type: "image",
            src: "/i.png?x=1&y=2",
            alt: "<b>",
            title: undefined,
          },
        ),
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
      blocks: [paragraph(text("a"), reference(1))],
      footnotes: [{ number: 1, children: [paragraph(text("One."), backReference(1))] }],
    });
  });
});

/**
 * The time limit of each worst-case input below. It sits far from both kinds
 * of parser:
 *
 * - A linear parser takes 3 to 110 ms per input on a laptop, and doubling an
 *   input about doubles its time. The slowest run seen on a loaded CI machine
 *   took 1.05 s, a fifth of the limit.
 * - A quadratic parser takes 14.5 s on the unterminated comment on a laptop,
 *   three times the limit: trimming its newlines with `/\n+$/` did that.
 */
const WORST_CASE_TIME_LIMIT_MS = 5000;

// These tests are skipped. They measure wall-clock time, so a busy machine can
// fail them with no change to the parser, and each run costs seconds. They
// found the slow paths while the footnote parser was being built, and every
// one is fixed. Run them by hand, by removing `.skip`, after changing how
// `parseMarkdown` reads its input or after upgrading `marked`.
describe.skip("parseMarkdown worst-case input", () => {
  it("parses an unterminated HTML comment followed by many blank lines in linear time", () => {
    const started = performance.now();
    parseMarkdown(`<!--${"\n".repeat(200_000)}x`);
    expect(performance.now() - started).toBeLessThan(WORST_CASE_TIME_LIMIT_MS);
  });

  it("parses a long run of footnote-like brackets in linear time", () => {
    const started = performance.now();
    parseMarkdown("[^".repeat(100_000));
    expect(performance.now() - started).toBeLessThan(WORST_CASE_TIME_LIMIT_MS);
  });

  it("parses many definitions and many references in linear time", () => {
    const started = performance.now();
    parseMarkdown("[^a]: x\n".repeat(20_000) + "[^a] ".repeat(20_000));
    expect(performance.now() - started).toBeLessThan(WORST_CASE_TIME_LIMIT_MS);
  });

  it("parses a definition with many lazy continuation lines in linear time", () => {
    // The lines become one paragraph, and marked's own paragraph pattern hangs in
    // Bun on Linux somewhere between 20,000 and 50,000 lines, even with no
    // footnote. The apps run on V8, which has no such limit. 20,000 lines still
    // take seconds if reading the definition costs more than linear time.
    const started = performance.now();
    parseMarkdown(`[^a]: first\n${"lazy\n".repeat(20_000)}`);
    expect(performance.now() - started).toBeLessThan(WORST_CASE_TIME_LIMIT_MS);
  });

  it("parses many paragraphs cut by headings, with no definition, in linear time", () => {
    const started = performance.now();
    parseMarkdown("a\n# h\n".repeat(50_000));
    expect(performance.now() - started).toBeLessThan(WORST_CASE_TIME_LIMIT_MS);
  });
});
