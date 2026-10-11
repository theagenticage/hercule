/**
 * Prose written by an agent, a user or a notification's producer, rendered as
 * markdown: a thread's answers, a message bubble, an assistant's messages, a
 * notification's body.
 *
 * `parseMarkdown` in `@hercule/client-core` parses the text with marked's
 * lexer into a small tree of plain data. This file only draws that tree as
 * React elements, never as an HTML string. Raw HTML is already text in the
 * tree, so a `<script>` from an agent is shown as characters, and nothing
 * here can turn text into markup.
 *
 * The elements get design-language classes directly instead of a prose
 * plugin: agents emit only a small set of elements, and every class below is
 * already used elsewhere in the app.
 */
import { parseMarkdown } from "@hercule/client-core";
import type { ColumnAlignment, MarkdownBlock, MarkdownInline } from "@hercule/client-core";
import { Component, Fragment, memo, useId, type JSX, type ReactNode } from "react";

/** The gap between two blocks, with no gap above the first block in its container. */
const STACKED = "mt-3 first:mt-0";

/** A heading has more space above it than below, which groups it with the text that follows. */
const HEADING = "mt-5 first:mt-0";

// The heading sizes stay small, with the largest one step above the body
// text: an answer is prose with sections, not a document, and the thread's
// title is just above in the chrome. Headings stand out through the space
// above them and their weight, not their size.
const HEADINGS = {
  1: `${HEADING} text-lead font-emph text-ink`,
  2: `${HEADING} text-body font-emph text-ink`,
  3: `${HEADING} font-emph text-ink`,
  4: `${HEADING} font-emph text-ink`,
  5: `${HEADING} font-emph text-ink`,
  6: `${HEADING} font-emph text-ink`,
} as const;

const PARAGRAPH = `${STACKED} leading-relaxed`;

const LINK = "underline decoration-line underline-offset-[3px]";

// Weight 500, not the browser's 700: heavier bold looks cramped in this font.
const STRONG = "font-emph";

const INLINE_TAGS = { strong: "strong", emphasis: "em", strikethrough: "del" } as const;

// A translucent tint rather than an opaque chip, because inline code
// appears both on the page and inside the user's bubble. A translucent
// colour shows on both backgrounds; an opaque one would vanish on one of them.
const INLINE_CODE = "rounded-control bg-line-soft px-1 py-px font-mono text-[0.92em]";

/**
 * The classes for a fenced code block, the only card in the prose. It uses the
 * same tokens as the user's message bubble. The `<code>` inside it keeps the
 * inline-code class, and these overrides remove its chip styling, because a
 * fenced block is already in a card.
 */
const FENCE =
  `${STACKED} overflow-x-auto rounded-card border border-line-soft bg-surface px-3 py-2.5 ` +
  "font-mono text-fine leading-relaxed [&_code]:rounded-none [&_code]:bg-transparent " +
  "[&_code]:px-0 [&_code]:py-0 [&_code]:text-[length:inherit]";

const BULLETED_LIST = `${STACKED} list-disc space-y-1 pl-5 marker:text-faint`;
const NUMBERED_LIST = `${STACKED} list-decimal space-y-1 pl-5 marker:text-faint`;

// A nested list belongs to its list item, so it sits closer to the item
// than two blocks of prose sit to each other.
const LIST_ITEM = "leading-relaxed [&>ul]:mt-1 [&>ol]:mt-1";

const QUOTE = `${STACKED} border-l-2 border-line-soft pl-3 text-muted`;

// A wide table scrolls on its own rather than widening the column.
const TABLE_SCROLLER = `${STACKED} overflow-x-auto`;

const CELL = "border border-line-soft px-2 py-1 align-top";
const HEADER_CELL = `${CELL} font-emph`;

// A column's alignment is a class and never an inline `style`, so markdown
// written by an agent never reaches a style attribute. The controller's
// Content-Security-Policy allows inline styles only because the workflow
// editor needs them. The app's own markup uses classes only, so a stricter
// policy would break nothing. A column with no alignment reads as left.
const ALIGNMENT = { left: "text-left", center: "text-center", right: "text-right" } as const;

/**
 * Draws a run of inline elements. `idPrefix` makes the ids of footnote
 * references unique to one message, because two messages on a screen both have
 * a footnote 1.
 */
