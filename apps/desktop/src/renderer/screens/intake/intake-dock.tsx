/**
 * The dock at the bottom of Intake's list: the toast of the last move, and
 * the bulk bar while rows are checked (spec 17 §Row controls and the bulk
 * bar, §The foot, the toast and failures).
 */
import { useEffect, useEffectEvent, useState, type JSX } from "react";
import { SIGNAL_MOVE_LABELS, type SignalMove } from "@hercule/client-core";
import { CloseIcon } from "../../icons/close";
import { Mark } from "../../marks";
import { SIGNAL_MOVE_GLYPHS } from "./move-glyphs";
import { SNOOZE_ANCHOR } from "./snooze-menu";
import type { MoveToast } from "./use-signal-moves";

/** How long a toast shows before it fades, in milliseconds. */
const TOAST_SHOWN_MS = 5_000;

/** What the bulk bar shows and does, for the rows checked in the view. */
export interface BulkBar {
  readonly checkedCount: number;
  /** The buttons, in drawing order, as `listBulkMoves` returns them. */
  readonly moves: ReadonlyArray<SignalMove>;
  /** What the button with hover or focus would do, such as "Done 3 · keeps 2 proposals". */
  readonly preview: string | null;
  /** The Done button's tooltip when Done leaves some checked rows alone, as `describeBulkDoneTitle` gives it. */
  readonly doneTitle: string | null;
  readonly snoozeMenuOpen: boolean;
  /** Called with the move whose button gains hover or focus, and with `null` when it loses both. */
  readonly onPreview: (move: SignalMove | null) => void;
  readonly onMove: (move: SignalMove) => void;
  readonly onClear: () => void;
}

/**
 * Renders the dock: the toast above the bulk bar. The dock sticks to the
 * bottom of the list while it scrolls. The toast stays while rows are
 * checked, so a move that keeps some rows checked still says what it did.
 */
export function IntakeDock({
  toast,
  bulk,
  onDismissToast,
}: {
  readonly toast: MoveToast | null;
  readonly bulk: BulkBar | null;
  readonly onDismissToast: () => void;
}): JSX.Element | null {
  if (toast === null && bulk === null) return null;
  return (
    <div className="asks-dock">
      {toast !== null && (
        <MoveToastLine key={toast.serial} toast={toast} onDismiss={onDismissToast} />
      )}
      {bulk !== null && <BulkBarLine bulk={bulk} />}
    </div>
  );
}

/**
 * Renders the toast of the last move. It rises when it shows, fades after
 * five seconds and is then dismissed. While the pointer is on it, it stays;
 * when the pointer leaves, the five seconds start again. Under Reduce
 * motion it neither rises nor fades: it goes at once.
 *
 * The toast leads with the done mark. A failed move shows its error here
 * instead, behind the failed mark, as an alert.
 */
function MoveToastLine({
  toast,
  onDismiss,
}: {
  readonly toast: MoveToast;
  readonly onDismiss: () => void;
}): JSX.Element {
  const [held, setHeld] = useState(false);
  const [fading, setFading] = useState(false);
  const dismiss = useEffectEvent(onDismiss);
  useEffect(() => {
    if (held) return;
    const timer = setTimeout(() => {
      // Under Reduce motion no fade runs, so no animation would end to dismiss it.
      if (matchMedia("(prefers-reduced-motion: reduce)").matches) dismiss();
      else setFading(true);
    }, TOAST_SHOWN_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [held]);

  return (
    <div
      className={[
        "asks-toast",
        toast.failed ? "asks-toast--fail" : "",
        fading ? "is-fading" : "is-new",
      ].join(" ")}
      role={toast.failed ? "alert" : "status"}
      onPointerEnter={() => {
        setHeld(true);
        setFading(false);
      }}
      onPointerLeave={() => {
        setHeld(false);
      }}
      onAnimationEnd={(event) => {
        if (event.animationName === "asks-fade") onDismiss();
      }}
    >
      <Mark state={toast.failed ? "failed" : "done"} />
      <span className="asks-toast-text">{toast.text}</span>
    </div>
  );
}

/**
 * Renders the bulk bar: "3 selected", and after it what the button with
 * hover or focus would do, then the buttons and the clear button. The bar
 * anchors the snooze menu while the menu is open from it.
 */
function BulkBarLine({ bulk }: { readonly bulk: BulkBar }): JSX.Element {
  return (
    <div
      className="asks-toast asks-bulk"
      role="toolbar"
      aria-label="Checked rows"
      style={bulk.snoozeMenuOpen ? { anchorName: SNOOZE_ANCHOR } : undefined}
    >
      <span className="asks-toast-text" aria-live="polite">
        <b>{bulk.checkedCount}</b> selected
        {bulk.preview !== null && <span className="asks-bulk-preview">{` · ${bulk.preview}`}</span>}
      </span>
      {bulk.moves.map((move) => {
        const opensMenu = move === "snooze";
        return (
          <button
            key={move}
            type="button"
            title={(move === "done" && bulk.doneTitle) || undefined}
            data-opens-snooze={opensMenu || undefined}
            aria-haspopup={opensMenu ? "menu" : undefined}
            aria-expanded={opensMenu ? bulk.snoozeMenuOpen : undefined}
            onPointerEnter={() => {
              bulk.onPreview(move);
            }}
            onPointerLeave={() => {
              bulk.onPreview(null);
            }}
            onFocus={() => {
              bulk.onPreview(move);
            }}
            onBlur={() => {
              bulk.onPreview(null);
            }}
            onClick={() => {
              bulk.onMove(move);
            }}
          >
            {SIGNAL_MOVE_GLYPHS[move].icon}
            {SIGNAL_MOVE_LABELS[move]}
            <kbd aria-hidden="true">{SIGNAL_MOVE_GLYPHS[move].key}</kbd>
          </button>
        );
      })}
      <button
        type="button"
        className="asks-bulk-x"
        aria-label="Clear the selection"
        title="Clear  Esc"
        onClick={bulk.onClear}
      >
        <CloseIcon size={14} />
      </button>
    </div>
  );
}
