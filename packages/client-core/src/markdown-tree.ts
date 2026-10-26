/**
 * The tree that `parseMarkdown` produces: plain data that each app draws as
 * React elements in its own look. See `markdown.ts` for what goes into it and
 * what stays out.
 */

/** The alignment a table's delimiter row sets for a column, or undefined when it sets none. */
export type ColumnAlignment = "left" | "center" | "right" | undefined;

/**
 * A block of a message: a paragraph, a heading, a list, a quote, a code block,
 * a table, a rule, or a collapsible `details` block from embedded HTML.
 */
export type MarkdownBlock =
  | { readonly type: "paragraph"; readonly children: ReadonlyArray<MarkdownInline> }
  | {
      readonly type: "heading";
      readonly depth: 1 | 2 | 3 | 4 | 5 | 6;
      readonly children: ReadonlyArray<MarkdownInline>;
    }
  | {
      readonly type: "list";
      /**
       * The first item's number in a numbered list, or undefined in a bulleted
       * list. It is 1 for a list that gives no number, and can be zero or below
       * for a list written in HTML.
       */
      readonly start: number | undefined;
      /**
       * Whether blank lines separate the items. In a tight list, an item's
       * paragraphs are drawn as bare text, with no paragraph spacing.
       */
      readonly loose: boolean;
      readonly items: ReadonlyArray<MarkdownListItem>;
    }
  | { readonly type: "blockquote"; readonly children: ReadonlyArray<MarkdownBlock> }
  /**
   * A fenced or indented code block. Its text is exactly as written, with no
   * trailing newline. `language` is the first word of a fenced block's info
   * string with character references decoded: `ts` for both "```ts" and
   * "```ts title="a.ts"". It is left out when the block names no language: an
   * indented block, a bare fence, an info string of only white space, or an
   * HTML `<pre>`.
   */
  | { readonly type: "code"; readonly text: string; readonly language?: string }
  | {
      readonly type: "table";
      /**
       * The header row's cells, then the body rows' cells. The header is empty
       * for a table written in HTML without a header row. Every row covers the
       * same number of columns: the `columnSpan`s of its cells add up to the
       * table's width, and a short row ends in one empty cell that covers the
       * rest.
       */
      readonly header: ReadonlyArray<MarkdownTableCell>;
      readonly rows: ReadonlyArray<ReadonlyArray<MarkdownTableCell>>;
    }
  | { readonly type: "rule" }
  /**
   * A block that collapses to its one-line `summary` and opens to show its
   * `children`, from a `<details>` element. A `<details>` without a
   * `<summary>` gets the summary text "Details", as a browser draws it.
   */
  | {
      readonly type: "details";
      readonly summary: ReadonlyArray<MarkdownInline>;
      readonly children: ReadonlyArray<MarkdownBlock>;
    };

/** One cell of a table: a run of inlines, in one or more columns, with the alignment of its first column. */
export interface MarkdownTableCell {
  readonly children: ReadonlyArray<MarkdownInline>;
  /** How many columns the cell covers: 1, unless an HTML cell has a `colspan`. */
  readonly columnSpan: number;
  /** The alignment of the cell's first column: from a markdown table's delimiter row, or an HTML header row's cells. */
  readonly align: ColumnAlignment;
}

/**
 * An item of a list. A task item's box is a `checkbox` inline at the start of
 * the item's first paragraph.
 */
export interface MarkdownListItem {
  readonly children: ReadonlyArray<MarkdownBlock>;
}

/** An inline element: text, its markup, a link, an image, a skill or a footnote's mark. */
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
  /**
   * An image whose address passed the same check as a link's, encoded the same
   * way. `width` and `height` are in pixels. They are set only for an HTML
   * `<img>` that gives a whole number, and are left out for any other value.
   */
  | {
      readonly type: "image";
      readonly src: string;
      readonly alt: string;
      readonly title: string | undefined;
      readonly width?: number;
      readonly height?: number;
    }
  /**
   * A Skill Reference, `$review` or `$webshop:release`, that names a skill the
   * caller listed in `skillNames`. `name` is the token without its `$`. The
   * parser makes one only on request, so agent messages and the web app never
   * hold one.
   */
  | { readonly type: "skill"; readonly name: string }
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
