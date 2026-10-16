/**
 * Parses the markdown in a message into a small tree of plain data, which
 * each app draws as React elements in its own look.
 *
 * The tree holds only the elements both apps know how to draw, so it is safe
 * to draw by construction:
 *
 * - Raw HTML becomes elements only for an allowlist of tags (see
 *   `markdown-html.ts`), and only as the same nodes the markdown for them
 *   makes: `<strong>` is bold text and `<table>` is a table. Any other tag
 *   is dropped and its text kept, so `<form>` in an agent's message is never a
 *   form. With `embeddedHtml: false`, all HTML is kept as text instead.
 * - A link or an image whose address is unsafe, such as `javascript:`, is not
 *   in the tree. A link keeps its text, and an image keeps its alt text.
 * - Character references are decoded, so `AT&amp;T` reads `AT&T`.
 * - Link and image addresses are percent-encoded, so an address never holds a
 *   space, a quote or a backslash.
 */

import { Marked, type MarkedExtension, type MarkedToken, type Token, type Tokens } from "marked";
import { buildBlocksFromPieces, buildInlinesFromPieces, type HtmlPiece } from "./markdown-html";
import {
  decodeCharacterReferences,
  extractPlainText,
  isSafeAddress,
  normalizeAddress,
  removeNestedLinks,
  trimTrailingNewlines,
} from "./markdown-text";
import type {
  MarkdownBlock,
  MarkdownDocument,
  MarkdownFootnote,
  MarkdownInline,
  MarkdownTableCell,
} from "./markdown-tree";

export type {
  ColumnAlignment,
  MarkdownBlock,
  MarkdownDocument,
  MarkdownFootnote,
  MarkdownInline,
  MarkdownListItem,
  MarkdownTableCell,
} from "./markdown-tree";

/** A footnote definition, `[^label]: text`, as the footnote extension lexes it. */
interface FootnoteDefinitionToken extends Tokens.Generic {
  type: "footnoteDefinition";
  /** The label as written, such as `Note 1`. */
  label: string;
  /** The blocks of the footnote's text. */
  content: Token[];
}

/** A footnote reference, `[^label]`, as the footnote extension lexes it. The message defines its label. */
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
 * Matches the first line of a footnote definition: up to 3 spaces, the label,
 * the colon, and the spaces after it. As on GitHub, a label holds no
 * whitespace and no unescaped bracket, so `[^note 1]: text` and
 * `[^a\]: text` stay text. A backslash escapes the character after it. The
 * pattern stops after 999 characters or escapes, which keeps a long line
 * without a closing bracket from being read to its end at every `[^`.
 * `matchFootnoteLabel` then holds the label to 999 characters of source, as in
 * marked's own link labels, escapes included.
 */
const FOOTNOTE_DEFINITION_START = /^ {0,3}\[\^((?:[^[\]\\ \t\r\n]|\\[^ \t\r\n]){1,999})\]:[ \t]*/;

/** Matches a footnote reference at the start of the inline text, with a label as above. */
const FOOTNOTE_REFERENCE = /^\[\^((?:[^[\]\\ \t\r\n]|\\[^ \t\r\n]){1,999})\]/;

/**
 * Matches `pattern`, a footnote definition start or reference, at the start of
 * `text`. Returns the match, whose first group is the label, or `undefined`
 * when there is none or the label is longer than 999 characters of source.
 */
const matchFootnoteLabel = (pattern: RegExp, text: string): RegExpExecArray | undefined => {
  const match = pattern.exec(text);
  return match !== null && (match[1] ?? "").length <= 999 ? match : undefined;
};

/** Matches the indentation that makes a line part of a footnote: 4 spaces or a tab. */
const FOOTNOTE_INDENT = /^(?: {4}| {0,3}\t)/;

/**
 * Matches a line that starts a block other than a paragraph, or that may: up
 * to 3 spaces, then a heading, a quote, a list marker, a code fence, a
 * thematic break, a heading underline, a table row or a table's delimiter
 * row, HTML, or a footnote or link definition. Each alternative looks at a
 * bounded prefix, except the thematic breaks, the underlines and the
 * delimiter row, which read the line once.
 *
 * A line that starts with `|` or `<` may still be paragraph text. It matches
 * all the same, because a footnote that ends a line too early only shows that
 * line after the footnote, while one that ends too late can hide it.
 */
