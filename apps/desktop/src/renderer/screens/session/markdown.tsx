/**
 * Prose in a session's messages, rendered as markdown: an agent's message and
 * the user's bubble, in the thread's transcript and in an assistant's
 * Conversation. Intake's open signal draws its text the same way.
 *
 * marked's lexer, in `@hercule/client-core`, parses the text into a tree of
 * plain data, and this file draws that tree as React elements. No text ever
 * reaches the page as markup: raw HTML is text in the tree by construction,
 * so a `<script>` from an agent shows as plain text, and an address that is
 * not safe to open is not in the tree.
 *
 * The elements carry no classes, with three exceptions. `messages.css`
 * styles them through their container, `.msg-body` or `.bubble`, as the
 * Bureau book does.
 */
import { Component, Fragment, memo, useId, type JSX, type ReactNode } from "react";
import {
  parseMarkdown,
  type MarkdownBlock,
  type MarkdownInline,
  type MarkdownTableCell,
} from "@hercule/client-core";

/** What drawing a message needs besides the tree. */
interface DrawContext {
  /**
   * Starts the id of every footnote and reference, so two messages on screen
   * never share an id.
   */
  readonly idPrefix: string;
  /** Shows https images inline rather than as links, as an open signal's blocks do. */
  readonly inlineImages: boolean;
}

/** What a paragraph or an item can be given besides its own text. */
interface BlockExtras {
  /** Draws a list item's paragraphs as bare text, with no `<p>`. */
  readonly tight?: boolean;
  /** Content drawn before the blocks' first paragraph, such as a task item's checkbox. */
  readonly lead?: ReactNode;
  /** Content drawn after the blocks' last paragraph, such as a footnote's back link. */
  readonly tail?: ReactNode;
}

/** Renders an image as a link to it, or its alt text alone when it has no address. */
function ImageLink({ src, alt }: { readonly src: string; readonly alt: string }): JSX.Element {
  return src !== "" ? (
    <a href={src} target="_blank" rel="noreferrer">
      {alt === "" ? src : alt}
    </a>
  ) : (
    <>{alt}</>
  );
}

/**
 * Draws one run of text inside a block.
 *
 * - A link opens in the default browser, where the address is visible, and
 *   sends no referrer, because the agent writes both the link text and its
 *   target. Main's window-open handler takes the link there. A link within
 *   the message, such as a footnote and its back link, stays in the window.
 * - Loading an image tells its host that the user is reading the text, so
 *   only an open signal's blocks show images inline, and only over https:
 *   the window's content security policy loads no other image. Anywhere else
 *   an image shows as a link to it, named by its alt text, or by its address
 *   when it has none. The inline image is fetched with no referrer.
 */
function drawInline(inline: MarkdownInline, context: DrawContext): ReactNode {
  switch (inline.type) {
    case "text":
      return inline.text;
    case "strong":
      return <strong>{drawInlines(inline.children, context)}</strong>;
    case "emphasis":
      return <em>{drawInlines(inline.children, context)}</em>;
    case "strikethrough":
      return <del>{drawInlines(inline.children, context)}</del>;
    case "inlineCode":
      return <code>{inline.text}</code>;
    case "break":
      return <br />;
    case "link":
      return (
        <a
          href={inline.href}
          {...(inline.href.startsWith("#") ? {} : { target: "_blank", rel: "noreferrer" })}
        >
          {drawInlines(inline.children, context)}
        </a>
      );
    case "image":
      return context.inlineImages && inline.src.startsWith("https://") ? (
        <img src={inline.src} alt={inline.alt} referrerPolicy="no-referrer" />
      ) : (
        <ImageLink src={inline.src} alt={inline.alt} />
      );
    case "footnoteReference":
      return (
        <sup>
          <a
            href={`#${context.idPrefix}fn-${inline.number}`}
            id={inline.isFirstReference ? `${context.idPrefix}fnref-${inline.number}` : undefined}
          >
            {inline.number}
          </a>
        </sup>
      );
    default:
      return inline satisfies never;
  }
}

/** Draws a run of text, in order. */
function drawInlines(inlines: ReadonlyArray<MarkdownInline>, context: DrawContext): ReactNode {
  return inlines.map((inline, index) => (
    <Fragment key={index}>{drawInline(inline, context)}</Fragment>
  ));
}

/** Draws a table cell with the alignment its column sets, if any. */
function drawCell(
  Tag: "th" | "td",
  cell: MarkdownTableCell,
  align: "left" | "center" | "right" | undefined,
  context: DrawContext,
): JSX.Element {
  // The alignment is an attribute that `messages.css` reads, never a `style`:
  // an agent's markdown must not reach a style attribute.
  return <Tag data-align={align}>{drawInlines(cell, context)}</Tag>;
}

/**
 * Draws one block. Only a paragraph reads `extras`.
 *
 * A fence is the book's `.codeblock`, with no syntax colours: the book's
 * colours are sample highlighting, and no highlighter is loaded.
 */
