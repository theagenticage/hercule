/**
 * Renders plain text whose backtick spans, such as a file's path, are drawn
 * as inline code: a Discussion's subject, a system Post's text, or why a
 * skill was refused. The controller writes these as plain text with code
 * spans, not as Markdown, so they are split here (`splitInlineCode`) and
 * never parsed.
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
