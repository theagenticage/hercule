/**
 * Prose in a session's messages, rendered as markdown: an agent's message and
 * the user's bubble, in the thread's transcript and in an assistant's
 * Conversation. Intake's open signal draws its text the same way.
 *
 * `react-markdown` builds React elements rather than an HTML string, so a
 * `<script>` from an agent shows as plain text. No plugin that parses raw
 * HTML is used, because one would remove that safety.
 *
 * The elements carry no classes. `messages.css` styles them through their
 * container, `.msg-body` or `.bubble`, as the Bureau book does, so only the
 * elements that need more than a style are replaced below.
 */
import { Component, memo, type JSX, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

/**
 * Returns the props `react-markdown` passed a component, without `node`.
 *
 * `node` is the element's syntax tree. It is no HTML attribute, and React
 * would write it into the page as `node="[object Object]"`.
 */
const dropSyntaxNode = <P extends { readonly node?: unknown }>(props: P): Omit<P, "node"> => ({
  ...props,
  node: undefined,
});

const components: Components = {
  // A fence is the book's `.codeblock`, with no syntax colours: the book's
  // colours are sample highlighting, and no highlighter is loaded.
  pre: (props) => <pre {...dropSyntaxNode(props)} className="codeblock" />,
  // The agent writes both the link text and its target, so a click opens the
  // target in the default browser, where the address is visible, and sends
  // no referrer. Main's window-open handler takes the link there. A link
  // within the message, such as a footnote and its back link, stays in the
  // window.
  a: (props) => (
    <a
      {...dropSyntaxNode(props)}
      {...(props.href?.startsWith("#") === true ? {} : { target: "_blank", rel: "noreferrer" })}
    />
  ),
  // Loading an image tells its host that the user is reading the text, so
  // only an open signal's blocks show images inline (see
  // `INLINE_IMAGE_COMPONENTS`). Anywhere else an image shows as a link to
  // it, named by its alt text, or by its address when it has none.
  img: ({ src, alt }) => <ImageLink src={src} alt={alt} />,
  // A wide table scrolls on its own rather than widening the column.
  table: (props) => (
    <div className="table-scroll">
      <table {...dropSyntaxNode(props)} />
    </div>
  ),
};

/** Renders an image as a link to it, or its alt text alone when it has no address. */
function ImageLink({
  src,
  alt,
}: {
  readonly src: string | undefined;
  readonly alt: string | undefined;
}): JSX.Element {
  return typeof src === "string" && src !== "" ? (
    <a href={src} target="_blank" rel="noreferrer">
      {alt === undefined || alt === "" ? src : alt}
    </a>
  ) : (
    <>{alt}</>
  );
}

/**
 * The components for text that shows its https images inline. The window's
 * content security policy loads images over https only, so an image at any
 * other address stays a link. The image is fetched with no referrer, as a
 * link is opened with none.
 */
const INLINE_IMAGE_COMPONENTS: Components = {
  ...components,
  img: ({ src, alt }) =>
    typeof src === "string" && src.startsWith("https://") ? (
      <img src={src} alt={alt ?? ""} referrerPolicy="no-referrer" />
    ) : (
      <ImageLink src={src} alt={alt} />
    ),
};

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
      <ReactMarkdown
        remarkPlugins={breaks ? [remarkGfm, remarkBreaks] : [remarkGfm]}
        components={inlineImages ? INLINE_IMAGE_COMPONENTS : components}
      >
        {text}
      </ReactMarkdown>
    </PlainTextOnError>
  );
});
