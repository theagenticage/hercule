/**
 * The pane's own moves, under the answers: the moves that change only the
 * user's list and send nothing to the source (spec 17 §Snooze and Not
 * urgent). For a replaced signal, a way to its successor instead.
 */
import type { JSX, ReactNode } from "react";
import type { Signal } from "@hercule/contract";
import { decideSignalPaneMoves, planSignalMove } from "@hercule/client-core";
import { ArrowIcon } from "../../icons/arrow";
import { SIGNAL_MOVE_GLYPHS } from "./move-glyphs";
import { SNOOZE_ANCHOR } from "./snooze-menu";
import { useIntakeMoves } from "./use-signal-moves";

/**
 * Renders the pane's moves for `signal`, as `decideSignalPaneMoves` decides
 * them. Snooze opens the snooze menu above it; Open the newer one selects
 * the signal that replaced this one. With no moves, nothing is drawn.
 */
export function SignalPaneMoves({ signal }: { readonly signal: Signal }): JSX.Element | null {
  const moves = useIntakeMoves();
  const paneMoves = decideSignalPaneMoves(signal, moves.view);
  if (paneMoves.length === 0) return null;
  return (
    <div className="ledger ad-mine">
      {paneMoves.map(({ move, label, describe }) =>
        move === "open-newer" ? (
          <MoveRow
            key={move}
            icon={<ArrowIcon size={14} />}
            label={label}
            describe={describe}
            onPress={() => {
              if (signal.replacedBy !== undefined) moves.select(signal.replacedBy);
            }}
          />
        ) : (
          <MoveRow
            key={move}
            icon={SIGNAL_MOVE_GLYPHS[move].icon}
            label={label}
            describe={describe}
            keyLabel={SIGNAL_MOVE_GLYPHS[move].key}
            locked={moves.pending}
            opensMenu={move === "snooze" ? moves.snoozeMenuPlace === "pane" : undefined}
            onPress={() => {
              if (move === "snooze") moves.toggleSnoozeMenu("pane", [signal]);
              else moves.run(planSignalMove([signal], move));
            }}
          />
        ),
      )}
    </div>
  );
}

/**
 * Renders one of the pane's moves as a ledger row, as an answer is drawn.
 * `opensMenu` is set on Snooze while its menu is open, which the row then
 * anchors. While `locked`, the row does nothing.
 */
function MoveRow({
  icon,
  label,
  describe,
  keyLabel,
  locked = false,
  opensMenu,
  onPress,
}: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly describe: string;
  readonly keyLabel?: string | undefined;
  readonly locked?: boolean;
  /** Set only on the row that opens the snooze menu: whether the menu is open from it. */
  readonly opensMenu?: boolean | undefined;
  readonly onPress: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className="ans"
      data-opens-snooze={opensMenu === undefined ? undefined : true}
      aria-haspopup={opensMenu === undefined ? undefined : "menu"}
      aria-expanded={opensMenu}
      aria-disabled={locked || undefined}
      style={opensMenu === true ? { anchorName: SNOOZE_ANCHOR } : undefined}
      onClick={() => {
        if (!locked) onPress();
      }}
    >
      <span className="btn btn--quiet">
        {icon}
        {label}
      </span>
      <span className="ans-desc">{describe}</span>
      {keyLabel !== undefined && <kbd aria-hidden="true">{keyLabel}</kbd>}
    </button>
  );
}
