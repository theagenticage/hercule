/**
 * The context block under a message the user sent: the text that told the
 * agent about things (External Entities) at the start of its prompt. The
 * bubble holds the user's words; the block is kept out of the way, folded.
 */
import type { JSX, ReactNode } from "react";
import type { PromptContextBlock } from "@hercule/contract";

// The same disclosure chevron as a details block in markdown: two borders, so
// Safari's own marker never shows.
const SUMMARY =
  "cursor-pointer list-none rounded-control text-meta text-faint [&::-webkit-details-marker]:hidden " +
  "before:mr-2 before:inline-block before:size-[5px] before:-rotate-45 before:border-r-[1.5px] " +
  "before:border-b-[1.5px] before:border-faint before:align-[0.12em] " +
  "[[open]>&]:before:-translate-y-px [[open]>&]:before:rotate-45 " +
  "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live";

/**
 * Draws the block as it was sent, folded until the reader opens it. The
 * summary reads "Context sent with it" and the block's line count, such as
 * "6 lines". The block is plain text in a monospace box, with its line breaks
 * kept and long lines wrapped.
 */
export function MessageContext({ context }: { readonly context: PromptContextBlock }): JSX.Element {
  return (
    <details className="max-w-[80%]">
      <summary className={SUMMARY}>
        Context sent with it · {String(context.lineCount)}{" "}
        {context.lineCount === 1 ? "line" : "lines"}
      </summary>
      <pre className="mt-1 rounded-card border border-line-soft bg-surface px-3 py-2 font-mono text-fine leading-5 wrap-break-word whitespace-pre-wrap text-ink">
        {context.text}
      </pre>
    </details>
  );
}

/**
 * Draws a message's bubble and, when the message carries a context block, the
 * folded block under it, on the right like the bubble. Returns the bubble
 * alone when there is no block, so a message without context keeps its layout.
 */
export function WithMessageContext({
  context,
  children,
}: {
  readonly context: PromptContextBlock | undefined;
  /** The message's bubble. */
  readonly children: ReactNode;
}): JSX.Element {
  if (context === undefined) return <>{children}</>;
  return (
    <div className="flex w-full flex-col items-end gap-1">
      {children}
      <MessageContext context={context} />
    </div>
  );
}