const STARTS_ANOTHER_BLOCK =
  /^ {0,3}(?:#{1,6}(?:[ \t]|$)|>|[-*+](?:[ \t]|$)|\d{1,9}[.)](?:[ \t]|$)|```|~~~|(?:\*[ \t]*){3,}$|(?:_[ \t]*){3,}$|=+[ \t]*$|[-:| \t]+$|\||<|\[(?:[^\]\\\n]|\\[^\n]){1,999}\]:)/;

/** Returns whether `line` holds nothing but spaces and tabs. */
const isBlankLine = (line: string): boolean => line.trim() === "";

/**
 * Returns where the first line after `from` in `source` ends: the index of its
 * line break, or the length of `source` for the last line.
 */
const findLineEnd = (source: string, from: number): number => {
  const end = source.indexOf("\n", from);
  return end === -1 ? source.length : end;
};

/**
 * Reads a footnote definition at the start of `source`. Returns its label, the
 * text of its blocks, and the part of `source` it covers (`raw`), or
 * `undefined` when `source` does not start with a definition.
 *
 * The definition is its first line, `[^label]: text`, and then, line by line:
 * - A line indented by 4 spaces or a tab belongs to it. The indentation is
 *   removed. Blank lines belong to it when an indented line follows them.
 * - A line without indentation continues the paragraph on the line before it,
 *   when the line does not start another block and the definition has held
 *   only paragraphs so far.
 * - Any other line ends it.
 *
 * GitHub continues a paragraph after other blocks too. This reader does not,
 * because it cannot tell a paragraph from the inside of a code block, HTML or
 * a table that an earlier line opened, and continuing those would hide the
 * line in a footnote the message may never reference. The line shows after
 * the footnote instead.
 *
 * It reads one line at a time and never looks back, so it takes time linear in
 * the lines it covers plus the one line that ends the definition.
 */
const readFootnoteDefinition = (
  source: string,
): { label: string; text: string; raw: string } | undefined => {
  const header = matchFootnoteLabel(FOOTNOTE_DEFINITION_START, source);
  if (header === undefined) return undefined;
  const firstEnd = findLineEnd(source, header[0].length);
  const firstLine = source.slice(header[0].length, firstEnd);
  const lines = [firstLine];
  // The end of the last line that belongs to the definition.
  let end = firstEnd;
  // The blank lines seen since then. They belong to the definition only if an indented line follows.
  let pendingBlankLines = 0;
  // Whether every line so far is blank or paragraph text. Text indented further is code, which is not.
  let onlyParagraphs = !STARTS_ANOTHER_BLOCK.test(firstLine);
  // Whether the line before is paragraph text that a line without indentation may continue.
  let paragraphOpen = onlyParagraphs && !isBlankLine(firstLine);
  let position = firstEnd + 1;
  while (position <= source.length && end < source.length) {
    const lineEnd = findLineEnd(source, position);
    const line = source.slice(position, lineEnd);
    const indent = FOOTNOTE_INDENT.exec(line);
    if (isBlankLine(line)) {
      pendingBlankLines++;
      paragraphOpen = false;
    } else if (indent !== null) {
      const content = line.slice(indent[0].length);
      for (; pendingBlankLines > 0; pendingBlankLines--) lines.push("");
      lines.push(content);
      end = lineEnd;
      onlyParagraphs &&= !STARTS_ANOTHER_BLOCK.test(content) && !FOOTNOTE_INDENT.test(content);
      paragraphOpen = onlyParagraphs;
    } else if (paragraphOpen && !STARTS_ANOTHER_BLOCK.test(line)) {
      lines.push(line);
      end = lineEnd;
    } else {
      break;
    }
    position = lineEnd + 1;
  }
  // The line break that ends the last line is part of the definition.
  const raw = source.slice(0, end < source.length ? end + 1 : end);
  return { label: header[1] ?? "", text: lines.join("\n"), raw };
};

/**
 * Returns the index in `source` of the next line that starts a footnote
 * definition, or `undefined` when none comes before the paragraph would end
 * anyway. marked calls this to find where a paragraph must stop for a block
 * extension. `source` is the paragraph without its first character, so a
 * match must be a whole line, never the middle of the first line.
 *
 * The scan stops at a blank line or at a line that starts another block, as
 * the paragraph ends there. That keeps the cost proportional to the paragraph
 * and not to the rest of the message.
 */
const findFootnoteDefinitionStart = (source: string): number | undefined => {
  let lineBreak = source.indexOf("\n");
  while (lineBreak !== -1) {
    const lineStart = lineBreak + 1;
    const lineEnd = findLineEnd(source, lineStart);
    const line = source.slice(lineStart, lineEnd);
    if (matchFootnoteLabel(FOOTNOTE_DEFINITION_START, line) !== undefined) return lineStart;
    if (isBlankLine(line) || STARTS_ANOTHER_BLOCK.test(line)) return undefined;
    lineBreak = lineEnd === source.length ? -1 : lineEnd;
  }
  return undefined;
};

/**
 * The normalized labels that the message defines, per lexer run. The key is
 * the lexer's list of top-level tokens, which is a new array for every run, so
 * nothing outlives a message.
 */
const definedLabelsByRun = new WeakMap<object, ReadonlySet<string>>();

/**
 * Returns the normalized labels of the footnote definitions among `tokens`.
 * The first call of a run builds the set and later calls reuse it. That is
 * safe because marked lexes every block before the first inline text, so the
 * definitions are complete when a reference asks.
 */
const findDefinedLabels = (tokens: Token[]): ReadonlySet<string> => {
  const known = definedLabelsByRun.get(tokens);
  if (known !== undefined) return known;
  const labels = new Set<string>();
  for (const token of tokens) {
    if (isFootnoteDefinitionToken(token)) labels.add(normalizeLabel(token.label));
  }
  definedLabelsByRun.set(tokens, labels);
  return labels;
};

/**
 * Teaches marked to lex footnote definitions and references. The extension
 * keeps no state of its own. A reference is lexed only when the message
 * defines its label, so that `[^x](https://e.com)` or `[^a\*]` keep their
 * ordinary meaning when there is no footnote `x` or `a*`. `mapDocument` still
 * decides which defined footnotes the visible text references.
 */
const footnoteExtension: MarkedExtension = {
  extensions: [
    {
      name: "footnoteDefinition",
      level: "block",
      // marked uses the result only to cut a top-level paragraph, but asks
      // for it before every line of a list item too. Skipping those scans
      // saves work and changes no result.
      start(source) {
        return this.lexer.state.top ? findFootnoteDefinitionStart(source) : undefined;
      },
      tokenizer(source) {
        const definition = readFootnoteDefinition(source);
        if (definition === undefined) return undefined;
        const token: FootnoteDefinitionToken = {
          type: "footnoteDefinition",
          raw: definition.raw,
          label: definition.label,
          content: this.lexer.blockTokens(definition.text),
        };
        return token;
      },
    },
    {
      name: "footnoteReference",
      level: "inline",
      tokenizer(source) {
        const match = matchFootnoteLabel(FOOTNOTE_REFERENCE, source);
        if (match === undefined) return undefined;
        const label = match[1] ?? "";
        if (!findDefinedLabels(this.lexer.tokens).has(normalizeLabel(label))) return undefined;
        const token: FootnoteReferenceToken = { type: "footnoteReference", raw: match[0], label };
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
 * Returns the title of a link or an image with its character references
 * decoded, or undefined when it has none. marked gives an empty string or null
 * for a missing title.
 */
const decodeTitle = (title: string | null | undefined): string | undefined =>
  title ? decodeCharacterReferences(title) : undefined;

/**
 * Returns the label with case ignored, as CommonMark ignores it in a link
 * label: `[^Note]` and `[^note]` are one label. A label holds no whitespace,
 * so there is no spacing to ignore.
 */
const normalizeLabel = (label: string): string => label.toLowerCase().toUpperCase();

/**
 * What the mapping functions share while they walk one message: whether HTML
 * in the message becomes elements, the footnotes the message defines, and the
 * ones its visible text has referenced so far.
 */
interface MappingContext {
  /** Whether HTML tags in the message become elements. When false, they stay text. */
  readonly embeddedHtml: boolean;
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
  context: MappingContext,
): MarkdownInline[] => {
  const label = normalizeLabel(token.label);
  const definition = context.definitions.get(label);
  if (definition === undefined) return [{ type: "text", text: token.raw }];
  const earlier = context.numbered.get(label);
  const number = earlier?.number ?? context.numbered.size + 1;
  if (earlier === undefined) context.numbered.set(label, { number, definition });
  return [{ type: "footnoteReference", number, isFirstReference: earlier === undefined }];
};

/** Checks whether `token` is raw HTML: a tag in a line, or a block of HTML. */
const isHtmlToken = (token: Token): token is Tokens.HTML | Tokens.Tag => token.type === "html";

/** Returns a table cell of one column, with the alignment its column's delimiter sets. */
const mapTableCell = (
  cell: Tokens.TableCell,
  align: "left" | "center" | "right" | null | undefined,
  context: MappingContext,
): MarkdownTableCell => ({
  children: mapInlines(cell.tokens, context),
  columnSpan: 1,
  align: align ?? undefined,
});

/**
 * Returns the nodes for a list of inline tokens. With embedded HTML, the tags
 * among them are matched into elements here, so that `<strong>` and
 * `</strong>` in separate tokens wrap the nodes between them.
 */
const mapInlines = (tokens: ReadonlyArray<Token>, context: MappingContext): MarkdownInline[] => {
  if (!context.embeddedHtml) return tokens.flatMap((token) => mapInline(token, context));
  return buildInlinesFromPieces(
    tokens.flatMap((token): HtmlPiece<MarkdownInline>[] =>
      isHtmlToken(token)
        ? [{ kind: "html", html: token.text }]
        : mapInline(token, context).map((node) => ({ kind: "node", node })),
    ),
  );
};

/**
 * Returns the nodes for one inline token. That is one node in most cases, and
 * the link's children for a link with an unsafe address. A kind of token this
 * function does not know becomes its source text. An `html` token becomes its
 * source text too: `mapInlines` reads HTML before it gets here, unless the
 * message does not allow embedded HTML.
 */
const mapInline = (token: Token, context: MappingContext): MarkdownInline[] => {
  if (isFootnoteReferenceToken(token)) return mapFootnoteReference(token, context);
  const known = token as MarkedToken;
  switch (known.type) {
    case "text":
      // The source is decoded here and not marked's `text`, which has already
      // decoded the numeric references: `&#38;#35;` would be decoded twice.
      return known.tokens
        ? mapInlines(known.tokens, context)
        : [{ type: "text", text: decodeCharacterReferences(known.raw) }];
    case "escape":
    case "html":
      // An escape holds the character already unescaped.
      return [{ type: "text", text: known.text }];
    case "strong":
      return [{ type: "strong", children: mapInlines(known.tokens, context) }];
    case "em":
      return [{ type: "emphasis", children: mapInlines(known.tokens, context) }];
    case "del":
      return [{ type: "strikethrough", children: mapInlines(known.tokens, context) }];
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
        : mapInlines(known.tokens, context);
      // A link holds no link: the one around an HTML link in the text wins.
      return isSafeAddress(href)
        ? [
            {
              type: "link",
              href,
              title: decodeTitle(known.title),
              children: removeNestedLinks(children),
            },
          ]
        : children;
    }
    case "image": {
      const src = normalizeAddress(decodeCharacterReferences(known.href));
      // The alt text is plain text, so a footnote reference in it must not take a number.
      // It is mapped with numbering of its own, which is thrown away.
      const alt = extractPlainText(mapInlines(known.tokens, { ...context, numbered: new Map() }));
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
const mapListItem = (item: Tokens.ListItem, context: MappingContext): MarkdownBlock[] => {
  const [first, second] = item.tokens;
  if (first?.type === "checkbox" && (second?.type === "text" || second?.type === "paragraph")) {
    return [
      {
        type: "paragraph",
        children: [...mapInline(first, context), ...mapInlines(second.tokens ?? [], context)],
      },
      ...mapBlocks(item.tokens.slice(2), context),
    ];
  }
  return mapBlocks(item.tokens, context);
};

/**
 * Returns the blocks for a list of block tokens. With embedded HTML, the tags
 * in its `html` tokens are matched into elements here, across tokens: a
 * `<details>` in one token wraps the paragraphs between it and its
 * `</details>` in a later token.
 */
const mapBlocks = (tokens: ReadonlyArray<Token>, context: MappingContext): MarkdownBlock[] => {
  if (!context.embeddedHtml) return tokens.flatMap((token) => mapBlock(token, context));
  return buildBlocksFromPieces(
    tokens.flatMap((token): HtmlPiece<MarkdownBlock>[] =>
      isHtmlToken(token)
        ? [{ kind: "html", html: token.text }]
        : mapBlock(token, context).map((node) => ({ kind: "node", node })),
    ),
  );
};

/**
 * Returns a paragraph of `children`, or no block when there are none. A
 * paragraph of only `<b></b>` has no children once the HTML is read.
 */
const mapParagraph = (children: MarkdownInline[]): MarkdownBlock[] =>
  children.length === 0 ? [] : [{ type: "paragraph", children }];

/**
 * Returns the blocks for one block token. That is one block in most cases, and
 * none for a token that draws nothing: a blank line or a link definition. A
 * kind of token this function does not know becomes a paragraph of its source
 * text. That includes a footnote definition inside a quote or a list, which
 * does not define a footnote.
 *
 * An `html` token also becomes a paragraph of its source text here. That only
 * happens when the message does not allow embedded HTML: with it, `mapBlocks`
 * reads the token before it gets here.
 */
const mapBlock = (token: Token, context: MappingContext): MarkdownBlock[] => {
  const known = token as MarkedToken;
  switch (known.type) {
    case "space":
    case "def":
      return [];
    case "paragraph":
      return mapParagraph(mapInlines(known.tokens, context));
    case "text":
      // A tight list item holds its text as a "text" token, not a paragraph.
      return mapParagraph(mapInline(known, context));
    case "checkbox":
      return [{ type: "paragraph", children: mapInline(known, context) }];
    case "heading":
      return [
        {
          type: "heading",
          depth: known.depth as 1 | 2 | 3 | 4 | 5 | 6,
          children: mapInlines(known.tokens, context),
        },
      ];
    case "hr":
      return [{ type: "rule" }];
    case "blockquote":
      return [{ type: "blockquote", children: mapBlocks(known.tokens, context) }];
    case "code":
      return [{ type: "code", text: known.text }];
    case "html":
      // The HTML is shown as written. marked keeps the line break that ends an HTML block.
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
          items: known.items.map((item) => ({ children: mapListItem(item, context) })),
        },
      ];
    case "table":
      return [
        {
          type: "table",
          header: known.header.map((cell, column) =>
            mapTableCell(cell, known.align[column], context),
          ),
          rows: known.rows.map((row) =>
            row.map((cell, column) => mapTableCell(cell, known.align[column], context)),
          ),
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
const mapDocument = (tokens: ReadonlyArray<Token>, embeddedHtml: boolean): MarkdownDocument => {
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
  const context: MappingContext = { embeddedHtml, definitions, numbered: new Map() };
  const blocks = mapBlocks(body, context);
  const footnotes: MarkdownFootnote[] = [];
  // A Map visits an entry added while it is being iterated. So a footnote that
  // only another footnote references is numbered during this loop, and comes
  // after the footnotes already waiting.
  for (const { number, definition } of context.numbered.values()) {
    footnotes.push({
      number,
      children: appendBackReference(mapBlocks(definition.content, context), number),
    });
  }
  return { blocks, footnotes };
};

/** The options of `parseMarkdown`. */
export interface ParseMarkdownOptions {
  /** Whether a single newline in a paragraph is a line break. Defaults to false. */
  readonly breaks?: boolean;
  /** Whether HTML tags in the text become elements. Defaults to true. */
  readonly embeddedHtml?: boolean;
}

/**
 * Parses `text` as GitHub-flavoured markdown with footnotes.
 *
 * With `embeddedHtml` (the default), an allowlist of HTML elements becomes the
 * same nodes as the markdown for them, as on GitHub, where bots write
 * comments in HTML: `<strong>`, `<a>`, `<img>`, `<table>`, `<details>` and the
 * like. Comments, `<script>` and `<style>` are dropped, and any other tag is
 * dropped with its text kept. See `markdown-html.ts` for the full list. With
 * `embeddedHtml: false`, every tag is shown as text, as written. Use that for
 * text a person typed.
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
  { breaks = false, embeddedHtml = true }: ParseMarkdownOptions = {},
): MarkdownDocument =>
  mapDocument((breaks ? parserWithBreaks : parserWithoutBreaks).lexer(text), embeddedHtml);
