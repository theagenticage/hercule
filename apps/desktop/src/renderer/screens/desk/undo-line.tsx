import type { JSX } from "react";
import "./undo-line.css";

/**
 * Renders the undo line at the foot of the page: `text` says what just
 * happened or why a move failed, and when `onUndo` is given, an Undo button
 * puts it back, with the key that does the same beside it.
 *
 * `isShown` fades the line in and out. While it is out, the line holds the
 * text it last showed, so the caller keeps passing that text until the line
 * is gone, and it takes neither the pointer nor the focus. How long it stays
 * is the caller's.
 */
export function UndoLine({
  text,
  onUndo,
  isShown,
}: {
  readonly text: string;
  readonly onUndo: (() => void) | null;
  readonly isShown: boolean;
}): JSX.Element {
  return (
    <div className={isShown ? "undo-line is-on" : "undo-line"} role="status" inert={!isShown}>
      <span>{text}</span>
      {onUndo !== null && (
        <button type="button" className="undo-line-button" onClick={onUndo}>
          Undo <kbd>⌘Z</kbd>
        </button>
      )}
    </div>
  );
}
