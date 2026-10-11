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
import type {
  ColumnAlignment,
  MarkdownBlock,
  MarkdownFootnote,
  MarkdownInline,
  MarkdownListItem,
} from "@hercule/client-core";
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

// The agent writes the link text, and the target may not match it, so a
// click opens a new tab and sends no referrer. A link within the page, such
// as a footnote number and its back link, stays in this tab: opening it in
// a new tab would open a second copy of the app.
const LINK = "underline decoration-line underline-offset-[3px]";

// Weight 500, not the browser's 700: heavier bold looks cramped in this font.
const STRONG = "font-emph";

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

// A column's alignment is a class and never an inline `style`, so markdown
// written by an agent never reaches a style attribute. The controller's
// Content-Security-Policy allows inline styles only because the workflow
// editor needs them. The app's own markup uses classes only, so a stricter
// policy would break nothing. A column with no alignment reads as left.
const ALIGNMENT = { left: "text-left", center: "text-center", right: "text-right" } as const;

/** What a paragraph is drawn with besides its own text. */
interface ParagraphExtras {
  /** Draws the text with no `<p>` around it, as a tight list item shows it. */
  readonly bare?: boolean;
  /** Goes before the text, such as a task item's checkbox. */
  readonly lead?: ReactNode;
  /** Goes after the text, inside the same paragraph, such as a footnote's back link. */
  readonly tail?: ReactNode;
}

/** Throws for a node type the drawing functions do not handle, so the compiler flags a new type. */
const failUnhandled = (node: never): never => {
  throw new Error(`Unhandled markdown node: ${JSON.stringify(node)}`);
};

/**
 * Draws inline content. `prefix` makes the ids of footnote references unique
 * to one message, because two messages on a screen both have a footnote 1.
 */
const renderInlines = (inlines: ReadonlyArray<MarkdownInline>, prefix: string): ReactNode[] =>
  inlines.map((inline, index) => renderInline(inline, index, prefix));

/** Draws one inline element, or returns its text. */
const renderInline = (inline: MarkdownInline, key: number, prefix: string): ReactNode => {
  switch (inline.type) {
    case "text":
      return inline.text;
    case "strong":
      return (
        <strong key={key} className={STRONG}>
          {renderInlines(inline.children, prefix)}
        </strong>
      );
    case "emphasis":
      return <em key={key}>{renderInlines(inline.children, prefix)}</em>;
    case "strikethrough":
      return <del key={key}>{renderInlines(inline.children, prefix)}</del>;
    case "inlineCode":
      return (
        <code key={key} className={INLINE_CODE}>
          {inline.text}
        </code>
      );
    case "break":
      return <br key={key} />;
    case "link":
      return (
        <a
          key={key}
          href={inline.href}
          {...(inline.href.startsWith("#") ? {} : { target: "_blank", rel: "noreferrer" })}
          className={LINK}
        >
          {renderInlines(inline.children, prefix)}
        </a>
      );
    case "image":
      // No referrer, so reading a message does not tell the image's host which page was read.
      return <img key={key} src={inline.src} alt={inline.alt} referrerPolicy="no-referrer" />;
    case "footnoteReference":
      return (
        <sup key={key}>
          <a
            href={`#${prefix}fn-${inline.number}`}
            id={inline.isFirstReference ? `${prefix}fnref-${inline.number}` : undefined}
            aria-describedby={`${prefix}footnote-label`}
            className={LINK}
          >
            {inline.number}
          </a>
        </sup>
      );
    default:
      return failUnhandled(inline);
  }
};

/** Draws blocks one after another, with no wrapper element. */
const renderBlocks = (blocks: ReadonlyArray<MarkdownBlock>, prefix: string): ReactNode[] =>
  blocks.map((block, index) => renderBlock(block, index, prefix));

