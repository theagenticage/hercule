/**
 * The thread's prose, rendered as markdown.
 *
 * `react-markdown` builds React elements rather than an HTML string, so a
 * `<script>` from an agent is shown as plain text. This safety needs no
 * configuration; it comes from how the renderer works. A plugin that parses
 * raw HTML would remove it, so none is used.
 *
 * The elements get design-language classes directly instead of a prose
 * plugin: agents emit only a small set of elements, and every class below is
 * already used elsewhere in the app.
 */
import { Component, createElement, memo, type JSX, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

/** The props every component below accepts: a loose subset of the renderer's props. */
type Dressable = { readonly node?: unknown; readonly className?: string | undefined };

/** The gap between two blocks, with no gap above the first block in its container. */
const STACKED = "mt-3 first:mt-0";

/** A heading has more space above it than below, which groups it with the text that follows. */
const HEADING = "mt-5 first:mt-0";

/**
 * Returns a component that renders `tag` with the given classes.
 *
 * Beyond setting the classes, the component does two things:
 *
 * - It drops the hast `node` prop that `react-markdown` passes to every
 *   component, because it is not a DOM attribute.
 * - It appends its classes to any class the renderer already set, rather than
 *   replacing it. Some of those matter, such as `sr-only` on the footnote
 *   label.
 */
const createStyledComponent =
  (tag: string, className: string) =>
  (props: Dressable): JSX.Element =>
    createElement(tag, {
      ...props,
      node: undefined,
      className: props.className === undefined ? className : `${props.className} ${className}`,
    });

/**
 * The classes for a fenced code block, the only card in the prose. It uses the
 * same tokens as the user's message bubble. The `<code>` inside it has its
 * inline-code styling removed, because the `code` rule styles every `<code>`
 * and a fenced one is already in a card.
 */
const FENCE =
  `${STACKED} overflow-x-auto rounded-card border border-line-soft bg-surface px-3 py-2.5 ` +
  "font-mono text-fine leading-relaxed [&_code]:rounded-none [&_code]:bg-transparent " +
  "[&_code]:px-0 [&_code]:py-0 [&_code]:text-[length:inherit]";

const CELL = "border border-line-soft px-2 py-1 align-top";

/**
 * Renders a table cell, with its column's alignment as a class.
 *
 * `remark-gfm` puts the alignment of `|:---|---:|` in an inline `style`. This
 * function converts the alignment to a class and drops the style, so markdown
 * written by an agent never reaches a style attribute. The controller's
 * Content-Security-Policy allows inline styles only because the workflow
 * editor needs them. The app's own markup uses classes only, so a stricter
 * policy would break nothing.
 */
const renderTableCell = (
  tag: "th" | "td",
  className: string,
  props: Dressable & { readonly style?: { readonly textAlign?: string | undefined } | undefined },
): JSX.Element => {
  const { style, ...rest } = props;
  const alignment =
    style?.textAlign === "center"
      ? "text-center"
      : style?.textAlign === "right"
        ? "text-right"
        : "text-left";
  return createElement(tag, { ...rest, node: undefined, className: `${className} ${alignment}` });
};

const components: Components = {
  // The heading sizes stay small, with the largest one step above the body
  // text: an answer is prose with sections, not a document, and the thread's
  // title is just above in the chrome. Headings stand out through the space
  // above them and their weight, not their size.
  h1: createStyledComponent("h1", `${HEADING} text-lead font-emph text-ink`),
  h2: createStyledComponent("h2", `${HEADING} text-body font-emph text-ink`),
  h3: createStyledComponent("h3", `${HEADING} font-emph text-ink`),
  h4: createStyledComponent("h4", `${HEADING} font-emph text-ink`),
  h5: createStyledComponent("h5", `${HEADING} font-emph text-ink`),
  h6: createStyledComponent("h6", `${HEADING} font-emph text-ink`),
  p: createStyledComponent("p", `${STACKED} leading-relaxed`),
  // Weight 500, not the browser's 700: heavier bold looks cramped in this font.
  strong: createStyledComponent("strong", "font-emph"),
  // The agent writes the link text, and the target may not match it, so a
  // click opens a new tab and sends no referrer. A link within the page, such
  // as a footnote number and its back link, stays in this tab: opening it in
  // a new tab would open a second copy of the app.
  a: (props) =>
    createElement("a", {
      ...props,
      node: undefined,
      ...(props.href?.startsWith("#") === true ? {} : { target: "_blank", rel: "noreferrer" }),
      className: "underline decoration-line underline-offset-[3px]",
    }),
  ul: createStyledComponent("ul", `${STACKED} list-disc space-y-1 pl-5 marker:text-faint`),
  ol: createStyledComponent("ol", `${STACKED} list-decimal space-y-1 pl-5 marker:text-faint`),
  // A nested list belongs to its list item, so it sits closer to the item
  // than two blocks of prose sit to each other.
  li: createStyledComponent("li", "leading-relaxed [&>ul]:mt-1 [&>ol]:mt-1"),
  // A translucent tint rather than an opaque chip, because inline code
  // appears both on the page and inside the user's bubble. A translucent
  // colour shows on both backgrounds; an opaque one would vanish on one of them.
  code: createStyledComponent(
    "code",
    "rounded-control bg-line-soft px-1 py-px font-mono text-[0.92em]",
  ),
  pre: createStyledComponent("pre", FENCE),
  blockquote: createStyledComponent(
    "blockquote",
    `${STACKED} border-l-2 border-line-soft pl-3 text-muted`,
  ),
  hr: createStyledComponent("hr", `${STACKED} border-line`),
  // A wide table scrolls on its own rather than widening the column.
  table: (props) => (
    <div className={`${STACKED} overflow-x-auto`}>
      {createElement("table", { ...props, node: undefined, className: "w-full border-collapse" })}
    </div>
  ),
  th: (props) => renderTableCell("th", `${CELL} font-emph`, props),
  td: (props) => renderTableCell("td", CELL, props),
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
 * The thread's prose, rendered as markdown.
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
      <ReactMarkdown
        remarkPlugins={breaks ? [remarkGfm, remarkBreaks] : [remarkGfm]}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </Legible>
  );
});
