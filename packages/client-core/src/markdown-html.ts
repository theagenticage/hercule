/**
 * Turns the HTML that GitHub comments hold inside markdown into the nodes of
 * the markdown tree. Bots such as Cypress, Renovate and CodeRabbit write their
 * comments this way.
 *
 * The reader is safe to draw by construction. It never builds HTML and never
 * calls `innerHTML`. It reads a fixed allowlist of elements and maps each onto
 * a node the apps already draw:
 *
 * - `strong`/`b`, `em`/`i`, `del`/`s`/`strike`, `code` and `br` become the
 *   inline of the same meaning.
 * - `a` becomes a link and `img` an image, after the same address check
 *   markdown links get. `img` keeps `width` and `height` when they are whole
 *   numbers of pixels. `picture` and `source` are not in the list, so a
 *   `picture` shows its `img`.
 * - `p`, `div`, `h1` to `h6`, `blockquote`, `ul`, `ol` (with `start`), `li`,
 *   `hr` and `pre` become the block of the same meaning. A `div` is a
 *   paragraph, so that two of them are two lines.
 * - `table`, `thead`, `tbody`, `tfoot`, `tr`, `th` and `td` (with `align`)
 *   become one table. `colspan` is kept as the cell's column span; `rowspan`
 *   is ignored.
 * - `details` with its `summary` becomes a `details` block.
 *
 * HTML comments are dropped. So is a `script` or `style` element with
 * everything inside it, when both of its tags are in one block of HTML, which
 * is how marked reads a `<script>` that starts a line and ends in `</script>`.
 * In the middle of a sentence, as in `A<script>x()</script>B`, marked hands
 * over the two tags and the text between them as three separate pieces. Only
 * the tags are dropped there, and the text stays: a lone `<script>` in prose
 * must never hide the words after it. The same holds for `<script> tags are
 * bad.`, which nothing closes. Nothing runs either way, because no element
 * is built. Any other standard HTML element, such as `span`, `sub` or `form`,
 * is dropped with its text kept. An attribute outside the list above is
 * ignored.
 *
 * A tag whose name is not a standard HTML element name stays text, exactly as
 * written. Prose and code in a comment hold such tags: `Array<string>`,
 * `<T>` or `<Button variant="primary" />`. So does a tag that mixes
 * upper and lower case, such as `<Button>`: only `<button>` and `<BUTTON>` are
 * the HTML element.
 *
 * Nothing an author wrote is lost. Content that an element does not use, such
 * as text directly inside a `table` or a `ul`, is kept in front of the element's
 * block. A list item, summary or table part outside its parent is kept as
 * plain text or blocks.
 *
 * A message holds HTML across many markdown tokens. The tags of
 * `<details>\n<summary>X</summary>\n\n**text**\n\n</details>` arrive in two
 * tokens with a markdown paragraph between them, and `a <b>c</b> d` arrives
 * as five. The caller hands one level of tokens over as pieces, in order, and
 * this module matches the tags across them.
 */

import {
  decodeCharacterReferences,
  extractPlainText,
  removeNestedLinks,
  isSafeAddress,
  normalizeAddress,
  trimTrailingNewlines,
} from "./markdown-text";
import type {
  ColumnAlignment,
  MarkdownBlock,
  MarkdownInline,
  MarkdownTableCell,
} from "./markdown-tree";

/**
 * One piece of a level of markdown tokens, in order: a node the markdown
 * parser already made, or the source of an `html` token.
 */
export type HtmlPiece<Node> =
  | { readonly kind: "node"; readonly node: Node }
  | { readonly kind: "html"; readonly html: string };

/**
 * Returns the blocks for pieces of block tokens, with each HTML element that
 * the pieces open wrapping the pieces up to its closing tag. Text that HTML
 * leaves outside any block becomes a paragraph. Returns the nodes unchanged
 * when no piece is HTML.
 */
export const buildBlocksFromPieces = (
  pieces: ReadonlyArray<HtmlPiece<MarkdownBlock>>,
): MarkdownBlock[] =>
  hasHtml(pieces)
    ? convertToBlocks(nestPieces(pieces, wrapBlock))
    : pieces.flatMap((piece) => (piece.kind === "node" ? [piece.node] : []));

/**
 * Returns the inlines for pieces of inline tokens, with each HTML element that
 * the pieces open wrapping the pieces up to its closing tag. A block element
 * in a line is flattened to inlines. Returns the nodes unchanged when no piece
 * is HTML.
 */
export const buildInlinesFromPieces = (
  pieces: ReadonlyArray<HtmlPiece<MarkdownInline>>,
): MarkdownInline[] =>
  hasHtml(pieces)
    ? convertToInlines(nestPieces(pieces, wrapInline))
    : pieces.flatMap((piece) => (piece.kind === "node" ? [piece.node] : []));

const hasHtml = (pieces: ReadonlyArray<HtmlPiece<unknown>>): boolean =>
  pieces.some((piece) => piece.kind === "html");

// ---------------------------------------------------------------------------
// Scanning: HTML source to tags and text
// ---------------------------------------------------------------------------

/**
 * The standard HTML element names, in lower case: the elements of the HTML
 * Living Standard, plus the old ones that comments still use (`center`,
 * `font`, `big`, `tt`, `strike`, `acronym`). A tag with another name is not
 * HTML and stays text. `svg` and `math` are left out, as GitHub removes them.
 */
