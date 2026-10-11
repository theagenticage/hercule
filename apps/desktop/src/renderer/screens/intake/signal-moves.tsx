/**
 * The pane's own moves, under the answers: the moves that change only the
 * user's list and send nothing to the source (spec 17 §Snooze and Not
 * urgent). For a replaced signal, a way to its successor instead.
 */
import type { JSX, ReactNode } from "react";
import type { Signal } from "@hercule/contract";
import { planBulkAction } from "@hercule/client-core";
import { AlarmIcon } from "../../icons/alarm";
import { ArrowIcon } from "../../icons/arrow";
import { UndoIcon } from "../../icons/undo";
import { SNOOZE_ANCHOR } from "./snooze-menu";
import { useIntakeMoves } from "./use-signal-moves";

/**
 * Renders the pane's moves for `signal`:
 *
 * - on Later: Unsnooze, then Snooze again…;
 * - on To do: Snooze…, then Not urgent for a Now signal;
 * - for a replaced signal: a way to open the newer one.
 *
 * A resolved signal that was not replaced has none, so nothing is drawn.
 */
export function SignalMoves({ signal }: { readonly signal: Signal }): JSX.Element | null {
  const moves = useIntakeMoves();
  if (signal.replacedBy !== undefined) {
    const successorId = signal.replacedBy;
    return (
      <div className="ledger ad-mine">
        <MoveRow
          icon={<ArrowIcon size={14} />}
          label="Open the newer one"
          describe="A newer signal asks the same thing"
          onPress={() => {
            moves.select(successorId);
          }}
        />
      </div>
    );
  }
  if (signal.status !== "open") return null;
  const later = moves.view === "later";
  const menuHere = moves.snoozeMenuPlace === "pane";
  return (
    <div className="ledger ad-mine">
      {later && (
        <MoveRow
          icon={<UndoIcon size={14} />}
          label="Unsnooze"
          describe="Puts it back on To do now"
          keyLabel="U"
          locked={moves.pending}
          onPress={() => {
            moves.run(planBulkAction([signal], "unsnooze"));
          }}
        />
      )}
      <MoveRow
        icon={<AlarmIcon size={14} />}
        label={later ? "Snooze again…" : "Snooze…"}
        describe={
          later
            ? "Changes when it comes back. Only for you"
            : "Hides it from To do until a time you pick. Only for you"
        }
        keyLabel="H"
        locked={moves.pending}
        opensMenu={menuHere}
        onPress={() => {
          moves.toggleSnoozeMenu("pane", [signal]);
        }}
      />
      {!later && signal.priority === "urgent" && (
        <MoveRow
          icon={
            <span className="asks-down">
              <ArrowIcon size={14} />
            </span>
          }
          label="Not urgent"
          describe="Moves it out of Now. Only for you"
          locked={moves.pending}
          onPress={() => {
            moves.run(planBulkAction([signal], "not-urgent"));
          }}
        />
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
  readonly keyLabel?: string;
  readonly locked?: boolean;
  /** Set only on the row that opens the snooze menu: whether the menu is open from it. */
  readonly opensMenu?: boolean;
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
