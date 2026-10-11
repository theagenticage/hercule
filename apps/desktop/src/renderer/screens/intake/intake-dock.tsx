/**
 * The dock at the bottom of Intake's list: the toast of the last move, and
 * the bulk bar while rows are checked (spec 17 §Row controls and the bulk
 * bar, §The foot, the toast and failures).
 */
import { useEffect, useEffectEvent, useState, type JSX, type ReactNode } from "react";
import type { SignalMove } from "@hercule/client-core";
import { AlarmIcon } from "../../icons/alarm";
import { CheckIcon } from "../../icons/check";
import { CloseIcon } from "../../icons/close";
import { UndoIcon } from "../../icons/undo";
import { SNOOZE_ANCHOR } from "./snooze-menu";
import type { MoveToast } from "./use-signal-moves";

/** How long a toast shows before it fades, in milliseconds. */
const TOAST_SHOWN_MS = 5_000;

/** What the bulk bar shows and does, for the rows checked in the view. */
export interface BulkBar {
  readonly checkedCount: number;
  /** The buttons, in drawing order, as `listBulkMoves` returns them. */
  readonly moves: ReadonlyArray<SignalMove>;
  /** The bar's line while a button has hover or focus, such as "Done 3 · keeps 2 proposals". */
  readonly preview: string | null;
  readonly snoozeMenuOpen: boolean;
  /** Called with the move whose button gains hover or focus, and with `null` when it loses both. */
  readonly onPreview: (move: SignalMove | null) => void;
  readonly onMove: (move: SignalMove) => void;
  readonly onClear: () => void;
}

/** Each bulk button's icon, label and key. Not urgent is never a bulk button. */
const BULK_BUTTONS: Readonly<
  Record<
    Exclude<SignalMove, "not-urgent">,
    { readonly icon: ReactNode; readonly label: string; readonly key: string }
  >
> = {
  snooze: { icon: <AlarmIcon size={14} />, label: "Snooze", key: "H" },
  unsnooze: { icon: <UndoIcon size={14} />, label: "Unsnooze", key: "U" },
  done: { icon: <CheckIcon size={14} />, label: "Done", key: "E" },
};

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
 * A failed move shows its error here, in the fail colours, as an alert.
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
      <span className="asks-toast-text">{toast.text}</span>
    </div>
  );
}

/**
 * Renders the bulk bar: "3 selected", or the preview of the button with
 * hover or focus, then the buttons and the clear button. The bar anchors
 * the snooze menu while the menu is open from it.
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
        {bulk.preview ?? (
          <>
            <b>{bulk.checkedCount}</b> selected
          </>
        )}
      </span>
      {bulk.moves.map((move) => {
        if (move === "not-urgent") return null;
        const button = BULK_BUTTONS[move];
        const opensMenu = move === "snooze";
        return (
          <button
            key={move}
            type="button"
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
            {button.icon}
            {button.label}
            <kbd aria-hidden="true">{button.key}</kbd>
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