const HTML_ELEMENT_NAMES: ReadonlySet<string> = new Set([
  "a",
  "abbr",
  "acronym",
  "address",
  "area",
  "article",
  "aside",
  "audio",
  "b",
  "base",
  "bdi",
  "bdo",
  "big",
  "blockquote",
  "body",
  "br",
  "button",
  "canvas",
  "caption",
  "center",
  "cite",
  "code",
  "col",
  "colgroup",
  "data",
  "datalist",
  "dd",
  "del",
  "details",
  "dfn",
  "dialog",
  "div",
  "dl",
  "dt",
  "em",
  "embed",
  "fieldset",
  "figcaption",
  "figure",
  "font",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "head",
  "header",
  "hgroup",
  "hr",
  "html",
  "i",
  "iframe",
  "img",
  "input",
  "ins",
  "kbd",
  "label",
  "legend",
  "li",
  "link",
  "main",
  "map",
  "mark",
  "menu",
  "meta",
  "meter",
  "nav",
  "noscript",
  "object",
  "ol",
  "optgroup",
  "option",
  "output",
  "p",
  "param",
  "picture",
  "pre",
  "progress",
  "q",
  "rp",
  "rt",
  "ruby",
  "s",
  "samp",
  "script",
  "search",
  "section",
  "select",
  "slot",
  "small",
  "source",
  "span",
  "strike",
  "strong",
  "style",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "template",
  "textarea",
  "tfoot",
  "th",
  "thead",
  "time",
  "title",
  "tr",
  "track",
  "tt",
  "u",
  "ul",
  "var",
  "video",
  "wbr",
]);

/**
 * Checks whether a tag name, as written, is a standard HTML element. The name
 * must be in `HTML_ELEMENT_NAMES` and written all in lower case or all in
 * upper case, so `<Button>` (a component) is not HTML but `<BUTTON>` is.
 */
const isHtmlElementName = (name: string): boolean =>
  (name === name.toLowerCase() || name === name.toUpperCase()) &&
  HTML_ELEMENT_NAMES.has(name.toLowerCase());

/**
 * What an HTML source is made of. Text and attribute values have their
 * character references decoded, except the text of a tag that is not HTML,
 * which is kept as written.
 */
type HtmlToken =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "openTag";
      /** In lower case. */
      readonly name: string;
      /** The attributes by lower-case name. When one is written twice, the first wins. */
      readonly attributes: ReadonlyMap<string, string>;
      readonly selfClosing: boolean;
    }
  | { readonly type: "closeTag"; readonly name: string };

const isHtmlSpace = (character: string | undefined): boolean =>
  character === " " ||
  character === "\t" ||
  character === "\n" ||
  character === "\r" ||
  character === "\f";

const isAsciiLetter = (character: string | undefined): boolean =>
  character !== undefined && /^[A-Za-z]$/.test(character);

/**
 * Returns the index where the name that starts at `start` ends: at the first
 * space, `/` or `>`, or at the end of `html`.
 */
const findNameEnd = (html: string, start: number): number => {
  let end = start;
  while (end < html.length && !isHtmlSpace(html[end]) && html[end] !== "/" && html[end] !== ">") {
    end++;
  }
  return end;
};

/** The result of reading a tag: the index after it, and its token. Comments and declarations have no token. */
interface TagRead {
  readonly end: number;
  readonly token?: HtmlToken;
}

/**
 * Reads the open tag whose name starts at `start`, with its attributes, as an
 * HTML parser does: attribute values are quoted, unquoted or missing, and a
 * stray `/` is ignored. Returns the end of `html` and no token when the tag
 * never closes, which drops a half-written tag at the end of the text.
 */
const readOpenTag = (html: string, start: number): TagRead => {
  const nameEnd = findNameEnd(html, start);
  const name = html.slice(start, nameEnd).toLowerCase();
  const attributes = new Map<string, string>();
  let position = nameEnd;
  while (position < html.length) {
    while (isHtmlSpace(html[position])) position++;
    const character = html[position];
    if (character === undefined) break;
    if (character === ">") {
      return {
        end: position + 1,
        token: { type: "openTag", name, attributes, selfClosing: false },
      };
    }
    if (character === "/") {
      if (html[position + 1] === ">") {
        return {
          end: position + 2,
          token: { type: "openTag", name, attributes, selfClosing: true },
        };
      }
      position++;
      continue;
    }
    // An attribute name. A name may start with "=" and still has to move on.
    const attributeStart = position;
    position++;
    while (
      position < html.length &&
      !isHtmlSpace(html[position]) &&
      html[position] !== "/" &&
      html[position] !== ">" &&
      html[position] !== "="
    ) {
      position++;
    }
    const attributeName = html.slice(attributeStart, position).toLowerCase();
    while (isHtmlSpace(html[position])) position++;
    let value = "";
    if (html[position] === "=") {
      position++;
      while (isHtmlSpace(html[position])) position++;
      const quote = html[position];
      if (quote === '"' || quote === "'") {
        const close = html.indexOf(quote, position + 1);
        if (close === -1) break;
        value = html.slice(position + 1, close);
        position = close + 1;
      } else {
        const valueStart = position;
        while (position < html.length && !isHtmlSpace(html[position]) && html[position] !== ">") {
          position++;
        }
        value = html.slice(valueStart, position);
      }
    }
    if (!attributes.has(attributeName)) {
      attributes.set(attributeName, decodeCharacterReferences(value));
    }
  }
  return { end: html.length };
};

