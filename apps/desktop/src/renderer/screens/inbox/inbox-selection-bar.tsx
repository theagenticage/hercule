import { useState, type JSX } from "react";
import { CloseIcon } from "../../icons/close";
import "./inbox-selection-bar.css";

/**
 * Renders the small bar at the foot of the list while things are selected: how
 * many (`count`) and a button that calls `onClear`. It only counts and clears;
 * the moves of a selection are in the pane's footer.
 *
 * The bar is always mounted so it can leave: with `count` 0 it sinks away over
 * 140ms and keeps the last count while it does, and it takes neither the
 * pointer nor the focus. Its parent is the positioned box it centres in,
 * the list, and carries the Inbox frame's `ib` class, which places the undo
 * line over the bar while it is shown.
 */
export function InboxSelectionBar({
  count,
  onClear,
}: {
  readonly count: number;
  readonly onClear: () => void;
}): JSX.Element {
  const [lastCount, setLastCount] = useState(count);
  if (count > 0 && count !== lastCount) setLastCount(count);
  const isShown = count > 0;
  return (
    <div
      className="ib-selbar"
      role="group"
      aria-label="Selection"
      data-shown={isShown ? "" : undefined}
      inert={!isShown}
    >
      <span className="ib-selbar-n">
        <b>{isShown ? count : lastCount}</b> selected
      </span>
      <i className="ib-selbar-line" />
      <button
        type="button"
        className="icon-btn ib-selbar-clear"
        title="Clear the selection (Esc)"
        aria-label="Clear the selection"
        aria-keyshortcuts="Escape"
        onClick={onClear}
      >
        <CloseIcon size={14} />
      </button>
    </div>
  );
}
