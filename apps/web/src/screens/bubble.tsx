import type { JSX } from "react";
import { Markdown } from "./thread/markdown";

/**
 * Renders what the user wrote, in a bubble: a thread turn's message, or the
 * owner's message in an assistant's conversation. The caller places the
 * bubble on the right.
 *
 * The bubble is a passive container, so it sits on `--surface` with a
 * `--line` hairline, as design-language.md asks; the lit `--raised` layer is
 * kept for what needs attention. A newline the user typed (Shift+Enter) is
 * deliberate, so the text keeps its line breaks.
 */
export function OwnerBubble({ text }: { readonly text: string }): JSX.Element {
  return (
    <div className="max-w-[80%] rounded-card border border-line bg-surface px-3.5 py-2 text-row text-ink">
      <Markdown text={text} breaks />
    </div>
  );
}