/**
 * Reads a tag that is not HTML, such as `<T>` in `Array<T>`, as text exactly
 * as written, up to the next `>`. Returns undefined when no `>` follows, so
 * that the `<` stays plain text too. `findGreaterThan` finds the next `>`.
 */
const readTagAsText = (
  html: string,
  start: number,
  findGreaterThan: (from: number) => number,
): TagRead | undefined => {
  const close = findGreaterThan(start);
  if (close === -1) return undefined;
  return { end: close + 1, token: { type: "text", text: html.slice(start, close + 1) } };
};

/**
 * Reads what starts with the `<` at `start`. Returns undefined when it is not
 * markup, such as the `<` in `a < b`, which stays text.
 */
const readMarkup = (
  html: string,
  start: number,
  findGreaterThan: (from: number) => number,
): TagRead | undefined => {
  if (html.startsWith("<!--", start)) {
    const close = html.indexOf("-->", start + 4);
    return { end: close === -1 ? html.length : close + 3 };
  }
  const next = html[start + 1];
  if (next === "!" || next === "?") {
    // A declaration such as <!DOCTYPE html>, or a processing instruction.
    const close = html.indexOf(">", start);
    return { end: close === -1 ? html.length : close + 1 };
  }
  if (next === "/" && isAsciiLetter(html[start + 2])) {
    const nameEnd = findNameEnd(html, start + 2);
    const name = html.slice(start + 2, nameEnd);
    if (!isHtmlElementName(name)) return readTagAsText(html, start, findGreaterThan);
    const close = html.indexOf(">", nameEnd);
    if (close === -1) return { end: html.length };
    return { end: close + 1, token: { type: "closeTag", name: name.toLowerCase() } };
  }
  if (isAsciiLetter(next)) {
    const nameEnd = findNameEnd(html, start + 1);
    if (!isHtmlElementName(html.slice(start + 1, nameEnd))) {
      return readTagAsText(html, start, findGreaterThan);
    }
    return readOpenTag(html, start + 1);
  }
  return undefined;
};

/**
 * Splits `html` into text, open tags and close tags, in order. Comments and
 * declarations are left out. A tag that is not HTML becomes text. The end of
 * `html` cuts off a comment, a tag or a quoted attribute value that is still
 * open there, and the cut-off part is dropped, so a comment cut short in the
 * middle of a tag shows no half tag. It never throws, and takes time linear in
 * the length of `html`.
 */
const scanHtmlTags = (html: string): HtmlToken[] => {
  const tokens: HtmlToken[] = [];
  let textStart = 0;
  let position = 0;
  // The index of the first ">" at or after the last search. -2 before the
  // first search and -1 when none is left. The start of each tag is later than
  // the one before, so one search can serve many tags and the scan stays linear.
  let greaterThan = -2;
  const findGreaterThan = (from: number): number => {
    if (greaterThan === -2 || (greaterThan !== -1 && greaterThan < from)) {
      greaterThan = html.indexOf(">", from);
    }
    return greaterThan;
  };
  const addText = (end: number) => {
    if (end > textStart) {
      tokens.push({ type: "text", text: decodeCharacterReferences(html.slice(textStart, end)) });
    }
  };
  for (;;) {
    const start = html.indexOf("<", position);
    if (start === -1) break;
    const read = readMarkup(html, start, findGreaterThan);
    if (read === undefined) {
      position = start + 1;
      continue;
    }
    addText(start);
    if (read.token !== undefined) tokens.push(read.token);
    textStart = position = read.end;
  }
  addText(html.length);
  return tokens;
};

// ---------------------------------------------------------------------------
// Nesting: matching open and close tags into elements
// ---------------------------------------------------------------------------

/** One cell of an HTML table. */
interface TableCell {
  readonly inlines: MarkdownInline[];
  /** The columns the cell covers, from its `colspan`. */
  readonly columnSpan: number;
  readonly align: ColumnAlignment;
  /** Whether the cell is a `th`. */
  readonly isHeader: boolean;
}

/**
 * What an element, or a node from the markdown parser, leaves in the element
 * around it. Most are a block or an inline. The others are the parts of a
 * list, a details block and a table, which their own parent reads. A part
 * that its parent does not read, or that has no parent, is plain content: a
 * list item is its blocks, and a summary, a cell or a row is its inlines.
 */
type ElementContent =
  | { readonly kind: "block"; readonly block: MarkdownBlock }
  | { readonly kind: "inline"; readonly inline: MarkdownInline }
  | { readonly kind: "listItem"; readonly blocks: MarkdownBlock[] }
  | { readonly kind: "summary"; readonly inlines: MarkdownInline[] }
  | { readonly kind: "cell"; readonly cell: TableCell }
  | {
      readonly kind: "row";
      readonly cells: TableCell[];
      /** Whether the row is in a `thead`. */
      readonly isHeader: boolean;
    };

/** An element whose closing tag has not come yet, with what it holds so far. */
interface OpenElement {
  readonly tag: string;
  readonly attributes: ReadonlyMap<string, string>;
  readonly content: ElementContent[];
}

const wrapBlock = (block: MarkdownBlock): ElementContent => ({ kind: "block", block });
const wrapInline = (inline: MarkdownInline): ElementContent => ({ kind: "inline", inline });

/** Returns the attribute's value, or undefined when it is missing or empty. */
const readAttribute = (element: OpenElement, name: string): string | undefined => {
  const value = element.attributes.get(name);
  return value === undefined || value === "" ? undefined : value;
};

