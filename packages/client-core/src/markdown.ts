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
 */

import { decodeNamedCharacterReference } from "decode-named-character-reference";
import { Marked, type MarkedToken, type Token, type Tokens } from "marked";
import markedFootnote from "marked-footnote";

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
      readonly header: ReadonlyArray<MarkdownTableCell>;
      readonly rows: ReadonlyArray<ReadonlyArray<MarkdownTableCell>>;
    }
  | { readonly type: "rule" };

/** An item of a list. */
export interface MarkdownListItem {
  /** Whether a task item's box is ticked, or undefined when the item is not a task. */
  readonly checked: boolean | undefined;
  readonly children: ReadonlyArray<MarkdownBlock>;
}

/** The content of a table's cell. */
export type MarkdownTableCell = ReadonlyArray<MarkdownInline>;

/** A run of text inside a block. */
export type MarkdownInline =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "strong" | "emphasis" | "strikethrough";
      readonly children: ReadonlyArray<MarkdownInline>;
    }
  | { readonly type: "inlineCode"; readonly text: string }
  | { readonly type: "break" }
  /** A link whose address passed the safety check: relative, or a safe scheme. */
  | {
      readonly type: "link";
      readonly href: string;
      readonly children: ReadonlyArray<MarkdownInline>;
    }
  /** An image whose address passed the same check as a link's. */
  | { readonly type: "image"; readonly src: string; readonly alt: string }
  /**
   * A reference to the footnote with the same number. The footnote's back
   * link returns to its first reference, the one with `isFirstReference`.
   */
  | {
      readonly type: "footnoteReference";
      readonly number: number;
      readonly isFirstReference: boolean;
    };

/** A footnote, numbered by the order of its first reference in the message. */
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

/** A reference to a footnote. `marked-footnote` adds this token, so marked's `Token` type does not describe it. */
interface FootnoteReferenceToken extends Tokens.Generic {
  type: "footnoteRef";
  label: string;
  /** The number of references to the same footnote before this one. */
  index: number;
  /** The footnote's number as a string. */
  id: string;
}

/** The footnotes the message references. `marked-footnote` adds this token. */
interface FootnotesToken extends Tokens.Generic {
  type: "footnotes";
  /** Only the referenced footnotes, sorted by their first reference. */
  items: Array<{ label: string; content: Token[] }>;
}

const isFootnoteReference = (token: Token): token is FootnoteReferenceToken =>
  token.type === "footnoteRef";

const isFootnotes = (token: Token): token is FootnotesToken => token.type === "footnotes";

/**
 * Matches one character reference as CommonMark defines it: a decimal one of 1
 * to 7 digits, a hexadecimal one of 1 to 6 digits, or a name of at most 32
 * letters and digits.
 */
const CHARACTER_REFERENCE =
  /&(?:#([0-9]{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{0,31}));/g;

/** The character CommonMark uses for a code point that is not a character. */
const REPLACEMENT_CHARACTER = "�";

/**
 * Returns `text` with its character references replaced by the characters
 * they stand for, as CommonMark requires: `AT&amp;T` becomes `AT&T`. A name
 * that does not exist, such as `&foo;`, stays as written.
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
      const isCharacter =
        codePoint > 0 && codePoint <= 0x10ffff && (codePoint < 0xd800 || codePoint > 0xdfff);
      return isCharacter ? String.fromCodePoint(codePoint) : REPLACEMENT_CHARACTER;
    },
  );

/** The schemes a link or an image may have besides none, the list react-markdown allows by default. */
const SAFE_SCHEME = /^(https?|ircs?|mailto|xmpp)$/i;

/**
 * Checks whether a link or image address is safe to draw. It is safe when it
 * has no scheme (a relative address, a `?` or a `#` link) or when its scheme is
 * `http`, `https`, `irc`, `ircs`, `mailto` or `xmpp`. Any other scheme, such
 * as `javascript:`, is unsafe.
 *
 * This is react-markdown's `defaultUrlTransform`. It does not use `new URL`,
 * which throws on a relative address. Call it with the decoded address, so
 * that `javascript&#58;alert(1)` is caught.
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

/** Returns the text that `inlines` show, without their markup. It is an image's alt text. */
const readPlainText = (inlines: ReadonlyArray<MarkdownInline>): string =>
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
          return readPlainText(inline.children);
        case "break":
        case "footnoteReference":
          return "";
      }
    })
    .join("");

/** Returns the nodes for a list of inline tokens. */
const mapInlines = (tokens: ReadonlyArray<Token>): MarkdownInline[] => tokens.flatMap(mapInline);

/**
 * Returns the nodes for one inline token. That is one node in most cases, none
 * for a task item's checkbox, and the link's children for a link with an unsafe
 * address. A kind of token this function does not know becomes its source text.
 */
