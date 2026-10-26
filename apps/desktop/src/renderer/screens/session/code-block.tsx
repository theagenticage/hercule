import { useState, type JSX } from "react";
import { CheckIcon } from "../../icons/check";
import { CopyIcon } from "../../icons/copy";
import { WrapIcon } from "../../icons/wrap";
import { useCopyResult } from "../use-copy-result";
import "./code-block.css";

/**
 * Renders a fenced code block of a message: a slim row on top, then the code.
 *
 * - The row holds the block's `language` on the left, as the parser returns
 *   it, when the block has one. On the right it holds a button that turns line wrapping
 *   on and off, and a button that copies the code.
 * - Lines wrap by default. The wrap button changes that for this block only:
 *   the choice is local state, so it is forgotten with the block.
 * - A copy puts `text` on the clipboard exactly as the fence holds it. For a
 *   moment the copy button shows a check mark and reads "Copied", or reads
 *   "Copy failed" in the failure colour when the browser refused. A visually hidden status line
 *   says the same to a screen reader.
 *
 * The caller must key the block by its place among its siblings, never by its
 * text, so a streaming message that finishes a fence does not reset the wrap
 * state of the blocks above it.
 */
export function CodeBlock({
  text,
  language,
}: {
  readonly text: string;
  readonly language: string | undefined;
}): JSX.Element {
  const [wrapped, setWrapped] = useState(true);
  const { result, copy } = useCopyResult();
  const copyLabel =
    result === "copied" ? "Copied" : result === "failed" ? "Copy failed" : "Copy code";
  return (
    <div className="code-block">
      <div className="code-block-header">
        {language === undefined ? null : <span className="code-block-language">{language}</span>}
        <button
          type="button"
          className={wrapped ? "icon-btn icon-btn--sm is-on" : "icon-btn icon-btn--sm"}
          aria-label="Wrap lines"
          title="Wrap lines"
          aria-pressed={wrapped}
          onClick={() => {
            setWrapped(!wrapped);
          }}
        >
          <WrapIcon size={14} />
        </button>
        <button
          type="button"
          className="icon-btn icon-btn--sm"
          aria-label={copyLabel}
          title={copyLabel}
          data-result={result}
          onClick={() => {
            copy(text);
          }}
        >
          {result === "copied" ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
        </button>
        <span className="code-block-status" role="status">
          {result === undefined ? "" : copyLabel}
        </span>
      </div>
      <pre className="code-block-text" data-wrapped={wrapped ? "" : undefined}>
        <code>{text}</code>
      </pre>
    </div>
  );
}