/**
 * Returns the whole number above zero that an attribute holds, up to five
 * digits, or undefined for a missing attribute or any other value. Used for an
 * image's `width` and `height` and a cell's `colspan`.
 */
const parsePositiveInteger = (value: string | undefined): number | undefined => {
  if (value === undefined || !/^[0-9]{1,5}$/.test(value.trim())) return undefined;
  const size = Number(value);
  return size > 0 ? size : undefined;
};

/**
 * Returns the number of columns a cell's `colspan` attribute names: a whole
 * number above zero, or 1 for a missing or any other value, such as one of
 * more than five digits. A value over `MAX_TABLE_COLUMNS` is kept as written;
 * `limitCellSpans` cuts it down.
 */
const parseColumnSpan = (value: string | undefined): number => parsePositiveInteger(value) ?? 1;

/**
 * Returns the column alignment that a cell's `align` attribute names: `left`,
 * `center` or `right` in any case. Returns undefined for a missing attribute
 * or any other value.
 */
const parseAlignment = (value: string | undefined): ColumnAlignment => {
  const alignment = value?.trim().toLowerCase();
  return alignment === "left" || alignment === "center" || alignment === "right"
    ? alignment
    : undefined;
};

/** Checks whether a run of inlines shows nothing: only spaces and line breaks. */
const isBlankRun = (inlines: ReadonlyArray<MarkdownInline>): boolean =>
  inlines.every(
    (inline) =>
      inline.type === "break" || (inline.type === "text" && /^[ \t\n\r\f]*$/.test(inline.text)),
  );

/**
 * Returns `inlines` without the spaces and line breaks at both ends, which an
 * HTML element does not show.
 */
const trimInlines = (inlines: ReadonlyArray<MarkdownInline>): MarkdownInline[] => {
  const isBlank = (inline: MarkdownInline | undefined) =>
    inline !== undefined && isBlankRun([inline]);
  let start = 0;
  let end = inlines.length;
  while (start < end && isBlank(inlines[start])) start++;
  while (end > start && isBlank(inlines[end - 1])) end--;
  const trimmed = inlines.slice(start, end);
  const first = trimmed[0];
  if (first?.type === "text") {
    trimmed[0] = { type: "text", text: first.text.replace(/^[ \t\n\r\f]+/, "") };
  }
  const last = trimmed.at(-1);
  if (last?.type === "text") {
    trimmed[trimmed.length - 1] = { type: "text", text: last.text.replace(/[ \t\n\r\f]+$/, "") };
  }
  return trimmed;
};

/** A run of inlines, or a block: what an element's content is split into. */
type Segment =
  | { readonly kind: "inlines"; readonly inlines: MarkdownInline[] }
  | { readonly kind: "block"; readonly block: MarkdownBlock };

/**
 * Splits an element's content into runs of inlines and blocks, in order. Text
 * that sits next to other text is joined into one text. Unless
 * `preserveSpace` is set, as inside `pre`, a space at the start of the second
 * text is dropped when the first ends in one, so the join holds no double
 * space. A run may show nothing, such as the white space between two tags, and
 * it is kept: the callers decide.
 *
 * A part outside its parent is plain content here. A list item gives its
 * blocks. A summary, a cell and a row give their inlines, with a space between
 * them and the text before and after, so that `x<td>c</td>y` reads "x c y".
 */
const splitIntoSegments = (
  content: ReadonlyArray<ElementContent>,
  preserveSpace = false,
): Segment[] => {
  const segments: Segment[] = [];
  let run: MarkdownInline[] = [];
  // Whether the inlines just added end a part, and so need a space before whatever comes next.
  let spaceBeforeNext = false;
  const endRun = () => {
    if (run.length > 0) segments.push({ kind: "inlines", inlines: run });
    run = [];
    spaceBeforeNext = false;
  };
  const appendInline = (inline: MarkdownInline) => {
    if (spaceBeforeNext) {
      spaceBeforeNext = false;
      if (inline.type !== "break") appendInline({ type: "text", text: " " });
    }
    const last = run.at(-1);
    if (inline.type === "text" && last?.type === "text") {
      const joined =
        preserveSpace || !/[ \t\n\r\f]$/.test(last.text)
          ? inline.text
          : inline.text.replace(/^[ \t\n\r\f]+/, "");
      run[run.length - 1] = { type: "text", text: last.text + joined };
    } else {
      run.push(inline);
    }
  };
  const appendPartInlines = (inlines: ReadonlyArray<MarkdownInline>) => {
    if (inlines.length === 0) return;
    const last = run.at(-1);
    if (last !== undefined && last.type !== "break") appendInline({ type: "text", text: " " });
    for (const inline of inlines) appendInline(inline);
    spaceBeforeNext = true;
  };
  for (const part of content) {
    switch (part.kind) {
      case "inline":
        appendInline(part.inline);
        break;
      case "block":
        endRun();
        segments.push({ kind: "block", block: part.block });
        break;
      case "listItem":
        for (const block of part.blocks) {
          endRun();
          segments.push({ kind: "block", block });
        }
        break;
      case "summary":
        appendPartInlines(part.inlines);
        break;
      case "cell":
        appendPartInlines(part.cell.inlines);
        break;
      case "row":
        for (const cell of part.cells) appendPartInlines(cell.inlines);
        break;
    }
  }
  endRun();
  return segments;
};