function drawBlock(block: MarkdownBlock, context: DrawContext, extras: BlockExtras): ReactNode {
  switch (block.type) {
    case "paragraph": {
      const content = (
        <>
          {extras.lead}
          {drawInlines(block.children, context)}
          {extras.tail}
        </>
      );
      return extras.tight ? content : <p>{content}</p>;
    }
    case "heading": {
      const Tag = `h${block.depth}` as const;
      return <Tag>{drawInlines(block.children, context)}</Tag>;
    }
    case "list": {
      const items = block.items.map((item, index) => (
        <li key={index}>
          {drawBlocks(item.children, context, {
            tight: !block.loose,
            lead:
              item.checked === undefined ? null : (
                <>
                  <input type="checkbox" checked={item.checked} disabled />{" "}
                </>
              ),
          })}
        </li>
      ));
      return block.start === undefined ? (
        <ul>{items}</ul>
      ) : (
        <ol start={block.start === 1 ? undefined : block.start}>{items}</ol>
      );
    }
    case "blockquote":
      return <blockquote>{drawBlocks(block.children, context)}</blockquote>;
    case "code":
      return (
        <pre className="codeblock">
          <code>{block.text}</code>
        </pre>
      );
    case "table":
      // A wide table scrolls on its own rather than widening the column.
      return (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                {block.header.map((cell, column) => (
                  <Fragment key={column}>
                    {drawCell("th", cell, block.align[column], context)}
                  </Fragment>
                ))}
              </tr>
            </thead>
            {block.rows.length > 0 && (
              <tbody>
                {block.rows.map((row, index) => (
                  <tr key={index}>
                    {row.map((cell, column) => (
                      <Fragment key={column}>
                        {drawCell("td", cell, block.align[column], context)}
                      </Fragment>
                    ))}
                  </tr>
                ))}
              </tbody>
            )}
          </table>
        </div>
      );
    case "rule":
      return <hr />;
    default:
      return block satisfies never;
  }
}

/**
 * Draws blocks in order, with no wrapper element.
 *
 * `lead` and `tail` go inside the first and last paragraph, so a checkbox
 * stays on the item's first line and a back link on the footnote's last. When
 * that block is not a paragraph, they stand beside the blocks instead.
 */
function drawBlocks(
  blocks: ReadonlyArray<MarkdownBlock>,
  context: DrawContext,
  { tight = false, lead = null, tail = null }: BlockExtras = {},
): ReactNode {
  const lastIndex = blocks.length - 1;
  return (
    <>
      {blocks[0]?.type !== "paragraph" && lead}
      {blocks.map((block, index) => (
        <Fragment key={index}>
          {drawBlock(block, context, {
            tight,
            lead: index === 0 ? lead : null,
            tail: index === lastIndex ? tail : null,
          })}
        </Fragment>
      ))}
      {blocks[lastIndex]?.type !== "paragraph" && tail}
    </>
  );
}

/**
 * An error boundary that shows the raw text when the markdown fails to render.
 *
 * Deeply nested markdown, such as a few thousand `>` in a row, overflows the
 * stack inside the parser, and the error is thrown while React renders.
 * Without this boundary, the router's failure screen would replace the whole
 * screen. The message is kept, so the screen would fail again on every
 * visit. Showing the raw text keeps the message readable and the rest of the
 * screen intact.
 */
class PlainTextOnError extends Component<
  { readonly text: string; readonly children: ReactNode },
  { readonly failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { readonly failed: boolean } {
    return { failed: true };
  }

  // A new text gets a new try: a message that failed while half written can
  // parse once more of it has arrived.
  override componentDidUpdate(previous: { readonly text: string }): void {
    if (previous.text !== this.props.text && this.state.failed) {
      this.setState({ failed: false });
    }
  }

  override render(): ReactNode {
    return this.state.failed ? (
      <p className="markdown-failed">{this.props.text}</p>
    ) : (
      this.props.children
    );
  }
}

/**
 * Parses `text` and draws the tree: the blocks, then the footnotes they
 * reference.
 *
 * This is a component of its own so the error boundary above it catches a
 * parser that throws on deeply nested text, and React overflowing its stack
 * while drawing a very deep tree.
 */
function MarkdownTree({
  text,
  breaks,
  inlineImages,
}: {
  readonly text: string;
  readonly breaks: boolean;
  readonly inlineImages: boolean;
}): JSX.Element {
  // React's ids hold characters that are not valid in a link's `#fragment`.
  const idPrefix = `${useId().replace(/[^A-Za-z0-9_-]/g, "")}-`;
  const context = { idPrefix, inlineImages };
  const { blocks, footnotes } = parseMarkdown(text, { breaks });
  return (
    <>
      {drawBlocks(blocks, context)}
      {footnotes.length > 0 && (
        <section aria-label="Footnotes">
          <ol>
            {footnotes.map(({ number, children }) => (
              <li key={number} id={`${idPrefix}fn-${number}`}>
                {drawBlocks(children, context, {
                  tail: (
                    <>
                      {" "}
                      <a
                        href={`#${idPrefix}fnref-${number}`}
                        aria-label={`Back to reference ${number}`}
                      >
                        ↩
                      </a>
                    </>
                  ),
                })}
              </li>
            ))}
          </ol>
        </section>
      )}
    </>
  );
}

/**
 * Renders `text` as markdown, returning its blocks with no wrapper element.
 *
 * The caller's element is the blocks' direct parent, so the paragraph the
 * agent is writing can sit beside them as a sibling, and the container's
 * rules (`.msg-body p`) reach them.
 *
 * Parsing is the expensive part of drawing a message, so the component is
 * `memo`: a block that draws again with the same text does not parse again.
 */
export const Markdown = memo(function Markdown({
  text,
  breaks = false,
  inlineImages = false,
}: {
  readonly text: string;
  /**
   * Renders a single newline as a line break. A newline in the user's message
   * is deliberate, and CommonMark would join the two lines with a space. An
   * agent's text keeps CommonMark's rule, because that is what the agent
   * meant.
   */
  readonly breaks?: boolean;
  /** Shows https images inline rather than as links, as an open signal's blocks do. */
  readonly inlineImages?: boolean;
}): JSX.Element {
  return (
    <PlainTextOnError text={text}>
      <MarkdownTree text={text} breaks={breaks} inlineImages={inlineImages} />
    </PlainTextOnError>
  );
});
