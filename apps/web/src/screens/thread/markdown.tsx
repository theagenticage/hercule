/**
 * The thread's prose, rendered as markdown.
 *
 * `react-markdown` builds React elements rather than an HTML string, so an
 * agent that emits `<script>` gets visible characters back, and nothing has to
 * be configured for that to hold: the safety is in the renderer's shape. A
 * plugin that parsed raw HTML would take it away, so there is none.
 *
 * The blocks carry design-language classes directly instead of a prose plugin:
 * the set of elements an agent actually emits is small, and every class below
 * is one the rest of the app already uses.
 */
import { Component, createElement, memo, type JSX, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

/** What every rule below accepts: the renderer's own props, loosely. */
type Dressable = { readonly node?: unknown; readonly className?: string | undefined };

/** The gap between two blocks, and none above the first one in its container. */
const STACKED = "mt-3 first:mt-0";

/** A heading takes more air above it than below: that gap is what groups it. */
const HEADING = "mt-5 first:mt-0";

/**
 * One element of the prose, dressed.
 *
 * Two things this does beyond setting a class. It drops the hast node
 * `react-markdown` hands every component, which is not a DOM attribute. And it
 * appends to whatever class the renderer already put there rather than
 * replacing it: `sr-only` on the footnote label, for one, is load-bearing.
 */
const styled =
  (tag: string, className: string) =>
  (props: Dressable): JSX.Element =>
    createElement(tag, {
      ...props,
      node: undefined,
      className: props.className === undefined ? className : `${props.className} ${className}`,
    });

/**
 * A fenced block is the one card in the prose, built from the same tokens as
 * the user's bubble. The `<code>` inside it is stripped back, because the
 * inline rule dresses every `<code>` and a fenced one is already in a card.
 */
const FENCE =
  `${STACKED} overflow-x-auto rounded-card border border-line-soft bg-surface px-3 py-2.5 ` +
  "font-mono text-fine leading-relaxed [&_code]:rounded-none [&_code]:bg-transparent " +
  "[&_code]:px-0 [&_code]:py-0 [&_code]:text-[length:inherit]";

const CELL = "border border-line-soft px-2 py-1 text-left align-top";

const Table = styled("table", "w-full border-collapse");

const components: Components = {
  // The heading scale is shallow and stops one step above the body: an answer
  // is prose with sections, not a document, and the thread's own title sits a
  // few pixels away in the chrome. What separates a heading is the air above
  // it and the weight, not the size.
  h1: styled("h1", `${HEADING} text-lead font-emph text-ink`),
  h2: styled("h2", `${HEADING} text-body font-emph text-ink`),
  h3: styled("h3", `${HEADING} font-emph text-ink`),
  h4: styled("h4", `${HEADING} font-emph text-ink`),
  h5: styled("h5", `${HEADING} font-emph text-ink`),
  h6: styled("h6", `${HEADING} font-emph text-ink`),
  p: styled("p", `${STACKED} leading-relaxed`),
  // 500, not the browser's 700: heavier bolds squint in this face.
  strong: styled("strong", "font-emph"),
  // The link text is written by the agent and the target need not match it, so
  // a click leaves this tab where it is and carries no referrer out.
  a: (props) =>
    createElement("a", {
      ...props,
      node: undefined,
      target: "_blank",
      rel: "noreferrer",
      className: "underline decoration-line underline-offset-[3px]",
    }),
  ul: styled("ul", `${STACKED} list-disc space-y-1 pl-5 marker:text-faint`),
  ol: styled("ol", `${STACKED} list-decimal space-y-1 pl-5 marker:text-faint`),
  li: styled("li", "leading-relaxed"),
  // A tint rather than a filled chip, because the same rule has to read on the
  // page behind the prose and on the surface of the user's bubble; an alpha
  // over either one shows, a second opaque colour over one of them does not.
  code: styled("code", "rounded-control bg-line-soft px-1 py-px font-mono text-[0.92em]"),
  pre: styled("pre", FENCE),
  blockquote: styled("blockquote", `${STACKED} border-l-2 border-line-soft pl-3 text-muted`),
  hr: styled("hr", `${STACKED} border-line`),
  // A wide table scrolls on its own rather than widening the column.
  table: (props) => (
    <div className={`${STACKED} overflow-x-auto`}>
      <Table {...props} />
    </div>
  ),
  th: styled("th", `${CELL} font-emph`),
  td: styled("td", CELL),
};

/** One array each, rather than a fresh one per render. */
const PROSE = [remarkGfm];
const PROSE_WITH_BREAKS = [remarkGfm, remarkBreaks];

/**
 * Deeply nested markdown - a few thousand `>` in a row will do it - overflows
 * the stack inside the parser, and that throw happens while React is
 * rendering. Without this the whole thread screen is replaced by the router's
 * failure panel, and because the message sits in the transcript it is replaced
 * again on every reload: one answer would make a thread permanently
 * unreadable. Falling back to the characters the agent sent keeps the answer
 * legible and the rest of the thread intact.
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
      <p className="whitespace-pre-wrap">{this.props.text}</p>
    ) : (
      this.props.children
    );
  }
}

/**
 * Memoized because the thread rebuilds every turn from the transcript whenever
 * a row lands; without it, every answer in a long thread would be parsed again
 * on every streamed row.
 */
export const Markdown = memo(function Markdown({
  text,
  breaks = false,
}: {
  readonly text: string;
  /**
   * Render a single newline as a line break. The composer's textarea makes
   * ⇧⏎ the only way to type one, so a newline in what the user wrote is
   * deliberate and CommonMark would swallow it as a soft break. An agent's
   * prose keeps the soft break, which is what it wrote the newline to mean.
   */
  readonly breaks?: boolean;
}): JSX.Element {
  // The blocks are returned bare, so the caller's box is their only parent:
  // the thread's live tail has to sit beside them as a sibling, and a wrapper
  // here would push it out of the prose it is finishing.
  return (
    <Legible text={text}>
      <ReactMarkdown remarkPlugins={breaks ? PROSE_WITH_BREAKS : PROSE} components={components}>
        {text}
      </ReactMarkdown>
    </Legible>
  );
});