/** Returns the groups joined into one run of inlines, a line break between two groups, empty groups left out. */
const joinWithBreaks = (groups: ReadonlyArray<ReadonlyArray<MarkdownInline>>): MarkdownInline[] =>
  groups
    .filter((group) => group.length > 0)
    .flatMap((group, index) => (index === 0 ? group : [{ type: "break" } as const, ...group]));

/** Returns the groups joined into one run of inlines, a space between two groups, empty groups left out. */
const joinWithSpaces = (groups: ReadonlyArray<ReadonlyArray<MarkdownInline>>): MarkdownInline[] =>
  groups
    .filter((group) => group.length > 0)
    .flatMap((group, index) =>
      index === 0 ? group : [{ type: "text", text: " " } as const, ...group],
    );

/** Returns the text of a block as inlines, for a place that holds only inlines, such as a table cell. */
const flattenBlock = (block: MarkdownBlock): MarkdownInline[] => {
  switch (block.type) {
    case "paragraph":
    case "heading":
      return [...block.children];
    case "code":
      return [{ type: "inlineCode", text: block.text }];
    case "list":
      return joinWithBreaks(
        block.items.map((item) => joinWithBreaks(item.children.map(flattenBlock))),
      );
    case "blockquote":
      return joinWithBreaks(block.children.map(flattenBlock));
    case "details":
      return joinWithBreaks([[...block.summary], ...block.children.map(flattenBlock)]);
    case "table":
      return joinWithBreaks(
        [block.header, ...block.rows].map((row) =>
          joinWithSpaces(row.map((cell) => cell.children)),
        ),
      );
    case "rule":
      return [];
  }
};

/**
 * Returns the blocks for an element's content. The inlines between two blocks
 * make a paragraph, unless they show nothing.
 */
const convertToBlocks = (content: ReadonlyArray<ElementContent>): MarkdownBlock[] =>
  splitIntoSegments(content).flatMap((segment): MarkdownBlock[] => {
    if (segment.kind === "block") return [segment.block];
    if (isBlankRun(segment.inlines)) return [];
    return [{ type: "paragraph", children: trimInlines(segment.inlines) }];
  });

/**
 * Returns the inlines for an element's content, for an element that holds
 * only inlines. A block among them becomes inlines with a line break around
 * it. Spaces at the ends stay, so `<b>a </b>b` keeps its space. See
 * `splitIntoSegments` for `preserveSpace`.
 */
const convertToInlines = (
  content: ReadonlyArray<ElementContent>,
  preserveSpace = false,
): MarkdownInline[] => {
  const segments = splitIntoSegments(content, preserveSpace);
  if (!segments.some((segment) => segment.kind === "block")) {
    return segments.flatMap((segment) => (segment.kind === "inlines" ? segment.inlines : []));
  }
  return joinWithBreaks(
    segments.flatMap((segment) => {
      if (segment.kind === "block") return [flattenBlock(segment.block)];
      return isBlankRun(segment.inlines) ? [] : [segment.inlines];
    }),
  );
};

/**
 * Returns the function that closes a `strong`, `em` or `del` element. The
 * element leaves nothing when it is empty, and only its white space when it
 * holds nothing else.
 */
const closeInlineWrapper =
  (type: "strong" | "emphasis" | "strikethrough") =>
  (element: OpenElement): ElementContent[] => {
    const children = convertToInlines(element.content);
    if (isBlankRun(children)) return children.map(wrapInline);
    return [wrapInline({ type, children })];
  };

/** Returns the function that closes a heading element of the given depth. */
const closeHeading =
  (depth: 1 | 2 | 3 | 4 | 5 | 6) =>
  (element: OpenElement): ElementContent[] => {
    const children = trimInlines(convertToInlines(element.content));
    return children.length === 0 ? [] : [wrapBlock({ type: "heading", depth, children })];
  };

/** Closes a `p` or a `div`: each run of inlines in it is a paragraph, and its blocks stay blocks. */
const closeParagraph = (element: OpenElement): ElementContent[] =>
  convertToBlocks(element.content).map(wrapBlock);

/**
 * Closes an `a`. It leaves its children alone when its address is missing or
 * unsafe, or when it holds nothing but white space. A link inside it is
 * flattened to its children.
 */
const closeLink = (element: OpenElement): ElementContent[] => {
  const children = convertToInlines(element.content);
  const href = normalizeAddress(element.attributes.get("href") ?? "");
  if (href === "" || !isSafeAddress(href) || isBlankRun(children)) {
    return children.map(wrapInline);
  }
  return [
    wrapInline({
      type: "link",
      href,
      title: readAttribute(element, "title"),
      children: removeNestedLinks(children),
    }),
  ];
};

const closeCode = (element: OpenElement): ElementContent[] => {
  // A line break in code reads as a space, like the white space of the HTML around it.
  const text = extractPlainText(convertToInlines(element.content), " ");
  return text === "" ? [] : [wrapInline({ type: "inlineCode", text })];
};

const closeBlockquote = (element: OpenElement): ElementContent[] => {
  const children = convertToBlocks(element.content);
  return children.length === 0 ? [] : [wrapBlock({ type: "blockquote", children })];
};

/**
 * Returns the content of an element that the element itself does not use, in
 * order, for the element to pass on to the one around it. The parts for which
 * `isUsed` returns true are the ones the element uses itself. Text that such a
 * part sat between gets a space between, so that it does not run together, as
 * `stray` and `between` would.
 */
