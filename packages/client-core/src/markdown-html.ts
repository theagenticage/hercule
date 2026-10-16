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
 *   become one table. `colspan` and `rowspan` are ignored.
 * - `details` with its `summary` becomes a `details` block.
 *
 * HTML comments, `script` and `style` (with everything inside them) are
 * dropped. Any other element, such as `span`, `sub` or `form`, is dropped with
 * its text kept. An attribute outside the list above is ignored.
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
  isSafeAddress,
  normalizeAddress,
  trimTrailingNewlines,
} from "./markdown-text";
import type { ColumnAlignment, MarkdownBlock, MarkdownInline } from "./markdown-tree";

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
    ? convertToBlocks(nestPieces(pieces, (block) => ({ kind: "block", block })))
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
    ? convertToInlines(nestPieces(pieces, (inline) => ({ kind: "inline", inline })))
    : pieces.flatMap((piece) => (piece.kind === "node" ? [piece.node] : []));

const hasHtml = (pieces: ReadonlyArray<HtmlPiece<unknown>>): boolean =>
  pieces.some((piece) => piece.kind === "html");

// ---------------------------------------------------------------------------
// Scanning: HTML source to tags and text
// ---------------------------------------------------------------------------

/** What an HTML source is made of. Text and attribute values have their character references decoded. */
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
 * Reads what starts with the `<` at `start`. Returns undefined when it is not
 * markup, such as the `<` in `a < b`, which stays text.
 */
const readMarkup = (html: string, start: number): TagRead | undefined => {
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
    const close = html.indexOf(">", nameEnd);
    if (close === -1) return { end: html.length };
    const name = html.slice(start + 2, nameEnd).toLowerCase();
    return { end: close + 1, token: { type: "closeTag", name } };
  }
  if (isAsciiLetter(next)) return readOpenTag(html, start + 1);
  return undefined;
};

/**
 * Splits `html` into text, open tags and close tags, in order. Comments and
 * declarations are left out. A comment, a tag or a quoted attribute value that
 * is still open at the end of `html` is dropped to the end, so a comment cut
 * short in the middle of a tag shows no half tag. It never throws, and takes
 * time linear in the length of `html`.
 */
const scanHtmlTags = (html: string): HtmlToken[] => {
  const tokens: HtmlToken[] = [];
  let textStart = 0;
  let position = 0;
  const addText = (end: number) => {
    if (end > textStart) {
      tokens.push({ type: "text", text: decodeCharacterReferences(html.slice(textStart, end)) });
    }
  };
  for (;;) {
    const start = html.indexOf("<", position);
    if (start === -1) break;
    const read = readMarkup(html, start);
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
  readonly align: ColumnAlignment;
  /** Whether the cell is a `th`. */
  readonly isHeader: boolean;
}

/**
 * What an element, or a node from the markdown parser, leaves in the element
 * around it. Most are a block or an inline. The others are the parts of a
 * list, a details block and a table, which only their own parent reads. One
 * outside its parent is dropped.
 */
type Item =
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
  readonly items: Item[];
}

const blockItem = (block: MarkdownBlock): Item => ({ kind: "block", block });
const inlineItem = (inline: MarkdownInline): Item => ({ kind: "inline", inline });

/** Returns the attribute's value, or undefined when it is missing or empty. */
const readAttribute = (element: OpenElement, name: string): string | undefined => {
  const value = element.attributes.get(name);
  return value === undefined || value === "" ? undefined : value;
};

/** Returns a size in pixels from an attribute, or undefined unless it is a whole number above zero. */
const parsePixelSize = (value: string | undefined): number | undefined => {
  if (value === undefined || !/^[0-9]{1,5}$/.test(value.trim())) return undefined;
  const size = Number(value);
  return size > 0 ? size : undefined;
};

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

/** A run of inlines, or a block, as the items of an element read: what sits side by side as lines. */
type Segment =
  | { readonly kind: "inlines"; readonly inlines: MarkdownInline[] }
  | { readonly kind: "block"; readonly block: MarkdownBlock };

