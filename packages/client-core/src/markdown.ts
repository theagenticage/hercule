/**
 * Parses the markdown in a message into a small tree of plain data, which
 * each app draws as React elements in its own look.
 *
 * The tree holds only the elements both apps know how to draw, so it is safe
 * to draw by construction:
 *
 * - Raw HTML is kept as text: `<form>` in an agent's message shows those
 *   characters, never a form.
 * - A link or an image whose address is unsafe, such as `javascript:`, is not
 *   in the tree. A link keeps its text, and an image keeps its alt text.
 * - Character references are decoded, so `AT&amp;T` reads `AT&T`.
 * - Link and image addresses are percent-encoded, so an address never holds a
 *   space, a quote or a backslash.
 */

import { decodeNamedCharacterReference } from "decode-named-character-reference";
import { Marked, type MarkedExtension, type MarkedToken, type Token, type Tokens } from "marked";

/** The alignment a table's delimiter row sets for a column, or undefined when it sets none. */
export type ColumnAlignment = "left" | "center" | "right" | undefined;

/** A block of a message: a paragraph, a heading, a list, a quote, a code block, a table or a rule. */
export type MarkdownBlock =
  | { readonly type: "paragraph"; readonly children: ReadonlyArray<MarkdownInline> }
  | {
      readonly type: "heading";
      readonly depth: 1 | 2 | 3 | 4 | 5 | 6;
      readonly children: ReadonlyArray<MarkdownInline>;
    }
  | {
      readonly type: "list";
      /** The first item's number in a numbered list, or undefined in a bulleted list. */
      readonly start: number | undefined;
      /**
       * Whether blank lines separate the items. In a tight list, an item's
       * paragraphs are drawn as bare text, with no paragraph spacing.
       */
      readonly loose: boolean;
      readonly items: ReadonlyArray<MarkdownListItem>;
    }
  | { readonly type: "blockquote"; readonly children: ReadonlyArray<MarkdownBlock> }
  /** A fenced or indented code block. Its text is exactly as written, with no trailing newline. */
  | { readonly type: "code"; readonly text: string }
  | {
      readonly type: "table";
      /** One alignment per column. */
      readonly align: ReadonlyArray<ColumnAlignment>;
      /** The header row's cells, then the body rows' cells, each a run of inlines. */
      readonly header: ReadonlyArray<ReadonlyArray<MarkdownInline>>;
      readonly rows: ReadonlyArray<ReadonlyArray<ReadonlyArray<MarkdownInline>>>;
    }
  | { readonly type: "rule" };

/**
 * An item of a list. A task item's box is a `checkbox` inline at the start of
 * the item's first paragraph.
 */
export interface MarkdownListItem {
  readonly children: ReadonlyArray<MarkdownBlock>;
}

/** An inline element: text, its markup, a link, an image or a footnote's mark. */
export type MarkdownInline =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "strong" | "emphasis" | "strikethrough";
      readonly children: ReadonlyArray<MarkdownInline>;
    }
  | { readonly type: "inlineCode"; readonly text: string }
  | { readonly type: "break" }
  /**
   * A link whose address passed the safety check: relative, or a safe scheme.
   * The address is percent-encoded, and `title` is the tooltip it was written with.
   */
  | {
      readonly type: "link";
      readonly href: string;
      readonly title: string | undefined;
      readonly children: ReadonlyArray<MarkdownInline>;
    }
  /** An image whose address passed the same check as a link's, encoded the same way. */
  | {
      readonly type: "image";
      readonly src: string;
      readonly alt: string;
      readonly title: string | undefined;
    }
  /** A task item's box, ticked or not. It is drawn read-only. */
  | { readonly type: "checkbox"; readonly checked: boolean }
  /**
   * A reference to the footnote with the same number. The footnote's back
   * reference returns to its first reference, the one with `isFirstReference`.
   */
  | {
      readonly type: "footnoteReference";
      readonly number: number;
      readonly isFirstReference: boolean;
    }
  /** The link at the end of a footnote back to the footnote's first reference. */
  | { readonly type: "footnoteBackReference"; readonly number: number };