const collectUnusedContent = (
  content: ReadonlyArray<ElementContent>,
  isUsed: (part: ElementContent) => boolean,
): ElementContent[] => {
  const space = wrapInline({ type: "text", text: " " });
  const unused: ElementContent[] = [];
  let endsWithInline = false;
  let usedPartFollows = false;
  for (const part of content) {
    if (isUsed(part)) {
      usedPartFollows = endsWithInline;
      continue;
    }
    if (usedPartFollows && part.kind === "inline") unused.push(space);
    usedPartFollows = false;
    unused.push(part);
    endsWithInline = part.kind === "inline";
  }
  return unused;
};

/**
 * Closes a `ul` or an `ol`. Its `li` children are the items. Anything else in
 * it comes out in front of the list.
 */
const closeList = (element: OpenElement): ElementContent[] => {
  const unused = collectUnusedContent(element.content, (part) => part.kind === "listItem");
  const items = element.content.flatMap((part) =>
    part.kind === "listItem" ? [{ children: part.blocks }] : [],
  );
  if (items.length === 0) return unused;
  const startAttribute = element.attributes.get("start") ?? "";
  const start =
    element.tag === "ol" && /^[0-9]{1,9}$/.test(startAttribute)
      ? Number(startAttribute)
      : undefined;
  return [...unused, wrapBlock({ type: "list", start, loose: false, items })];
};

const closeListItem = (element: OpenElement): ElementContent[] => [
  { kind: "listItem", blocks: convertToBlocks(element.content) },
];

const closePreformatted = (element: OpenElement): ElementContent[] => {
  // A browser drops the line break right after <pre>.
  const text = trimTrailingNewlines(
    extractPlainText(convertToInlines(element.content, true), "\n").replace(/^\r?\n/, ""),
  );
  return text === "" ? [] : [wrapBlock({ type: "code", text })];
};

const closeSummary = (element: OpenElement): ElementContent[] => [
  { kind: "summary", inlines: trimInlines(convertToInlines(element.content)) },
];

/**
 * Closes a `details`. Its first `summary` is the summary line, and the rest of
 * its content, a second `summary` included, is the body.
 */
const closeDetails = (element: OpenElement): ElementContent[] => {
  const summaryPart = element.content.find((part) => part.kind === "summary");
  const summary = summaryPart?.inlines ?? [];
  return [
    wrapBlock({
      type: "details",
      summary: summary.length > 0 ? summary : [{ type: "text", text: "Details" }],
      children: convertToBlocks(element.content.filter((part) => part !== summaryPart)),
    }),
  ];
};

const closeCell = (element: OpenElement): ElementContent[] => [
  {
    kind: "cell",
    cell: {
      inlines: trimInlines(convertToInlines(element.content)),
      columnSpan: parseColumnSpan(element.attributes.get("colspan")),
      align: parseAlignment(element.attributes.get("align")),
      isHeader: element.tag === "th",
    },
  },
];

/** Closes a `tr`. Its cells are the row. Anything else in it comes out in front of the row. */
const closeRow = (element: OpenElement): ElementContent[] => [
  ...collectUnusedContent(element.content, (part) => part.kind === "cell"),
  {
    kind: "row",
    cells: element.content.flatMap((part) => (part.kind === "cell" ? [part.cell] : [])),
    isHeader: false,
  },
];

/**
 * Closes a `thead`, `tbody` or `tfoot`. Its rows go on to the table, marked as
 * header rows for a `thead`. Anything else in it comes out in front of them.
 */
const closeRowGroup = (element: OpenElement): ElementContent[] => [
  ...collectUnusedContent(element.content, (part) => part.kind === "row"),
  ...element.content.flatMap((part): ElementContent[] =>
    part.kind === "row" ? [{ ...part, isHeader: part.isHeader || element.tag === "thead" }] : [],
  ),
];

/**
 * The most columns a table has. A table holds rows times columns cells, and
 * a short row is padded to the widest one, so one row of 25,000 cells above
 * 12,000 short rows would need 300 million cells. No table that a person reads
 * has more than a few dozen columns, so 64 is room to spare. `limitCellSpans`
 * keeps the text of the cells past the limit.
 */
const MAX_TABLE_COLUMNS = 64;

/** The content of a cell with nothing in it. Every padding cell shares it, as the tree is never changed. */
const EMPTY_CELL: MarkdownInline[] = [];

/**
 * Returns `cells` with the columns they cover limited to `MAX_TABLE_COLUMNS`.
 * A span that reaches past the limit is cut to end at it. Every cell that
 * starts at or past the limit goes into the last cell, its content after the
 * last cell's with a space between them.
 */
const limitCellSpans = (cells: TableCell[]): TableCell[] => {
  const kept: TableCell[] = [];
  const overflow: MarkdownInline[][] = [];
  let column = 0;
  for (const cell of cells) {
    if (column >= MAX_TABLE_COLUMNS) {
      overflow.push(cell.inlines);
      continue;
    }
    const columnSpan = Math.min(cell.columnSpan, MAX_TABLE_COLUMNS - column);
    kept.push({ ...cell, columnSpan });
    column += columnSpan;
  }
  const last = kept.pop();
  if (last === undefined) return kept;
  return [
    ...kept,
    overflow.length === 0
      ? last
      : { ...last, inlines: joinWithSpaces([last.inlines, ...overflow]) },
  ];
};