/**
 * Groups the inline items between blocks into runs, joining the text next to
 * each other. A run that shows nothing is dropped, which is the whitespace
 * between two tags. The parts of a list,
 * a details block and a table are dropped.
 */
const splitIntoSegments = (items: ReadonlyArray<Item>): Segment[] => {
  const segments: Segment[] = [];
  let run: MarkdownInline[] = [];
  const endRun = () => {
    if (!isBlankRun(run)) segments.push({ kind: "inlines", inlines: run });
    run = [];
  };
  for (const item of items) {
    if (item.kind === "inline") {
      const last = run.at(-1);
      if (item.inline.type === "text" && last?.type === "text") {
        run[run.length - 1] = { type: "text", text: last.text + item.inline.text };
      } else {
        run.push(item.inline);
      }
    } else if (item.kind === "block") {
      endRun();
      segments.push({ kind: "block", block: item.block });
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
          row.flatMap((cell, index) =>
            index === 0 ? cell : [{ type: "text", text: " " } as const, ...cell],
          ),
        ),
      );
    case "rule":
      return [];
  }
};

/**
 * Returns the blocks for an element's items. The inline items between two
 * blocks make a paragraph.
 */
const convertToBlocks = (items: ReadonlyArray<Item>): MarkdownBlock[] =>
  splitIntoSegments(items).map((segment): MarkdownBlock =>
    segment.kind === "block"
      ? segment.block
      : { type: "paragraph", children: trimInlines(segment.inlines) },
  );

/**
 * Returns the inlines for an element's items, for an element that holds only
 * inlines. A block among them becomes inlines with a line break around it.
 * Spaces at the ends stay, so `<b>a </b>b` keeps its space.
 */
const convertToInlines = (items: ReadonlyArray<Item>): MarkdownInline[] =>
  joinWithBreaks(
    splitIntoSegments(items).map((segment) =>
      segment.kind === "block" ? flattenBlock(segment.block) : segment.inlines,
    ),
  );

const createInlineWrapper =
  (type: "strong" | "emphasis" | "strikethrough") =>
  (element: OpenElement): Item[] => {
    const children = convertToInlines(element.items);
    return children.length === 0 ? [] : [inlineItem({ type, children })];
  };

const createHeadingMaker =
  (depth: 1 | 2 | 3 | 4 | 5 | 6) =>
  (element: OpenElement): Item[] => {
    const children = trimInlines(convertToInlines(element.items));
    return children.length === 0 ? [] : [blockItem({ type: "heading", depth, children })];
  };

const closeBlocks = (element: OpenElement): Item[] => convertToBlocks(element.items).map(blockItem);

const closeLink = (element: OpenElement): Item[] => {
  const children = convertToInlines(element.items);
  const href = normalizeAddress(element.attributes.get("href") ?? "");
  if (href === "" || !isSafeAddress(href)) return children.map(inlineItem);
  if (children.length === 0) return [];
  return [inlineItem({ type: "link", href, title: readAttribute(element, "title"), children })];
};

const closeCode = (element: OpenElement): Item[] => {
  const text = extractPlainText(convertToInlines(element.items));
  return text === "" ? [] : [inlineItem({ type: "inlineCode", text })];
};

const closeBlockquote = (element: OpenElement): Item[] => {
  const children = convertToBlocks(element.items);
  return children.length === 0 ? [] : [blockItem({ type: "blockquote", children })];
};

const closeList = (element: OpenElement): Item[] => {
  const items = element.items.flatMap((item) =>
    item.kind === "listItem" ? [{ children: item.blocks }] : [],
  );
  if (items.length === 0) return [];
  const startAttribute = element.attributes.get("start") ?? "";
  const start =
    element.tag === "ol" && /^[0-9]{1,9}$/.test(startAttribute)
      ? Number(startAttribute)
      : undefined;
  return [blockItem({ type: "list", start, loose: false, items })];
};