/** Draws one block. `extras` applies to a paragraph and is ignored for any other block. */
const renderBlock = (
  block: MarkdownBlock,
  key: number,
  prefix: string,
  extras: ParagraphExtras = {},
): ReactNode => {
  switch (block.type) {
    case "paragraph": {
      const content = (
        <>
          {extras.lead}
          {renderInlines(block.children, prefix)}
          {extras.tail}
        </>
      );
      return extras.bare === true ? (
        <Fragment key={key}>{content}</Fragment>
      ) : (
        <p key={key} className={PARAGRAPH}>
          {content}
        </p>
      );
    }
    case "heading": {
      const Heading = `h${block.depth}` as const;
      return (
        <Heading key={key} className={HEADINGS[block.depth]}>
          {renderInlines(block.children, prefix)}
        </Heading>
      );
    }
    case "list": {
      const items = block.items.map((item, index) =>
        renderListItem(item, index, block.loose, prefix),
      );
      return block.start === undefined ? (
        <ul key={key} className={BULLETED_LIST}>
          {items}
        </ul>
      ) : (
        <ol key={key} start={block.start === 1 ? undefined : block.start} className={NUMBERED_LIST}>
          {items}
        </ol>
      );
    }
    case "blockquote":
      return (
        <blockquote key={key} className={QUOTE}>
          {renderBlocks(block.children, prefix)}
        </blockquote>
      );
    case "code":
      return (
        <pre key={key} className={FENCE}>
          <code className={INLINE_CODE}>{block.text}</code>
        </pre>
      );
    case "table":
      return (
        <div key={key} className={TABLE_SCROLLER}>
          <table className="w-full border-collapse">
            <thead>
              <tr>
                {block.header.map((cell, column) =>
                  renderTableCell("th", column, cell, block.align[column], prefix),
                )}
              </tr>
            </thead>
            {block.rows.length > 0 && (
              <tbody>
                {block.rows.map((row, index) => (
                  <tr key={index}>
                    {row.map((cell, column) =>
                      renderTableCell("td", column, cell, block.align[column], prefix),
                    )}
                  </tr>
                ))}
              </tbody>
            )}
          </table>
        </div>
      );
    case "rule":
      return <hr key={key} className={`${STACKED} border-line`} />;
    default:
      return failUnhandled(block);
  }
};

/**
 * Draws a list item. In a tight list its paragraphs are bare text, and a task
 * item starts with its checkbox. The checkbox is disabled: the message is a
 * record, not a form.
 */
const renderListItem = (
  item: MarkdownListItem,
  key: number,
  loose: boolean,
  prefix: string,
): ReactNode => {
  const checkbox =
    item.checked === undefined ? null : (
      <>
        <input type="checkbox" checked={item.checked} disabled />{" "}
      </>
    );
  return (
    <li key={key} className={LIST_ITEM}>
      {item.children[0]?.type === "paragraph" ? null : checkbox}
      {item.children.map((child, index) =>
        renderBlock(child, index, prefix, { bare: !loose, lead: index === 0 ? checkbox : null }),
      )}
    </li>
  );
};

/** Draws a header or body cell, aligned by its column's alignment. */
const renderTableCell = (
  tag: "th" | "td",
  key: number,
  cell: ReadonlyArray<MarkdownInline>,
  alignment: ColumnAlignment,
  prefix: string,
): ReactNode => {
  const Cell = tag;
  const className = `${tag === "th" ? `${CELL} font-emph` : CELL} ${ALIGNMENT[alignment ?? "left"]}`;
  return (
    <Cell key={key} className={className}>
      {renderInlines(cell, prefix)}
    </Cell>
  );
};

/**
 * Draws the footnotes after the blocks: a section with a visually hidden
 * heading, and a numbered list. Each footnote ends with a link back to its
 * first reference, inside its last paragraph when it ends with one.
 */
const renderFootnotes = (footnotes: ReadonlyArray<MarkdownFootnote>, prefix: string): ReactNode => {
  const labelId = `${prefix}footnote-label`;
  return (
    <section aria-labelledby={labelId}>
      <h2 id={labelId} className={`sr-only ${HEADINGS[2]}`}>
        Footnotes
      </h2>
      <ol className={NUMBERED_LIST}>
        {footnotes.map(({ number, children }) => {
          const backLink = (
            <>
              {" "}
              <a
                href={`#${prefix}fnref-${number}`}
                aria-label={`Back to reference ${number}`}
                className={LINK}
              >
                ↩
              </a>
            </>
          );
          const endsWithParagraph = children.at(-1)?.type === "paragraph";
          return (
            <li key={number} id={`${prefix}fn-${number}`} className={LIST_ITEM}>
              {children.map((child, index) =>
                renderBlock(child, index, prefix, {
                  tail: endsWithParagraph && index === children.length - 1 ? backLink : null,
                }),
              )}
              {endsWithParagraph ? null : backLink}
            </li>
          );
        })}
      </ol>
    </section>
  );
};

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
class Legible extends Component<
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
 * Parses and draws `text`. It renders below the error boundary on purpose: the
 * parser throws on text nested deeper than its stack, and React can overflow
 * while drawing a very deep tree, and the boundary must catch both.
 */
function ParsedMarkdown({ text, breaks }: { text: string; breaks: boolean }): JSX.Element {
  // React's ids contain characters such as ":" that are awkward in a URL
  // fragment. The prefix keeps the footnote ids of two messages on one screen apart.
  const prefix = `${useId().replace(/[^A-Za-z0-9_-]/g, "")}-`;
  const { blocks, footnotes } = parseMarkdown(text, { breaks });
  return (
    <>
      {renderBlocks(blocks, prefix)}
      {footnotes.length > 0 && renderFootnotes(footnotes, prefix)}
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
    <Legible text={text}>
      <ParsedMarkdown text={text} breaks={breaks} />
    </Legible>
  );
});
