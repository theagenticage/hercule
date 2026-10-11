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
 * The elements carry no classes, with three exceptions, all styled in
 * `messages.css`: `codeblock` on a fence, `table-scroll` on the box around a
 * table, and `markdown-failed` on the raw text shown when the markdown cannot
 * be drawn. The rest of that file styles the elements through their
 * container, `.msg-body` or `.bubble`, as the Bureau book does.
 */
import { Component, Fragment, memo, useId, type JSX, type ReactNode } from "react";
import {
  parseMarkdown,
  type ColumnAlignment,
  type MarkdownBlock,
  type MarkdownInline,
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

/** Renders an image as a link to it, or its alt text alone when it has no address. */
function ImageLink({
  src,
  alt,
  title,
}: {
  readonly src: string;
  readonly alt: string;
  readonly title: string | undefined;
}): JSX.Element {
  return src !== "" ? (
    <a href={src} title={title} target="_blank" rel="noreferrer">
      {alt === "" ? src : alt}
    </a>
  ) : (
    <>{alt}</>
  );
}

/**
 * Draws one run of text inside a block. `key` goes on the element itself, and
 * text is a bare string, so a long message does not build a Fragment for
 * every inline.
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
 * - A task item's checkbox and a footnote's back link each come with the
 *   space that separates them from the text beside them, so each is a
 *   Fragment: there is no single element to key.
 */
function drawInline(
  inline: MarkdownInline,
  context: DrawContext,
  key: number,
): string | JSX.Element {
  switch (inline.type) {
    case "text":
      return inline.text;
    case "strong":
      return <strong key={key}>{drawInlines(inline.children, context)}</strong>;
    case "emphasis":
      return <em key={key}>{drawInlines(inline.children, context)}</em>;
    case "strikethrough":
      return <del key={key}>{drawInlines(inline.children, context)}</del>;
    case "inlineCode":
      return <code key={key}>{inline.text}</code>;
    case "break":
      return <br key={key} />;
    case "link":
      return (
        <a
          key={key}
          href={inline.href}
          title={inline.title}
          {...(inline.href.startsWith("#") ? {} : { target: "_blank", rel: "noreferrer" })}
        >
          {drawInlines(inline.children, context)}
        </a>
      );
    case "image":
      return context.inlineImages && inline.src.startsWith("https://") ? (
        <img
          key={key}
          src={inline.src}
          alt={inline.alt}
          title={inline.title}
          referrerPolicy="no-referrer"
        />
      ) : (
        <ImageLink key={key} src={inline.src} alt={inline.alt} title={inline.title} />
      );
    case "checkbox":
      return (
        <Fragment key={key}>
          <input type="checkbox" checked={inline.checked} disabled />{" "}
        </Fragment>
      );
    case "footnoteReference":
      return (
        <sup key={key}>
          <a
            href={`#${context.idPrefix}fn-${inline.number}`}
            id={inline.isFirstReference ? `${context.idPrefix}fnref-${inline.number}` : undefined}
          >
            {inline.number}
          </a>
        </sup>
      );
    case "footnoteBackReference":
      return (
        <Fragment key={key}>
          {" "}
          <a
            href={`#${context.idPrefix}fnref-${inline.number}`}
            aria-label={`Back to reference ${inline.number}`}
          >
            ↩
          </a>
        </Fragment>
      );
  }
}

/** Draws a run of text, in order. */
function drawInlines(
  inlines: ReadonlyArray<MarkdownInline>,
  context: DrawContext,
): Array<string | JSX.Element> {
  return inlines.map((inline, index) => drawInline(inline, context, index));
}

/** Draws a table cell with the alignment its column sets, if any. */
function drawCell(
  Tag: "th" | "td",
  cell: ReadonlyArray<MarkdownInline>,
  align: ColumnAlignment,
  column: number,
  context: DrawContext,
): JSX.Element {
  // The alignment is an attribute that `messages.css` reads, never a `style`:
  // an agent's markdown must not reach a style attribute.
  return (
    <Tag key={column} data-align={align}>
      {drawInlines(cell, context)}
    </Tag>
  );
}

/**
 * Draws one block. `tight` draws a paragraph as bare text with no `<p>`, as a
 * tight list does for its items. It reaches the paragraphs of this block
 * only, not those of a block inside it.
 *
 * A fence is the book's `.codeblock`, with no syntax colours: the book's
 * colours are sample highlighting, and no highlighter is loaded.
 */
function drawBlock(
  block: MarkdownBlock,
  context: DrawContext,
  tight: boolean,
  key: number,
): JSX.Element {
  switch (block.type) {
    case "paragraph":
      // A bare paragraph has no element to carry the key.
      return tight ? (
        <Fragment key={key}>{drawInlines(block.children, context)}</Fragment>
      ) : (
        <p key={key}>{drawInlines(block.children, context)}</p>
      );
    case "heading": {
      const Tag = `h${block.depth}` as const;
      return <Tag key={key}>{drawInlines(block.children, context)}</Tag>;
    }
    case "list": {
      const items = block.items.map((item, index) => (
        <li key={index}>{drawBlocks(item.children, context, !block.loose)}</li>
      ));
      return block.start === undefined ? (
        <ul key={key}>{items}</ul>
      ) : (
        <ol key={key} start={block.start === 1 ? undefined : block.start}>
          {items}
        </ol>
      );
    }
    case "blockquote":
      return <blockquote key={key}>{drawBlocks(block.children, context, false)}</blockquote>;
    case "code":
      return (
        <pre key={key} className="codeblock">
          <code>{block.text}</code>
        </pre>
      );
    case "table":
      // A wide table scrolls on its own rather than widening the column.
      return (
        <div key={key} className="table-scroll">
          <table>
            <thead>
              <tr>
                {block.header.map((cell, column) =>
                  drawCell("th", cell, block.align[column], column, context),
                )}
              </tr>
            </thead>
            {block.rows.length > 0 && (
              <tbody>
                {block.rows.map((row, index) => (
                  <tr key={index}>
                    {row.map((cell, column) =>
                      drawCell("td", cell, block.align[column], column, context),
                    )}
                  </tr>
                ))}
              </tbody>
            )}
          </table>
        </div>
      );
    case "rule":
      return <hr key={key} />;
  }
}

/**
 * Draws blocks in order, with no wrapper element. `tight` is passed to each
 * block, see `drawBlock`.
 */
function drawBlocks(
  blocks: ReadonlyArray<MarkdownBlock>,
  context: DrawContext,
  tight: boolean,
): JSX.Element[] {
  return blocks.map((block, index) => drawBlock(block, context, tight, index));
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
      {drawBlocks(blocks, context, false)}
      {footnotes.length > 0 && (
        <section aria-label="Footnotes">
          <ol>
            {footnotes.map(({ number, children }) => (
              <li key={number} id={`${idPrefix}fn-${number}`}>
                {drawBlocks(children, context, false)}
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