/**
 * A footnote, numbered by the order in which the message first shows a
 * reference to it. Its last paragraph ends with a `footnoteBackReference`.
 */
export interface MarkdownFootnote {
  readonly number: number;
  readonly children: ReadonlyArray<MarkdownBlock>;
}

/** A parsed message: its blocks, then the footnotes it references, in number order. */
export interface MarkdownDocument {
  readonly blocks: ReadonlyArray<MarkdownBlock>;
  /** Empty when the message references no footnote. A footnote no reference names is left out. */
  readonly footnotes: ReadonlyArray<MarkdownFootnote>;
}

/** A footnote definition, `[^label]: text`, as the footnote extension lexes it. */
interface FootnoteDefinitionToken extends Tokens.Generic {
  type: "footnoteDefinition";
  /** The label as written, such as `Note 1`. */
  label: string;
  /** The blocks of the footnote's text. */
  content: Token[];
}

/** A footnote reference, `[^label]`, as the footnote extension lexes it. It does not check that a definition exists. */
interface FootnoteReferenceToken extends Tokens.Generic {
  type: "footnoteReference";
  /** The label as written, such as `Note 1`. */
  label: string;
}

const isFootnoteDefinitionToken = (token: Token): token is FootnoteDefinitionToken =>
  token.type === "footnoteDefinition";

const isFootnoteReferenceToken = (token: Token): token is FootnoteReferenceToken =>
  token.type === "footnoteReference";

/**
 * Matches a footnote definition at the start of a block: the label, then the
 * rest of the first line, then any lines indented by 4 spaces or a tab (blank
 * lines may come before them). The label is at most 999 characters, as in
 * marked's own link labels, so that a line of `[^[^[^` fails in constant time
 * at each `[` instead of scanning to the end of the line each time.
 *
 * Adapted from the definition pattern of the `marked-footnote` package (MIT).
 */
const FOOTNOTE_DEFINITION =
  /^\[\^([^\]\n]{1,999})\]:(?:[ \t]+|\n*?|$)([^\n]*?(?:\n|$)(?:\n*?[ ]{4,}[^\n]*)*)/;

/** Matches a footnote reference at the start of the inline text. */
const FOOTNOTE_REFERENCE = /^\[\^([^\]\n]{1,999})\]/;

/**
 * Teaches marked to lex footnote definitions and references. The extension
 * keeps no state and does not know which definitions exist, so one parser can
 * serve every call. `mapDocument` decides which references have a definition.
 */
const footnoteExtension: MarkedExtension = {
  extensions: [
    {
      name: "footnoteDefinition",
      level: "block",
      tokenizer(source) {
        const match = FOOTNOTE_DEFINITION.exec(source);
        if (match === null) return undefined;
        const [raw, label = "", text = ""] = match;
        const unindented = text
          .split("\n")
          .map((line) => line.replace(/^(?: {4}|\t)/, ""))
          .join("\n");
        const token: FootnoteDefinitionToken = {
          type: "footnoteDefinition",
          raw,
          label,
          content: this.lexer.blockTokens(unindented),
        };
        return token;
      },
    },
    {
      name: "footnoteReference",
      level: "inline",
      tokenizer(source) {
        const match = FOOTNOTE_REFERENCE.exec(source);
        if (match === null) return undefined;
        const token: FootnoteReferenceToken = {
          type: "footnoteReference",
          raw: match[0],
          label: match[1] ?? "",
        };
        return token;
      },
    },
  ],
};

/** Creates a GitHub-flavoured markdown parser with footnotes. */
const createParser = (breaks: boolean): Marked =>
  new Marked({ gfm: true, breaks }, footnoteExtension);

// Two parsers, made once. They keep no state between calls.
const parserWithBreaks = createParser(true);
const parserWithoutBreaks = createParser(false);