const closeListItem = (element: OpenElement): Item[] => [
  { kind: "listItem", blocks: convertToBlocks(element.items) },
];

const closePreformatted = (element: OpenElement): Item[] => {
  // A browser drops the line break right after <pre>.
  const text = trimTrailingNewlines(
    extractPlainText(convertToInlines(element.items)).replace(/^\r?\n/, ""),
  );
  return text === "" ? [] : [blockItem({ type: "code", text })];
};

const closeSummary = (element: OpenElement): Item[] => [
  { kind: "summary", inlines: trimInlines(convertToInlines(element.items)) },
];

const closeDetails = (element: OpenElement): Item[] => {
  const summary = element.items.find((item) => item.kind === "summary")?.inlines ?? [];
  return [
    blockItem({
      type: "details",
      summary: summary.length > 0 ? summary : [{ type: "text", text: "Details" }],
      children: convertToBlocks(element.items),
    }),
  ];
};

const closeCell = (element: OpenElement): Item[] => [
  {
    kind: "cell",
    cell: {
      inlines: trimInlines(convertToInlines(element.items)),
      align: parseAlignment(element.attributes.get("align")),
      isHeader: element.tag === "th",
    },
  },
];

const closeRow = (element: OpenElement): Item[] => [
  {
    kind: "row",
    cells: element.items.flatMap((item) => (item.kind === "cell" ? [item.cell] : [])),
    isHeader: false,
  },
];

const closeRowGroup = (element: OpenElement): Item[] =>
  element.items.flatMap((item): Item[] =>
    item.kind === "row" ? [{ ...item, isHeader: item.isHeader || element.tag === "thead" }] : [],
  );

/**
 * Returns the table block for the rows of a `table`. The header is the row in
 * a `thead`, or else the first row when all its cells are `th`, or else empty.
 * Every row is padded with empty cells to the widest row, and the alignment
 * of each column comes from the header, or else from the first row.
 */
const closeTable = (element: OpenElement): Item[] => {
  const rows = element.items.flatMap((item) =>
    item.kind === "row" && item.cells.length > 0 ? [item] : [],
  );
  const first = rows[0];
  const headerRow =
    rows.find((row) => row.isHeader) ??
    (first?.cells.every((cell) => cell.isHeader) ? first : undefined);
  const bodyRows = rows.filter((row) => row !== headerRow);
  const columnCount = rows.reduce((widest, row) => Math.max(widest, row.cells.length), 0);
  if (columnCount === 0) return [];
  const padCells = (row: { readonly cells: TableCell[] }) =>
    Array.from({ length: columnCount }, (_, column) => row.cells[column]?.inlines ?? []);
  const alignmentRow = headerRow ?? bodyRows[0];
  return [
    blockItem({
      type: "table",
      align: Array.from({ length: columnCount }, (_, column) => alignmentRow?.cells[column]?.align),
      header: headerRow === undefined ? [] : padCells(headerRow),
      rows: bodyRows.map(padCells),
    }),
  ];
};

/**
 * The elements that become nodes, by tag, each with the function that turns a
 * closed element into the items it leaves behind. A tag that is not here is
 * dropped and its content stays.
 */