/**
 * Closes a `table`. Content that is not a row comes out in front of the table.
 * The header is the row in a `thead`, or else the first row when all its cells
 * are `th`, or else empty. The table is as wide as its widest row, counting
 * the columns each cell covers. A shorter row ends in one empty cell that
 * covers the rest. A column's alignment comes from the header's cell that
 * starts there, or else the first row's, and each cell takes the alignment of
 * the column it starts in.
 */
const closeTable = (element: OpenElement): ElementContent[] => {
  const unused = collectUnusedContent(element.content, (part) => part.kind === "row");
  const rows = element.content.flatMap((part) =>
    part.kind === "row" && part.cells.length > 0
      ? [{ ...part, cells: limitCellSpans(part.cells) }]
      : [],
  );
  const first = rows[0];
  const headerRow =
    rows.find((row) => row.isHeader) ??
    (first?.cells.every((cell) => cell.isHeader) ? first : undefined);
  const bodyRows = rows.filter((row) => row !== headerRow);
  const columnCount = rows.reduce((widest, row) => Math.max(widest, countColumns(row.cells)), 0);
  if (columnCount === 0) return unused;
  const alignmentRow = headerRow ?? bodyRows[0];
  const columnAlign = buildColumnAlignment(alignmentRow?.cells ?? [], columnCount);
  const buildRow = (row: { readonly cells: TableCell[] }): MarkdownTableCell[] => {
    let column = 0;
    const cells = row.cells.map((cell) => {
      const built = {
        children: cell.inlines,
        columnSpan: cell.columnSpan,
        align: columnAlign[column],
      };
      column += cell.columnSpan;
      return built;
    });
    return column < columnCount
      ? [
          ...cells,
          { children: EMPTY_CELL, columnSpan: columnCount - column, align: columnAlign[column] },
        ]
      : cells;
  };
  return [
    ...unused,
    wrapBlock({
      type: "table",
      header: headerRow === undefined ? [] : buildRow(headerRow),
      rows: bodyRows.map(buildRow),
    }),
  ];
};

/** Returns the number of columns a row's cells cover together. */
const countColumns = (cells: ReadonlyArray<TableCell>): number =>
  cells.reduce((total, cell) => total + cell.columnSpan, 0);

/** Returns the alignment of each of `columnCount` columns: the one a cell sets, for each column it covers. */
const buildColumnAlignment = (
  cells: ReadonlyArray<TableCell>,
  columnCount: number,
): ColumnAlignment[] => {
  const alignment: ColumnAlignment[] = Array.from({ length: columnCount }, () => undefined);
  let column = 0;
  for (const cell of cells) {
    alignment.fill(cell.align, column, column + cell.columnSpan);
    column += cell.columnSpan;
  }
  return alignment;
};

/**
 * The elements that become nodes, by tag, each with the function that turns a
 * closed element into the content it leaves behind. A tag that is not here is
 * dropped and its content stays.
 */
const ELEMENTS: ReadonlyMap<string, (element: OpenElement) => ElementContent[]> = new Map([
  ["strong", closeInlineWrapper("strong")],
  ["b", closeInlineWrapper("strong")],
  ["em", closeInlineWrapper("emphasis")],
  ["i", closeInlineWrapper("emphasis")],
  ["del", closeInlineWrapper("strikethrough")],
  ["s", closeInlineWrapper("strikethrough")],
  ["strike", closeInlineWrapper("strikethrough")],
  ["code", closeCode],
  ["a", closeLink],
  ["p", closeParagraph],
  ["div", closeParagraph],
  ["h1", closeHeading(1)],
  ["h2", closeHeading(2)],
  ["h3", closeHeading(3)],
  ["h4", closeHeading(4)],
  ["h5", closeHeading(5)],
  ["h6", closeHeading(6)],
  ["blockquote", closeBlockquote],
  ["ul", closeList],
  ["ol", closeList],
  ["li", closeListItem],
  ["pre", closePreformatted],
  ["details", closeDetails],
  ["summary", closeSummary],
  ["table", closeTable],
  ["thead", closeRowGroup],
  ["tbody", closeRowGroup],
  ["tfoot", closeRowGroup],
  ["tr", closeRow],
  ["th", closeCell],
  ["td", closeCell],
  // Their content is dropped.
  ["script", () => []],
  ["style", () => []],
]);

/**
 * Returns the image for an `img`. An image with a missing or unsafe `src`
 * leaves its alt text, as a markdown image does.
 */
const closeImage = (element: OpenElement): ElementContent[] => {
  const src = normalizeAddress(element.attributes.get("src") ?? "");
  const alt = element.attributes.get("alt") ?? "";
  if (src === "" || !isSafeAddress(src)) {
    return alt === "" ? [] : [wrapInline({ type: "text", text: alt })];
  }
  const width = parsePositiveInteger(element.attributes.get("width"));
  const height = parsePositiveInteger(element.attributes.get("height"));
  return [
    wrapInline({
      type: "image",
      src,
      alt,
      title: readAttribute(element, "title"),
      ...(width !== undefined && { width }),
      ...(height !== undefined && { height }),
    }),
  ];
};

/** The elements that have no closing tag, each with the function that makes the content it leaves. */
const VOID_ELEMENTS: ReadonlyMap<string, (element: OpenElement) => ElementContent[]> = new Map([
  ["br", () => [wrapInline({ type: "break" })]],
  ["hr", () => [wrapBlock({ type: "rule" })]],
  ["img", closeImage],
]);

/**
 * The open tags that close an element that was left open, each with the tags
 * of the elements they close, and the tags of the elements that stop the
 * search. `<li>one<li>two` is two items, and a `<tr>` ends the row before it.
 */