const drawInlines = (inlines: ReadonlyArray<MarkdownInline>, idPrefix: string): ReactNode =>
  inlines.map((inline, index) => <Fragment key={index}>{drawInline(inline, idPrefix)}</Fragment>);

/** Draws one inline element. Its return type has no `undefined`, so a missing case fails to compile. */
const drawInline = (inline: MarkdownInline, idPrefix: string): string | JSX.Element => {
  switch (inline.type) {
    case "text":
      return inline.text;
    case "strong":
    case "emphasis":
    case "strikethrough": {
      const Tag = INLINE_TAGS[inline.type];
      return (
        <Tag className={inline.type === "strong" ? STRONG : undefined}>
          {drawInlines(inline.children, idPrefix)}
        </Tag>
      );
    }
    case "inlineCode":
      return <code className={INLINE_CODE}>{inline.text}</code>;
    case "break":
      return <br />;
    case "link":
      // The agent writes the link text, and the target may not match it, so a
      // click opens a new tab and sends no referrer. A link within the page,
      // such as a footnote number and its back link, stays in this tab:
      // opening it in a new tab would open a second copy of the app.
      return (
        <a
          href={inline.href}
          title={inline.title}
          {...(inline.href.startsWith("#") ? {} : { target: "_blank", rel: "noreferrer" })}
          className={LINK}
        >
          {drawInlines(inline.children, idPrefix)}
        </a>
      );
    case "image":
      // No referrer, so reading a message does not tell the image's host which page was read.
      return (
        <img src={inline.src} alt={inline.alt} title={inline.title} referrerPolicy="no-referrer" />
      );
    case "checkbox":
      // Disabled: the message is a record, not a form.
      return (
        <>
          <input type="checkbox" checked={inline.checked} disabled />{" "}
        </>
      );
    case "footnoteReference":
      return (
        <sup>
          <a
            href={`#${idPrefix}fn-${inline.number}`}
            id={inline.isFirstReference ? `${idPrefix}fnref-${inline.number}` : undefined}
            aria-describedby={`${idPrefix}footnote-label`}
            className={LINK}
          >
            {inline.number}
          </a>
        </sup>
      );
    case "footnoteBackReference":
      return (
        <>
          {" "}
          <a
            href={`#${idPrefix}fnref-${inline.number}`}
            aria-label={`Back to reference ${inline.number}`}
            className={LINK}
          >
            ↩
          </a>
        </>
      );
  }
};

/** Draws blocks one after another, with no wrapper element. */
const drawBlocks = (blocks: ReadonlyArray<MarkdownBlock>, idPrefix: string): ReactNode =>
  blocks.map((block, index) => <Fragment key={index}>{drawBlock(block, idPrefix)}</Fragment>);

/** Draws one block. Its return type has no `undefined`, so a missing case fails to compile. */
const drawBlock = (block: MarkdownBlock, idPrefix: string): JSX.Element => {
  switch (block.type) {
    case "paragraph":
      return <p className={PARAGRAPH}>{drawInlines(block.children, idPrefix)}</p>;
    case "heading": {
      const Heading = `h${block.depth}` as const;
      return (
        <Heading className={HEADINGS[block.depth]}>{drawInlines(block.children, idPrefix)}</Heading>
      );
    }
    case "list": {
      const items = block.items.map((item, index) => (
        <li key={index} className={LIST_ITEM}>
          {item.children.map((child, childIndex) => (
            <Fragment key={childIndex}>
              {
                // A tight list shows an item's paragraphs as bare text.
                child.type === "paragraph" && !block.loose
                  ? drawInlines(child.children, idPrefix)
                  : drawBlock(child, idPrefix)
              }
            </Fragment>
          ))}
        </li>
      ));
      return block.start === undefined ? (
        <ul className={BULLETED_LIST}>{items}</ul>
      ) : (
        <ol start={block.start === 1 ? undefined : block.start} className={NUMBERED_LIST}>
          {items}
        </ol>
      );
    }
    case "blockquote":
      return <blockquote className={QUOTE}>{drawBlocks(block.children, idPrefix)}</blockquote>;
    case "code":
      return (
        <pre className={FENCE}>
          <code className={INLINE_CODE}>{block.text}</code>
        </pre>
      );
    case "table":
      return (
        <div className={TABLE_SCROLLER}>
          <table className="w-full border-collapse">
            <thead>{drawTableRow(block.header, block.align, "th", idPrefix)}</thead>
            {block.rows.length > 0 && (
              <tbody>
                {block.rows.map((row, index) => (
                  <Fragment key={index}>{drawTableRow(row, block.align, "td", idPrefix)}</Fragment>
                ))}
              </tbody>
            )}
          </table>
        </div>
      );
    case "rule":
      return <hr className={`${STACKED} border-line`} />;
  }
};