const mapInline = (token: Token): MarkdownInline[] => {
  if (isFootnoteReference(token)) {
    return [
      { type: "footnoteReference", number: Number(token.id), isFirstReference: token.index === 0 },
    ];
  }
  const known = token as MarkedToken;
  switch (known.type) {
    case "text":
      return known.tokens
        ? mapInlines(known.tokens)
        : [{ type: "text", text: decodeCharacterReferences(known.text) }];
    case "escape":
    case "html":
      // An escape holds the character already unescaped, and raw HTML is shown as written.
      return [{ type: "text", text: known.text }];
    case "strong":
      return [{ type: "strong", children: mapInlines(known.tokens) }];
    case "em":
      return [{ type: "emphasis", children: mapInlines(known.tokens) }];
    case "del":
      return [{ type: "strikethrough", children: mapInlines(known.tokens) }];
    case "codespan":
      return [{ type: "inlineCode", text: known.text }];
    case "br":
      return [{ type: "break" }];
    case "link": {
      // The address and text of an autolink or a bare URL are literal: no character references.
      const href = known.autolink ? known.href : decodeCharacterReferences(known.href);
      const children: MarkdownInline[] = known.autolink
        ? [{ type: "text", text: known.text }]
        : mapInlines(known.tokens);
      return isSafeAddress(href) ? [{ type: "link", href, children }] : children;
    }
    case "image": {
      const src = decodeCharacterReferences(known.href);
      const alt = readPlainText(mapInlines(known.tokens));
      if (isSafeAddress(src)) return [{ type: "image", src, alt }];
      return alt === "" ? [] : [{ type: "text", text: alt }];
    }
    case "checkbox":
      return [];
    default:
      return [{ type: "text", text: token.raw }];
  }
};

/** Returns the blocks for a list of block tokens. */
const mapBlocks = (tokens: ReadonlyArray<Token>): MarkdownBlock[] => tokens.flatMap(mapBlock);

/**
 * Returns the blocks for one block token. That is one block in most cases, and
 * none for a token that draws nothing: a blank line, a link definition, a
 * footnote or a task item's checkbox. A kind of token this function does not
 * know becomes a paragraph of its source text.
 */
const mapBlock = (token: Token): MarkdownBlock[] => {
  // The referenced footnotes are read from the "footnotes" token. The
  // definitions in the body are skipped, and so is a definition no reference names.
  if (isFootnotes(token) || token.type === "footnote") return [];
  const known = token as MarkedToken;
  switch (known.type) {
    case "space":
    case "def":
    case "checkbox":
      return [];
    case "paragraph":
      return [{ type: "paragraph", children: mapInlines(known.tokens) }];
    case "text":
      // A tight list item holds its text as a "text" token, not a paragraph.
      return [{ type: "paragraph", children: mapInline(known) }];
    case "heading":
      return [
        {
          type: "heading",
          depth: known.depth as 1 | 2 | 3 | 4 | 5 | 6,
          children: mapInlines(known.tokens),
        },
      ];
    case "hr":
      return [{ type: "rule" }];
    case "blockquote":
      return [{ type: "blockquote", children: mapBlocks(known.tokens) }];
    case "code":
      return [{ type: "code", text: known.text }];
    case "html":
      // marked keeps the line break that ends an HTML block.
      return [
        { type: "paragraph", children: [{ type: "text", text: known.text.replace(/\n+$/, "") }] },
      ];
    case "list":
      return [
        {
          type: "list",
          start: known.start === "" ? undefined : known.start,
          loose: known.loose,
          items: known.items.map((item) => ({
            checked: item.task ? (item.checked ?? false) : undefined,
            children: mapBlocks(item.tokens),
          })),
        },
      ];
    case "table":
      return [
        {
          type: "table",
          align: known.align.map((align) => align ?? undefined),
          header: known.header.map((cell) => mapInlines(cell.tokens)),
          rows: known.rows.map((row) => row.map((cell) => mapInlines(cell.tokens))),
        },
      ];
    default:
      return [{ type: "paragraph", children: [{ type: "text", text: token.raw }] }];
  }
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
): MarkdownDocument => {
  // A new parser for each call, because the footnote extension keeps state
  // that only marked's HTML output resets, and that output is never used. Left
  // in a shared parser, the state numbers footnotes on from the previous
  // message, and makes the next message's first reference throw. Creating
  // the parser costs about 6 microseconds.
  const tokens = new Marked({ gfm: true, breaks }, markedFootnote()).lexer(text);
  const footnotes = tokens.find(isFootnotes);
  return {
    blocks: mapBlocks(tokens),
    footnotes: (footnotes?.items ?? []).map((item, index) => ({
      number: index + 1,
      children: mapBlocks(item.content),
    })),
  };
};