const IMPLIED_CLOSES: ReadonlyMap<
  string,
  { readonly closes: ReadonlyArray<string>; readonly stopsAt: ReadonlyArray<string> }
> = (() => {
  const cell = { closes: ["td", "th"], stopsAt: ["tr", "table"] };
  const rowGroup = { closes: ["thead", "tbody", "tfoot"], stopsAt: ["table"] };
  return new Map([
    ["li", { closes: ["li"], stopsAt: ["ul", "ol"] }],
    ["td", cell],
    ["th", cell],
    ["tr", { closes: ["tr"], stopsAt: ["table", "thead", "tbody", "tfoot"] }],
    ["thead", rowGroup],
    ["tbody", rowGroup],
    ["tfoot", rowGroup],
  ]);
})();

/**
 * Returns the index in `open` of the element that an open tag `tag` closes
 * without a close tag, or -1 when it closes none. The search goes from the
 * innermost element outwards and stops at the first element the tag closes or
 * may not look past.
 */
const findImpliedlyClosedElement = (open: ReadonlyArray<OpenElement>, tag: string): number => {
  const rule = IMPLIED_CLOSES.get(tag);
  if (rule === undefined) return -1;
  for (let index = open.length - 1; index >= 0; index--) {
    const openTag = open[index]?.tag ?? "";
    if (rule.closes.includes(openTag)) return index;
    if (rule.stopsAt.includes(openTag)) return -1;
  }
  return -1;
};

/**
 * How many elements may be open at once in one level of markdown tokens. A
 * tag that would open one more is dropped and its content kept. The count
 * starts again inside a quote or a list item, as each of those is a level of
 * its own, so this bounds the nesting of HTML only. The markdown parser bounds
 * the rest.
 */
const MAX_OPEN_ELEMENTS = 50;

/**
 * Walks the pieces in order and returns the content of their level. Each
 * piece that is a node joins the element open at that point. The tags of an
 * `html` piece open and close elements:
 *
 * - A close tag closes the nearest open element with its name, and every
 *   element opened inside that one. A close tag with no open element is
 *   ignored.
 * - An open tag closes the element it implies, see `IMPLIED_CLOSES`. No other
 *   tag closes an element by itself.
 * - `script` and `style` are dropped with their content when their close tag
 *   is in the same piece. If it is not, the tag is dropped and the content
 *   stays, since a lone `<script>` is prose and marked would otherwise hide
 *   the rest of the message from it.
 * - Whatever is open at the end of the pieces closes there, so a message cut
 *   short still parses.
 *
 * Text from HTML has its runs of spaces and line breaks collapsed to one
 * space, except inside `pre`.
 */
const nestPieces = <Node>(
  pieces: ReadonlyArray<HtmlPiece<Node>>,
  wrapNode: (node: Node) => ElementContent,
): ElementContent[] => {
  const root: OpenElement = { tag: "", attributes: new Map(), content: [] };
  const open: OpenElement[] = [];
  const findInnermostElement = () => open.at(-1) ?? root;
  const appendContent = (content: ReadonlyArray<ElementContent>) => {
    const target = findInnermostElement().content;
    for (const part of content) target.push(part);
  };
  const closeInnermostElement = () => {
    const element = open.pop();
    if (element !== undefined) appendContent(ELEMENTS.get(element.tag)?.(element) ?? []);
  };
  const closeElementsDownTo = (index: number) => {
    while (open.length > index) closeInnermostElement();
  };
  const appendText = (text: string) => {
    const isPreformatted = open.some((element) => element.tag === "pre");
    const shown = isPreformatted ? text : text.replace(/[ \t\n\r\f]+/g, " ");
    if (shown !== "") appendContent([wrapInline({ type: "text", text: shown })]);
  };
  const openElement = (element: OpenElement, selfClosing: boolean) => {
    const closeVoidElement = VOID_ELEMENTS.get(element.tag);
    if (closeVoidElement !== undefined) {
      appendContent(closeVoidElement(element));
      return;
    }
    if (!ELEMENTS.has(element.tag) || open.length >= MAX_OPEN_ELEMENTS) return;
    const impliedlyClosed = findImpliedlyClosedElement(open, element.tag);
    if (impliedlyClosed !== -1) closeElementsDownTo(impliedlyClosed);
    open.push(element);
    if (selfClosing) closeInnermostElement();
  };

  for (const piece of pieces) {
    if (piece.kind === "node") {
      appendContent([wrapNode(piece.node)]);
      continue;
    }
    for (const token of scanHtmlTags(piece.html)) {
      if (token.type === "text") {
        appendText(token.text);
      } else if (token.type === "openTag") {
        openElement(
          { tag: token.name, attributes: token.attributes, content: [] },
          token.selfClosing,
        );
      } else {
        const index = open.findLastIndex((element) => element.tag === token.name);
        if (index !== -1) closeElementsDownTo(index);
      }
    }
    // A script or style whose close tag is not in this piece is not a script:
    // `<script> tags are bad` is prose. Its content stays.
    const unclosedScript = open.findIndex(
      (element) => element.tag === "script" || element.tag === "style",
    );
    if (unclosedScript !== -1) {
      closeElementsDownTo(unclosedScript + 1);
      const script = open.pop();
      if (script !== undefined) appendContent(script.content);
    }
  }
  closeElementsDownTo(0);
  return root.content;
};