/** Draws a header row (`th`) or a body row (`td`), each cell aligned as its column is. */
const drawTableRow = (
  cells: ReadonlyArray<ReadonlyArray<MarkdownInline>>,
  align: ReadonlyArray<ColumnAlignment>,
  Cell: "th" | "td",
  idPrefix: string,
): JSX.Element => (
  <tr>
    {cells.map((cell, column) => (
      <Cell
        key={column}
        className={`${Cell === "th" ? HEADER_CELL : CELL} ${ALIGNMENT[align[column] ?? "left"]}`}
      >
        {drawInlines(cell, idPrefix)}
      </Cell>
    ))}
  </tr>
);

/**
 * An error boundary that shows the raw text when the markdown fails to render.
 *
 * Deeply nested markdown, such as a few thousand `>` in a row, overflows the
 * stack inside the parser, and the error is thrown while React is rendering.
 * Without this boundary, the router's failure screen would replace the whole
 * thread screen. Because the message stays in the transcript, that would
 * happen again on every reload, so one answer would make the thread
 * permanently unreadable. Showing the raw text keeps the answer readable and
 * the rest of the thread intact.
 */
class PlainTextOnError extends Component<
  { readonly text: string; readonly children: ReactNode },
  { readonly failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { readonly failed: boolean } {
    return { failed: true };
  }

  override componentDidUpdate(previous: { readonly text: string }): void {
    if (previous.text !== this.props.text && this.state.failed) {
      this.setState({ failed: false });
    }
  }

  override render(): ReactNode {
    return this.state.failed ? (
      <p className={`${STACKED} whitespace-pre-wrap`}>{this.props.text}</p>
    ) : (
      this.props.children
    );
  }
}

/**
 * Parses `text` and draws the tree: the blocks, then the footnotes they
 * reference. It is a component of its own so the error boundary above it
 * catches both a parser that throws on text nested deeper than its stack and
 * React overflowing the stack while drawing a very deep tree.
 */
function MarkdownTree({ text, breaks }: { text: string; breaks: boolean }): JSX.Element {
  // React's ids contain characters such as ":" that are awkward in a URL
  // fragment. The prefix keeps the footnote ids of two messages on one screen apart.
  const idPrefix = `${useId().replace(/[^A-Za-z0-9_-]/g, "")}-`;
  const { blocks, footnotes } = parseMarkdown(text, { breaks });
  const footnoteLabelId = `${idPrefix}footnote-label`;
  return (
    <>
      {drawBlocks(blocks, idPrefix)}
      {footnotes.length > 0 && (
        <section aria-labelledby={footnoteLabelId}>
          <h2 id={footnoteLabelId} className="sr-only">
            Footnotes
          </h2>
          <ol className={NUMBERED_LIST}>
            {footnotes.map(({ number, children }) => (
              <li key={number} id={`${idPrefix}fn-${number}`} className={LIST_ITEM}>
                {drawBlocks(children, idPrefix)}
              </li>
            ))}
          </ol>
        </section>
      )}
    </>
  );
}

/**
 * Renders markdown prose.
 *
 * The thread rebuilds every turn from the transcript whenever a new row
 * arrives, and parsing is the expensive part of rendering a turn. The React
 * Compiler already caches this element by its text; `memo` keeps that caching
 * even when the compiler could not compile the parent component.
 */
export const Markdown = memo(function Markdown({
  text,
  breaks = false,
}: {
  readonly text: string;
  /**
   * Renders a single newline as a line break. In the composer, ⇧⏎ is the only
   * way to type a newline, so a newline in the user's message is deliberate,
   * and CommonMark would otherwise collapse it into a space. An agent's prose
   * keeps CommonMark's behaviour, because that is what the agent meant.
   */
  readonly breaks?: boolean;
}): JSX.Element {
  // The blocks are returned without a wrapper, so the caller's element is
  // their direct parent. The thread's live tail must sit beside them as a
  // sibling; a wrapper here would separate it from the prose it continues.
  return (
    <PlainTextOnError text={text}>
      <MarkdownTree text={text} breaks={breaks} />
    </PlainTextOnError>
  );
});
