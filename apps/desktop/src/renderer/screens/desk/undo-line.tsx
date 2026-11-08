import type { JSX } from "react";
import "./undo-line.css";

/**
 * Renders the undo line at the foot of the page: `text` says what just
 * happened or why a move failed, and when `onUndo` is given, an Undo button
 * puts it back, with `undoKey` beside it, the words for the key that does the
 * same, such as "⌘Z". An `action` adds a second button beside it, such as
 * "See its Task".
 *
 * `isShown` fades the line in and out. While it is out, the line holds the
 * text it last showed, so the caller keeps passing that text until the line
 * is gone, and it takes neither the pointer nor the focus. How long it stays
 * is the caller's.
 */
export function UndoLine({
  text,
  onUndo,
  action,
  undoKey,
  isShown,
}: {
  readonly text: string;
  readonly onUndo: (() => void) | null;
  readonly action: { readonly label: string; readonly act: () => void } | null;
  readonly undoKey: string;
  readonly isShown: boolean;
}): JSX.Element {
  return (
    <div className={isShown ? "undo-line is-on" : "undo-line"} role="status" inert={!isShown}>
      <span>{text}</span>
      {onUndo !== null && (
        <button type="button" className="undo-line-button" onClick={onUndo}>
          Undo <kbd>{undoKey}</kbd>
        </button>
      )}
      {action !== null && (
        <button type="button" className="undo-line-button" onClick={action.act}>
          {action.label}
        </button>
      )}
    </div>
  );
}