/**
 * Matches one character reference as CommonMark defines it: a decimal one of 1
 * to 7 digits, a hexadecimal one of 1 to 6 digits, or a name of at most 32
 * letters and digits.
 */
const CHARACTER_REFERENCE =
  /&(?:#([0-9]{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{0,31}));/g;

/** The character CommonMark uses for a code point that is not a valid character. */
const REPLACEMENT_CHARACTER = "�";

/**
 * Checks whether a code point written as `&#...;` is a valid character.
 * Control characters, surrogates, noncharacters and code points past U+10FFFF
 * are not, which is the rule of the `micromark` parser behind react-markdown.
 */
const isValidCodePoint = (codePoint: number): boolean =>
  !(
    codePoint < 9 ||
    codePoint === 11 ||
    (codePoint > 13 && codePoint < 32) ||
    (codePoint > 126 && codePoint < 160) ||
    (codePoint > 0xd7ff && codePoint < 0xe000) ||
    (codePoint > 0xfdcf && codePoint < 0xfdf0) ||
    codePoint % 0x10000 >= 0xfffe ||
    codePoint > 0x10ffff
  );

/**
 * Returns `text` with its character references replaced by the characters
 * they stand for, as CommonMark requires: `AT&amp;T` becomes `AT&T`. A name
 * that does not exist, such as `&foo;`, stays as written. A number that is not
 * a valid character becomes U+FFFD.
 *
 * Only a name that matched `CHARACTER_REFERENCE` reaches
 * `decodeNamedCharacterReference`. The package's browser build decodes by
 * writing `&name;` into the `innerHTML` of a detached element, so the name must
 * never carry markup.
 */
const decodeCharacterReferences = (text: string): string =>
  text.replace(
    CHARACTER_REFERENCE,
    (match, decimal?: string, hexadecimal?: string, name?: string) => {
      if (name !== undefined) return decodeNamedCharacterReference(name) || match;
      const codePoint = decimal !== undefined ? Number(decimal) : parseInt(hexadecimal ?? "", 16);
      return isValidCodePoint(codePoint) ? String.fromCodePoint(codePoint) : REPLACEMENT_CHARACTER;
    },
  );

/**
 * Matches what `normalizeAddress` must encode: a `%` that does not start a
 * percent-escape, and every character except ASCII letters, digits and
 * ``!#$%&'()*+,-./:;=?@_~``. The `u` flag makes a surrogate pair one match.
 */
const ADDRESS_CHARACTER_TO_ENCODE = /%(?![0-9A-Za-z]{2})|[^0-9A-Za-z!#$%&'()*+,\-./:;=?@_~]/gu;

/**
 * Returns `address` with every character that a URL should not hold
 * percent-encoded, the way `micromark-util-sanitize-uri` does for
 * react-markdown. A `%` that starts a percent-escape is kept, so an address
 * that is already encoded is not encoded twice. A lone surrogate becomes
 * U+FFFD.
 */
const normalizeAddress = (address: string): string =>
  address.replace(ADDRESS_CHARACTER_TO_ENCODE, (character) => {
    if (character === "%") return "%25";
    const isLoneSurrogate =
      character.length === 1 && character >= "\uD800" && character <= "\uDFFF";
    return encodeURIComponent(isLoneSurrogate ? REPLACEMENT_CHARACTER : character);
  });

/** The schemes a link or an image may have besides none, the same list react-markdown allows. */
const SAFE_SCHEME = /^(https?|ircs?|mailto|xmpp)$/i;

/**
 * Checks whether a link or image address is safe to draw. It is safe when it
 * has no scheme (a relative address, a `?` or a `#` link) or when its scheme is
 * `http`, `https`, `irc`, `ircs`, `mailto` or `xmpp`. Any other scheme, such
 * as `javascript:`, is unsafe.
 *
 * This is react-markdown's `defaultUrlTransform`. It does not use `new URL`,
 * which throws on a relative address. Call it with the decoded and normalized
 * address, so that `javascript&#58;alert(1)` is caught.
 */
const isSafeAddress = (address: string): boolean => {
  const colon = address.indexOf(":");
  const endsOfPath = [address.indexOf("/"), address.indexOf("?"), address.indexOf("#")];
  return (
    colon === -1 ||
    endsOfPath.some((end) => end !== -1 && colon > end) ||
    SAFE_SCHEME.test(address.slice(0, colon))
  );
};

/**
 * Returns the title of a link or an image with its character references
 * decoded, or undefined when it has none. marked gives an empty string or null
 * for a missing title.
 */
const decodeTitle = (title: string | null | undefined): string | undefined =>
  title ? decodeCharacterReferences(title) : undefined;

/**
 * Returns the label with the spelling differences ignored that CommonMark
 * ignores in a link label: surrounding space, runs of whitespace, and case.
 * `[^Note  A]` and `[^note a]` are one label.
 */
const normalizeLabel = (label: string): string =>
  label.trim().replace(/\s+/g, " ").toLowerCase().toUpperCase();

/** Returns `text` without the line breaks at its end, in time linear in its length. */
const trimTrailingNewlines = (text: string): string => {
  let end = text.length;
  while (end > 0 && text[end - 1] === "\n") end--;
  return text.slice(0, end);
};

/** Returns the text that `inlines` show, without their markup. It is an image's alt text. */
const extractPlainText = (inlines: ReadonlyArray<MarkdownInline>): string =>
  inlines
    .map((inline) => {
      switch (inline.type) {
        case "text":
        case "inlineCode":
          return inline.text;
        case "image":
          return inline.alt;
        case "strong":
        case "emphasis":
        case "strikethrough":
        case "link":
          return extractPlainText(inline.children);
        case "break":
        case "checkbox":
        case "footnoteReference":
        case "footnoteBackReference":
          return "";
      }
    })
    .join("");

/**
 * What the mapping functions share while they walk one message: the footnotes
 * the message defines, and the ones its visible text has referenced so far.
 */
interface FootnoteNumbering {
  /** The first definition of each normalized label. */
  readonly definitions: ReadonlyMap<string, FootnoteDefinitionToken>;
  /** The referenced footnotes by normalized label, in the order of their numbers. */
  readonly numbered: Map<
    string,
    { readonly number: number; readonly definition: FootnoteDefinitionToken }
  >;
}

/**
 * Returns the node for a footnote reference. It is a numbered reference when
 * the message defines the footnote, and the reference's source text when not.
 * The first reference to a footnote gives it the next number.
 */
const mapFootnoteReference = (
  token: FootnoteReferenceToken,
  numbering: FootnoteNumbering,
): MarkdownInline[] => {
  const label = normalizeLabel(token.label);
  const definition = numbering.definitions.get(label);
  if (definition === undefined) return [{ type: "text", text: token.raw }];
  const earlier = numbering.numbered.get(label);
  const number = earlier?.number ?? numbering.numbered.size + 1;
  if (earlier === undefined) numbering.numbered.set(label, { number, definition });
  return [{ type: "footnoteReference", number, isFirstReference: earlier === undefined }];
};

/** Returns the nodes for a list of inline tokens. */
const mapInlines = (tokens: ReadonlyArray<Token>, numbering: FootnoteNumbering): MarkdownInline[] =>
  tokens.flatMap((token) => mapInline(token, numbering));

/**
 * Returns the nodes for one inline token. That is one node in most cases, and
 * the link's children for a link with an unsafe address. A kind of token this
 * function does not know becomes its source text.
 */
const mapInline = (token: Token, numbering: FootnoteNumbering): MarkdownInline[] => {
  if (isFootnoteReferenceToken(token)) return mapFootnoteReference(token, numbering);
  const known = token as MarkedToken;
  switch (known.type) {
    case "text":
      // The source is decoded here and not marked's `text`, which has already
      // decoded the numeric references: `&#38;#35;` would be decoded twice.
      return known.tokens
        ? mapInlines(known.tokens, numbering)
        : [{ type: "text", text: decodeCharacterReferences(known.raw) }];
    case "escape":
    case "html":
      // An escape holds the character already unescaped, and raw HTML is shown as written.
      return [{ type: "text", text: known.text }];
    case "strong":
      return [{ type: "strong", children: mapInlines(known.tokens, numbering) }];
    case "em":
      return [{ type: "emphasis", children: mapInlines(known.tokens, numbering) }];
    case "del":
      return [{ type: "strikethrough", children: mapInlines(known.tokens, numbering) }];
    case "codespan":
      return [{ type: "inlineCode", text: known.text }];
    case "br":
      return [{ type: "break" }];
    case "checkbox":
      return [{ type: "checkbox", checked: known.checked }];
    case "link": {
      // The address and text of an autolink or a bare URL are literal: no character references.
      const href = normalizeAddress(
        known.autolink ? known.href : decodeCharacterReferences(known.href),
      );
      const children: MarkdownInline[] = known.autolink
        ? [{ type: "text", text: known.text }]
        : mapInlines(known.tokens, numbering);
      return isSafeAddress(href)
        ? [{ type: "link", href, title: decodeTitle(known.title), children }]
        : children;
    }
    case "image": {
      const src = normalizeAddress(decodeCharacterReferences(known.href));
      // The alt text is plain text, so a footnote reference in it must not take a number.
      // It is mapped with numbering of its own, which is thrown away.
      const alt = extractPlainText(
        mapInlines(known.tokens, { definitions: numbering.definitions, numbered: new Map() }),
      );
      if (isSafeAddress(src)) return [{ type: "image", src, alt, title: decodeTitle(known.title) }];
      return alt === "" ? [] : [{ type: "text", text: alt }];
    }
    default:
      return [{ type: "text", text: token.raw }];
  }
};

/**
 * Returns the blocks for the contents of a list item. marked puts the checkbox
 * of a tight task item in a block of its own, before the text it belongs to.
 * This function joins them into one paragraph that starts with the checkbox.
 */
const mapListItem = (item: Tokens.ListItem, numbering: FootnoteNumbering): MarkdownBlock[] => {
  const [first, second] = item.tokens;
  if (first?.type === "checkbox" && (second?.type === "text" || second?.type === "paragraph")) {
    return [
      {
        type: "paragraph",
        children: [...mapInline(first, numbering), ...mapInlines(second.tokens ?? [], numbering)],
      },
      ...mapBlocks(item.tokens.slice(2), numbering),
    ];
  }
  return mapBlocks(item.tokens, numbering);
};

/** Returns the blocks for a list of block tokens. */
const mapBlocks = (tokens: ReadonlyArray<Token>, numbering: FootnoteNumbering): MarkdownBlock[] =>
  tokens.flatMap((token) => mapBlock(token, numbering));

/**
 * Returns the blocks for one block token. That is one block in most cases, and
 * none for a token that draws nothing: a blank line or a link definition. A
 * kind of token this function does not know becomes a paragraph of its source
 * text. That includes a footnote definition inside a quote or a list, which
 * does not define a footnote.
 */
const mapBlock = (token: Token, numbering: FootnoteNumbering): MarkdownBlock[] => {
  const known = token as MarkedToken;
  switch (known.type) {
    case "space":
    case "def":
      return [];
    case "paragraph":
      return [{ type: "paragraph", children: mapInlines(known.tokens, numbering) }];
    case "text":
      // A tight list item holds its text as a "text" token, not a paragraph.
      return [{ type: "paragraph", children: mapInline(known, numbering) }];
    case "checkbox":
      return [{ type: "paragraph", children: mapInline(known, numbering) }];
    case "heading":
      return [
        {
          type: "heading",
          depth: known.depth as 1 | 2 | 3 | 4 | 5 | 6,
          children: mapInlines(known.tokens, numbering),
        },
      ];
    case "hr":
      return [{ type: "rule" }];
    case "blockquote":
      return [{ type: "blockquote", children: mapBlocks(known.tokens, numbering) }];
    case "code":
      return [{ type: "code", text: known.text }];
    case "html":
      // marked keeps the line break that ends an HTML block.
      return [
        {
          type: "paragraph",
          children: [{ type: "text", text: trimTrailingNewlines(known.text) }],
        },
      ];
    case "list":
      return [
        {
          type: "list",
          start: known.start === "" ? undefined : known.start,
          loose: known.loose,
          items: known.items.map((item) => ({ children: mapListItem(item, numbering) })),
        },
      ];
    case "table":
      return [
        {
          type: "table",
          align: known.align.map((align) => align ?? undefined),
          header: known.header.map((cell) => mapInlines(cell.tokens, numbering)),
          rows: known.rows.map((row) => row.map((cell) => mapInlines(cell.tokens, numbering))),
        },
      ];
    default:
      return [{ type: "paragraph", children: [{ type: "text", text: token.raw }] }];
  }
};

/**
 * Returns the blocks of a footnote with its back reference at the end: in the
 * last block when that is a paragraph, and in a paragraph of its own when not.
 */
const appendBackReference = (
  blocks: ReadonlyArray<MarkdownBlock>,
  number: number,
): MarkdownBlock[] => {
  const backReference: MarkdownInline = { type: "footnoteBackReference", number };
  const last = blocks.at(-1);
  if (last?.type === "paragraph") {
    return [...blocks.slice(0, -1), { ...last, children: [...last.children, backReference] }];
  }
  return [...blocks, { type: "paragraph", children: [backReference] }];
};

/**
 * Turns the tokens of a whole message into its document. The footnote
 * definitions at the top level are set aside and the rest is the body. The body
 * is mapped first, and each reference in it numbers its footnote. Then the
 * referenced footnotes are mapped in number order.
 */
const mapDocument = (tokens: ReadonlyArray<Token>): MarkdownDocument => {
  const definitions = new Map<string, FootnoteDefinitionToken>();
  const body: Token[] = [];
  for (const token of tokens) {
    if (!isFootnoteDefinitionToken(token)) {
      body.push(token);
      continue;
    }
    // The first definition of a label wins; a later one is dropped.
    const label = normalizeLabel(token.label);
    if (!definitions.has(label)) definitions.set(label, token);
  }
  const numbering: FootnoteNumbering = { definitions, numbered: new Map() };
  const blocks = mapBlocks(body, numbering);
  const footnotes: MarkdownFootnote[] = [];
  // A Map visits an entry added while it is being iterated. So a footnote that
  // only another footnote references is numbered during this loop, and comes
  // after the footnotes already waiting.
  for (const { number, definition } of numbering.numbered.values()) {
    footnotes.push({
      number,
      children: appendBackReference(mapBlocks(definition.content, numbering), number),
    });
  }
  return { blocks, footnotes };
};

/**
 * Parses `text` as GitHub-flavoured markdown with footnotes.
 *
 * With `breaks`, a single newline inside a paragraph becomes a line break, as
 * in the user's message bubble, where a newline is deliberate. Without it, a
 * single newline joins the two lines with a space, as CommonMark says.
 *
 * Throws a `RangeError` when the text nests deeper than the JavaScript stack
 * allows. The limit depends on the engine: about 2,000 nested quotes (`>>>>`)
 * in V8 (Chrome, Node), and over 10,000 in JavaScriptCore (Safari, Bun). The
 * caller catches the error and shows the raw text instead.
 */
export const parseMarkdown = (
  text: string,
  { breaks = false }: { readonly breaks?: boolean } = {},
): MarkdownDocument => mapDocument((breaks ? parserWithBreaks : parserWithoutBreaks).lexer(text));
