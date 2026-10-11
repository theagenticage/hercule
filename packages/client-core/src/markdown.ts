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
  | { readonly type: "link"; readonly href: string; readonly children: ReadonlyArray<MarkdownInline> }
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

/**
 * Parses `text` as GitHub-flavoured markdown with footnotes.
 *
 * With `breaks`, a single newline inside a paragraph becomes a line break, as
 * in the user's message bubble, where a newline is deliberate. Without it, a
 * single newline joins the two lines with a space, as CommonMark says.
 *
 * Throws a `RangeError` when the text nests deeper than the parser's stack,
 * such as a few thousand `>` in a row. The caller draws the raw text instead.
 */
export const parseMarkdown = (
  text: string,
  { breaks = false }: { readonly breaks?: boolean } = {},
): MarkdownDocument => {
  throw new Error(`parseMarkdown is not implemented yet (${text.length}, ${String(breaks)})`);
};
