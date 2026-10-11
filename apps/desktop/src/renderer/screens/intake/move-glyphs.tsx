/**
 * How each of Intake's moves is drawn wherever it shows: on a row, in the
 * bulk bar and in the pane. The labels come from `SIGNAL_MOVE_LABELS` in
 * client-core; this table adds what only a screen draws.
 */
import type { ReactNode } from "react";
import { SIGNAL_MOVE_LABELS, type SignalMove } from "@hercule/client-core";
import { AlarmIcon } from "../../icons/alarm";
import { ArrowIcon } from "../../icons/arrow";
import { CheckIcon } from "../../icons/check";
import { UndoIcon } from "../../icons/undo";

/** A move's icon, and the key that makes it, if one does. */
interface SignalMoveGlyph {
  readonly icon: ReactNode;
  readonly key?: string;
}

/** The icon and key of each move. Not urgent has no key. */
export const SIGNAL_MOVE_GLYPHS: Readonly<Record<SignalMove, SignalMoveGlyph>> = {
  snooze: { icon: <AlarmIcon size={14} />, key: "H" },
  unsnooze: { icon: <UndoIcon size={14} />, key: "U" },
  done: { icon: <CheckIcon size={14} />, key: "E" },
  "not-urgent": {
    icon: (
      <span className="asks-down">
        <ArrowIcon size={14} />
      </span>
    ),
  },
};

/**
 * Returns a move's tooltip: `text`, which is the move's label unless given,
 * then the move's key after two spaces, as "Snooze  H". A move with no key
 * gets `text` alone.
 */
export const describeMoveTitle = (
  move: SignalMove,
  text: string = SIGNAL_MOVE_LABELS[move],
): string => {
  const { key } = SIGNAL_MOVE_GLYPHS[move];
  return key === undefined ? text : `${text}  ${key}`;
};