const ELEMENTS: ReadonlyMap<string, (element: OpenElement) => Item[]> = new Map([
  ["strong", createInlineWrapper("strong")],
  ["b", createInlineWrapper("strong")],
  ["em", createInlineWrapper("emphasis")],
  ["i", createInlineWrapper("emphasis")],
  ["del", createInlineWrapper("strikethrough")],
  ["s", createInlineWrapper("strikethrough")],
  ["strike", createInlineWrapper("strikethrough")],
  ["code", closeCode],
  ["a", closeLink],
  ["p", closeBlocks],
  ["div", closeBlocks],
  ["h1", createHeadingMaker(1)],
  ["h2", createHeadingMaker(2)],
  ["h3", createHeadingMaker(3)],
  ["h4", createHeadingMaker(4)],
  ["h5", createHeadingMaker(5)],
  ["h6", createHeadingMaker(6)],
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
const closeImage = (element: OpenElement): Item[] => {
  const src = normalizeAddress(element.attributes.get("src") ?? "");
  const alt = element.attributes.get("alt") ?? "";
  if (src === "" || !isSafeAddress(src)) {
    return alt === "" ? [] : [inlineItem({ type: "text", text: alt })];
  }
  const width = parsePixelSize(element.attributes.get("width"));
  const height = parsePixelSize(element.attributes.get("height"));
  return [
    inlineItem({
      type: "image",
      src,
      alt,
      title: readAttribute(element, "title"),
      ...(width !== undefined && { width }),
      ...(height !== undefined && { height }),
    }),
  ];
};

/** The elements that have no closing tag, each with the function that makes the items it leaves. */
const VOID_ELEMENTS: ReadonlyMap<string, (element: OpenElement) => Item[]> = new Map([
  ["br", () => [inlineItem({ type: "break" })]],
  ["hr", () => [blockItem({ type: "rule" })]],
  ["img", closeImage],
]);

/**
 * How many elements may be open at once. A tag that would open one more is
 * dropped with its content kept, which keeps the tree shallow enough for the
 * apps to draw however deep the HTML nests.
 */
const MAX_OPEN_ELEMENTS = 50;

/**
 * Walks the pieces in order and returns the items of their level. Each piece
 * that is a node joins the element open at that point. The tags of an `html`
 * piece open and close elements:
 *
 * - A close tag closes the nearest open element with its name, and every
 *   element opened inside that one. A close tag with no open element is
 *   ignored.
 * - There are no implied closing tags: an unclosed `<li>` stays open until a
 *   close tag for an element around it, or the end of the pieces, closes it.
 * - Whatever is open at the end closes there, so a message cut short still
 *   parses.
 *
 * Text from HTML has its runs of spaces and line breaks collapsed to one
 * space, except inside `pre`.
 */
const nestPieces = <Node>(
  pieces: ReadonlyArray<HtmlPiece<Node>>,
  createItem: (node: Node) => Item,
): Item[] => {
  const root: OpenElement = { tag: "", attributes: new Map(), items: [] };
  const open: OpenElement[] = [];
  const current = () => open.at(-1) ?? root;
  const addItems = (items: ReadonlyArray<Item>) => {
    const target = current().items;
    for (const item of items) target.push(item);
  };
  const closeCurrent = () => {
    const element = open.pop();
    if (element !== undefined) addItems(ELEMENTS.get(element.tag)?.(element) ?? []);
  };
  const addText = (text: string) => {
    const isPreformatted = open.some((element) => element.tag === "pre");
    const shown = isPreformatted ? text : text.replace(/[ \t\n\r\f]+/g, " ");
    if (shown !== "") addItems([inlineItem({ type: "text", text: shown })]);
  };

  for (const piece of pieces) {
    if (piece.kind === "node") {
      addItems([createItem(piece.node)]);
      continue;
    }
    for (const token of scanHtmlTags(piece.html)) {
      if (token.type === "text") {
        addText(token.text);
      } else if (token.type === "openTag") {
        const element: OpenElement = { tag: token.name, attributes: token.attributes, items: [] };
        const makeVoidItems = VOID_ELEMENTS.get(token.name);
        if (makeVoidItems !== undefined) {
          addItems(makeVoidItems(element));
        } else if (ELEMENTS.has(token.name) && open.length < MAX_OPEN_ELEMENTS) {
          open.push(element);
          if (token.selfClosing) closeCurrent();
        }
      } else {
        const index = open.findLastIndex((element) => element.tag === token.name);
        while (index !== -1 && open.length > index) closeCurrent();
      }
    }
  }
  while (open.length > 0) closeCurrent();
  return root.items;
};
