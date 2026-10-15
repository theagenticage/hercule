/**
 * Renders a Discussion's subject or a system Post's text: plain text whose
 * backtick spans, such as a file's path, are drawn as inline code. The
 * controller writes both as plain text with code spans, not as Markdown, so
 * they are split here (`splitInlineCode`) and never parsed.
 */
import type { JSX } from "react";
import { splitInlineCode } from "@hercule/client-core/discussion-text";

/** Renders `text` with each of its code spans in a `code` element. */
export function InlineCode({ text }: { readonly text: string }): JSX.Element {
  return (
    <>
      {splitInlineCode(text).map((segment, index) =>
        segment.isCode ? <code key={index}>{segment.text}</code> : segment.text,
      )}
    </>
  );
}
