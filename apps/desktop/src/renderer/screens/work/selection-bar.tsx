import { useState, type JSX } from "react";
import {
  describeSelectedCount,
  SELECTED_LABEL,
  SELECTION_DRAG_HINT,
} from "@hercule/client-core/work";
import "./selection-bar.css";

/**
 * Renders the quiet bar over the board that offers what the user can do with
 * the selected cards: Done, Drop and Clear. It is always in the page, and
 * fades in while `count` is above zero. When it fades out it keeps the count
 * it last showed, and it takes neither the pointer nor the focus.
 *
 * With more than one card selected the bar also says that dragging any of
 * them moves them all.
 */
export function SelectionBar({
  count,
  onDone,
  onDrop,
  onClear,
}: {
  readonly count: number;
  readonly onDone: () => void;
  readonly onDrop: () => void;
  readonly onClear: () => void;
}): JSX.Element {
  const [shownCount, setShownCount] = useState(count);
  if (count > 0 && count !== shownCount) setShownCount(count);
  const isShown = count > 0;
  return (
    <div
      className={isShown ? "select-bar is-on" : "select-bar"}
      role="toolbar"
      aria-label={describeSelectedCount(shownCount)}
      inert={!isShown}
    >
      <span className="select-bar-count">
        <b>{shownCount}</b> {SELECTED_LABEL}
      </span>
      {shownCount > 1 && <span className="select-bar-hint">{SELECTION_DRAG_HINT}</span>}
      <button type="button" className="select-bar-button" onClick={onDone}>
        Done
      </button>
      <button type="button" className="select-bar-button" onClick={onDrop}>
        Drop
      </button>
      <button type="button" className="select-bar-button" onClick={onClear}>
        Clear <kbd>Esc</kbd>
      </button>
    </div>
  );
}
