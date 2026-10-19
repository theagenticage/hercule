/**
 * Tests `parseMarkdown`, which turns the markdown in a message into the tree
 * both apps draw. Each test gives a small input and the whole tree it parses to.
 */
import { findSkillReferences } from "@hercule/contract";
import { describe, expect, it } from "vitest";
import {
  MAX_MARKDOWN_NESTING,
  MarkdownTooDeepError,
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

/** A table cell of one column, as a markdown table makes it. */
const cell = (children: MarkdownInline[], align: ColumnAlignment): MarkdownTableCell => ({
  children,
  columnSpan: 1,
  align,
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

  it("ends an indented code block's text without the line break after its last line", () => {
    expect(parseMarkdown("    a\n")).toEqual(blocks({ type: "code", text: "a" }));
    expect(parseMarkdown("    a\n\n      b\n")).toEqual(blocks({ type: "code", text: "a\n\n  b" }));
    expect(parseMarkdown("    a\n    \n")).toEqual(blocks({ type: "code", text: "a" }));
    expect(parseMarkdown("- a\n\n      code\n")).toEqual(
      blocks({
        type: "list",
        start: undefined,
        loose: true,
        items: [{ children: [paragraph(text("a")), { type: "code", text: "code" }] }],
      }),
    );
  });

  it("keeps a blank last line of a fenced code block as part of its text", () => {
    expect(parseMarkdown("```\na\n```\n")).toEqual(blocks({ type: "code", text: "a" }));
    expect(parseMarkdown("```\na\n\n```")).toEqual(blocks({ type: "code", text: "a\n" }));
    expect(parseMarkdown("<pre>a\n\n</pre>")).toEqual(blocks({ type: "code", text: "a" }));
  });

  it("parses a table with the alignment of each column", () => {
    expect(parseMarkdown("| a | b | c | d |\n|:--|:-:|--:|---|\n| 1 | 2 | 3 | **4** |")).toEqual(
      blocks({
        type: "table",
        header: [
          cell([text("a")], "left"),
          cell([text("b")], "center"),
          cell([text("c")], "right"),
          cell([text("d")], undefined),
        ],
        rows: [
          [
            cell([text("1")], "left"),
            cell([text("2")], "center"),
            cell([text("3")], "right"),
            cell([{ type: "strong", children: [text("4")] }], undefined),
          ],
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
      blocks(paragraph(text("[^a]: note\nIMPORTANT WARNING"))),
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
    expect(parseMarkdown("[^a\\*]")).toEqual(blocks(paragraph(text("[^a*]"))));
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

describe("parseMarkdown texts side by side", () => {
  it("joins the texts that escapes and brackets split, at every depth", () => {
    expect(parseMarkdown("a\\*b **c\\*d [e\\*f](/g)** ~~h\\]i~~")).toEqual(
      blocks(
        paragraph(
          text("a*b "),
          {
            type: "strong",
            children: [
              text("c*d "),
              { type: "link", href: "/g", title: undefined, children: [text("e*f")] },
            ],
          },
          text(" "),
          { type: "strikethrough", children: [text("h]i")] },
        ),
      ),
    );
  });

  it("joins texts in a table cell, a details summary and a footnote", () => {
    expect(
      parseMarkdown(
        "| a\\*b |\n|---|\n| c\\*d |\n\n<details><summary>e<span>f</span></summary>\n\ng\n\n</details>\n\nx[^1]\n\n[^1]: h\\*i",
      ),
    ).toEqual({
      blocks: [
        {
          type: "table",
          header: [cell([text("a*b")], undefined)],
          rows: [[cell([text("c*d")], undefined)]],
        },
        { type: "details", summary: [text("ef")], children: [paragraph(text("g"))] },
        paragraph(text("x"), reference(1)),
      ],
      footnotes: [{ number: 1, children: [paragraph(text("h*i"), backReference(1))] }],
    });
  });

  it("does not join texts across a break, inline code or a footnote reference", () => {
    expect(parseMarkdown("a\\*  \nb`c`d[^1]e\n\n[^1]: f")).toEqual({
      blocks: [
        paragraph(
          text("a*"),
          { type: "break" },
          text("b"),
          { type: "inlineCode", text: "c" },
          text("d"),
          reference(1),
          text("e"),
        ),
      ],
      footnotes: [{ number: 1, children: [paragraph(text("f"), backReference(1))] }],
    });
  });
});

describe("parseMarkdown with embeddedHtml off", () => {
  it("shows a block of HTML as the text of a paragraph", () => {
    expect(
      parseMarkdown("<form><input type=password></form>\n\nafter", { embeddedHtml: false }),
    ).toEqual(
      blocks(paragraph(text("<form><input type=password></form>")), paragraph(text("after"))),
    );
  });

  it("shows HTML inside a line as text, without decoding it", () => {
    expect(parseMarkdown('a <b title="&amp;">bold</b> c', { embeddedHtml: false })).toEqual(
      blocks(paragraph(text('a <b title="&amp;">bold</b> c'))),
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
    expect(parseMarkdown("a![](javascript:alert(1))b")).toEqual(blocks(paragraph(text("ab"))));
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
    expect(
      parseMarkdown("&<img src=x onerror=alert(1)>; and &a<b;", { embeddedHtml: false }),
    ).toEqual(blocks(paragraph(text("&<img src=x onerror=alert(1)>; and &a<b;"))));
  });

  it("decodes references in a heading, a table cell and a link's text", () => {
    expect(parseMarkdown("# a &lt; b\n\n| x |\n|---|\n| &gt; |\n\n[&amp;](/a)")).toEqual(
      blocks(
        { type: "heading", depth: 1, children: [text("a < b")] },
        {
          type: "table",
          header: [cell([text("x")], undefined)],
          rows: [[cell([text(">")], undefined)]],
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
    expect(parseMarkdown("\\&amp;")).toEqual(blocks(paragraph(text("&amp;"))));
  });
});

describe("parseMarkdown deep nesting", () => {
  it("refuses a tree that nests deeper than MAX_MARKDOWN_NESTING levels, by the rule and not the stack", () => {
    // 98 quotes, a paragraph and its text are 100 levels; one quote more is 101.
    expect(parseMarkdown(`${">".repeat(98)} x`).blocks).toHaveLength(1);
    expect(() => parseMarkdown(`${">".repeat(99)} x`)).toThrow(MarkdownTooDeepError);
    const lists = (depth: number) =>
      Array.from({ length: depth }, (_, level) => `${"  ".repeat(level)}- x`).join("\n");
    // A list and its item are two levels each.
    expect(parseMarkdown(lists(49)).blocks).toHaveLength(1);
    expect(() => parseMarkdown(lists(50))).toThrow(MarkdownTooDeepError);
    expect(MAX_MARKDOWN_NESTING).toBe(100);
  });

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

describe("parseMarkdown skill references", () => {
  const skill = (name: string): MarkdownInline => ({ type: "skill", name });
  const NAMES: ReadonlySet<string> = new Set(["review", "webshop:release"]);
  const parse = (source: string, options: { breaks?: boolean } = {}) =>
    parseMarkdown(source, { embeddedHtml: false, skillNames: NAMES, ...options });

  it("turns a reference to a listed skill into a skill node and leaves the rest as text", () => {
    expect(parse("please $review this")).toEqual(
      blocks(paragraph(text("please "), skill("review"), text(" this"))),
    );
  });

  it("finds several references, library and repository skills", () => {
    expect(parse("$review then $webshop:release, then $review")).toEqual(
      blocks(
        paragraph(
          skill("review"),
          text(" then "),
          skill("webshop:release"),
          text(", then "),
          skill("review"),
        ),
      ),
    );
  });

  it("keeps a trailing colon as text", () => {
    expect(parse("$review: now")).toEqual(blocks(paragraph(skill("review"), text(": now"))));
  });

  it("leaves a name that is not listed as text, so a typo or a deleted skill stays text", () => {
    expect(parse("$reveiw this")).toEqual(blocks(paragraph(text("$reveiw this"))));
  });

  it("makes no skill node without the option", () => {
    expect(parseMarkdown("$review", { embeddedHtml: false })).toEqual(
      blocks(paragraph(text("$review"))),
    );
    expect(parseMarkdown("$review", { skillNames: new Set() })).toEqual(
      blocks(paragraph(text("$review"))),
    );
  });

  it("leaves inline code and fenced code blocks alone", () => {
    expect(parse("run `$review` now")).toEqual(
      blocks(paragraph(text("run "), { type: "inlineCode", text: "$review" }, text(" now"))),
    );
    expect(parse("```\n$review\n```")).toEqual(blocks({ type: "code", text: "$review" }));
    expect(parse("    $review")).toEqual(blocks({ type: "code", text: "$review" }));
  });

  it("finds a reference at the start of a line after a line break", () => {
    expect(parse("first\n$review", { breaks: true })).toEqual(
      blocks(paragraph(text("first"), { type: "break" }, skill("review"))),
    );
    expect(parse("first\n$review")).toEqual(blocks(paragraph(text("first\n"), skill("review"))));
  });

  it("finds a reference in every paragraph, heading, list item, quote and table cell", () => {
    expect(parse("# $review\n\n- $review\n\n> $review\n\n| a |\n| - |\n| $review |")).toEqual(
      blocks(
        { type: "heading", depth: 1, children: [skill("review")] },
        {
          type: "list",
          start: undefined,
          loose: false,
          items: [{ children: [paragraph(skill("review"))] }],
        },
        { type: "blockquote", children: [paragraph(skill("review"))] },
        {
          type: "table",
          header: [cell([text("a")], undefined)],
          rows: [[cell([skill("review")], undefined)]],
        },
      ),
    );
  });

  it("finds a reference after whitespace inside emphasis, strong text and strikethrough", () => {
    expect(parse("*use $review*")).toEqual(
      blocks(paragraph({ type: "emphasis", children: [text("use "), skill("review")] })),
    );
    expect(parse("**use $review** and ~~use $review~~")).toEqual(
      blocks(
        paragraph({ type: "strong", children: [text("use "), skill("review")] }, text(" and "), {
          type: "strikethrough",
          children: [text("use "), skill("review")],
        }),
      ),
    );
  });

  it("finds a reference right after a closing mark when whitespace follows it", () => {
    expect(parse("**a** $review")).toEqual(
      blocks(paragraph({ type: "strong", children: [text("a")] }, text(" "), skill("review"))),
    );
  });

  it("finds no reference where the source has a mark right before the $", () => {
    // The runner reads the source, where `*` or a closing mark is not whitespace.
    expect(parse("*$review*")).toEqual(
      blocks(paragraph({ type: "emphasis", children: [text("$review")] })),
    );
    expect(parse("**a**$review")).toEqual(
      blocks(paragraph({ type: "strong", children: [text("a")] }, text("$review"))),
    );
    expect(parse("`a`$review")).toEqual(
      blocks(paragraph({ type: "inlineCode", text: "a" }, text("$review"))),
    );
  });

  it("finds no reference whose characters the source wrote as a character reference or an escape", () => {
    // The runner reads the source, where `&#36;review` and `\\$review` hold no `$`.
    expect(parse("&#36;review and $review")).toEqual(
      blocks(paragraph(text("$review and "), skill("review"))),
    );
    expect(parse("&dollar;review")).toEqual(blocks(paragraph(text("$review"))));
    expect(parse("\\$review and $review")).toEqual(
      blocks(paragraph(text("$review and "), skill("review"))),
    );
    expect(parse("$re&#118;iew and a&#32;$review")).toEqual(
      blocks(paragraph(text("$review and a $review"))),
    );
  });

  it("finds a reference beside a character reference that is not part of it", () => {
    expect(parse("Tom &amp; Jerry: $review")).toEqual(
      blocks(paragraph(text("Tom & Jerry: "), skill("review"))),
    );
    expect(parse("$review&#33; $review\\!")).toEqual(
      blocks(paragraph(skill("review"), text("! "), skill("review"), text("!"))),
    );
  });

  it("applies the same rule inside embedded HTML", () => {
    const parseHtml = (source: string) => parseMarkdown(source, { skillNames: NAMES }).blocks[0];
    expect(parseHtml("<b>&#36;review</b> and $review")).toEqual(
      paragraph({ type: "strong", children: [text("$review")] }, text(" and "), skill("review")),
    );
  });

  it("finds no reference in HTML text that the source wrote as a character reference", () => {
    const parseHtml = (source: string) => parseMarkdown(source, { skillNames: NAMES }).blocks[0];
    // Only the second `$review` is written in the source.
    expect(parseHtml("<span>&#36;review</span> $review")).toEqual(
      paragraph(text("$review "), skill("review")),
    );
    expect(parseHtml("<span>&dollar;review</span> $review")).toEqual(
      paragraph(text("$review "), skill("review")),
    );
    expect(parseHtml("<span>$re&#118;iew</span> a&#32;$review <i>x</i>")).toEqual(
      paragraph(text("$review a $review "), { type: "emphasis", children: [text("x")] }),
    );
    expect(parseHtml("<p>&#36;review $review</p>")).toEqual(
      paragraph(text("$review "), skill("review")),
    );
  });

  it("finds no reference in an HTML text whose white space is trimmed or collapsed", () => {
    const parseHtml = (source: string) => parseMarkdown(source, { skillNames: NAMES }).blocks[0];
    expect(parseHtml("<div>  &#36;review</div>")).toEqual(paragraph(text("$review")));
    expect(parseHtml("<b>x </b>&#32;&#36;review $review")).toEqual(
      paragraph({ type: "strong", children: [text("x ")] }, text(" $review "), skill("review")),
    );
  });

  it("finds no reference in a character reference or an escape that sits among HTML", () => {
    const parseHtml = (source: string) => parseMarkdown(source, { skillNames: NAMES }).blocks[0];
    expect(parseHtml("<span>\\$review</span> $review")).toEqual(
      paragraph(text("$review "), skill("review")),
    );
  });

  it("finds no reference in the alt text of an image that is not shown", () => {
    const parseHtml = (source: string) => parseMarkdown(source, { skillNames: NAMES }).blocks[0];
    expect(parseHtml('<img src="javascript:x" alt="&#36;review">')).toEqual(
      paragraph(text("$review")),
    );
    expect(parseHtml('<img src="javascript:x" alt="$review">')).toEqual(paragraph(text("$review")));
    expect(parse("![$review](javascript:x)")).toEqual(blocks(paragraph(text("$review"))));
  });

  it("keeps link text as text, because a link is clickable already", () => {
    expect(parse("[use $review](https://example.com)")).toEqual(
      blocks(
        paragraph({
          type: "link",
          href: "https://example.com",
          title: undefined,
          children: [text("use $review")],
        }),
      ),
    );
  });

  // The runner scans the raw message and accepts a `$name` only after whitespace or at the
  // start. The parser removes and rewrites characters (`>`, tags, entities), so the tree is
  // not where to look for the reference. A chip must appear exactly where the raw scan found one.
  it.each([
    { source: "$review\n\n>$review", chips: 1 },
    { source: "> $review", chips: 1 },
    { source: "> $review\n>$review", chips: 1 },
    { source: "> a\n>$review", chips: 0 },
    { source: "|$review|", chips: 0 },
    { source: "| a |\n| - |\n|$review|", chips: 0 },
    { source: "| a |\n| - |\n| $review |", chips: 1 },
    { source: "<p>$review</p>", chips: 0 },
    { source: "<p> $review</p>", chips: 1 },
    { source: "a<br>$review", chips: 0 },
    { source: "a<br> $review", chips: 1 },
    { source: "a <b>x</b>$review", chips: 0 },
    { source: "<details><summary>$review</summary>x</details>", chips: 0 },
    { source: "<table><tr><td>$review</td></tr></table>", chips: 0 },
    { source: "<div>\n\n$review\n\n</div>", chips: 1 },
    { source: "x[^a]\n\n[^a]:$review", chips: 0 },
    { source: "x[^a]\n\n[^a]: $review", chips: 1 },
    { source: "&#36;review", chips: 0 },
    { source: "a &#36;review $review", chips: 1 },
    { source: "\\$review", chips: 0 },
    { source: "`$review`", chips: 0 },
    { source: "$other", chips: 0 },
    { source: "$review $other", chips: 1 },
  ])("draws the chips the raw scan finds in $source", ({ source, chips }) => {
    const names: ReadonlySet<string> = new Set(["review"]);
    const scanned = findSkillReferences(source).filter(({ name }) => names.has(name)).length;
    const drawn =
      JSON.stringify(parseMarkdown(source, { skillNames: names })).split('"type":"skill"').length -
      1;
    expect(scanned).toBe(chips);
    expect(drawn).toBe(scanned);
  });

  // The raw scan finds these references, but an address is never a chip: it must come out as it
  // does when no skill exists. `$` is kept and the space becomes `%20`.
  it.each([
    { source: "[x]( $review)", address: "$review" },
    { source: '<a href="x $review">y</a>', address: "x%20$review" },
    { source: "![i]( $review)", address: "$review" },
  ])("keeps a reference in the address of $source as the dollar sign", ({ source, address }) => {
    const tree = JSON.stringify(parseMarkdown(source, { skillNames: NAMES }));
    expect(tree).toBe(JSON.stringify(parseMarkdown(source, { skillNames: new Set() })));
    expect(tree).toContain(`"${address}"`);
  });

  // A name followed by an entity or an escape that stands for a name character is longer in the
  // tree than in the raw message, so the reference stays text instead of a chip for the wrong skill.
  it.each([
    { source: "$rev&#105;ew", chips: 0 },
    { source: "$rev\\-ew", chips: 0 },
    { source: "$rev ew", chips: 1 },
    { source: "$review&#33;", chips: 1 },
    { source: "$rev\\!ew", chips: 1 },
  ])(
    "draws $chips chips for $source when rev, review and rev-ew are skills",
    ({ source, chips }) => {
      const names: ReadonlySet<string> = new Set(["rev", "review", "rev-ew"]);
      const tree = JSON.stringify(parseMarkdown(source, { skillNames: names }));
      expect(tree.split('"type":"skill"').length - 1).toBe(chips);
      expect(tree).not.toContain("\uE000");
    },
  );

  it("shows no private-use mark in the tree, wherever a reference is not a chip", () => {
    const tree = JSON.stringify(
      parseMarkdown(
        "![ $review](https://e.com/a.png) [ $review](https://e.com/ $review) `$review` $nope\n\n    $review",
        { skillNames: NAMES },
      ),
    );
    expect(tree).not.toContain("\uE000");
    expect(tree).toContain("$nope");
  });

  it("draws no chip in a message that already holds the private-use mark", () => {
    expect(parseMarkdown("\uE000review $review", { skillNames: NAMES })).toEqual(
      blocks(paragraph(text("\uE000review $review"))),
    );
  });

  it("finds a reference in a footnote's text", () => {
    expect(parse("a[^1]\n\n[^1]: use $review")).toEqual({
      blocks: [
        paragraph(text("a"), { type: "footnoteReference", number: 1, isFirstReference: true }),
      ],
      footnotes: [
        {
          number: 1,
          children: [
            paragraph(text("use "), skill("review"), { type: "footnoteBackReference", number: 1 }),
          ],
        },
      ],
    });
  });
});
