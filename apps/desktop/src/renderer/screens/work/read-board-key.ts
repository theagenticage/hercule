import type { BoardWalk, EndStage } from "@hercule/client-core/work";
import { BOARD_STAGES, type BoardStage } from "@hercule/contract";
import type { DeskKeyPress } from "../desk/desk-keys";

/** What a key press asks of the Work board. */
export type BoardKeyCommand =
  | { readonly kind: "walk"; readonly walk: BoardWalk }
  | { readonly kind: "open-card" }
  /** Moves the card to the stage before (`-1`) or after (`1`) its own. */
  | { readonly kind: "shift-stage"; readonly direction: -1 | 1 }
  | { readonly kind: "pick-stage"; readonly stage: BoardStage }
  | { readonly kind: "add" }
  /** Marks the card Done (`D`) or Dropped (`⌫`). */
  | { readonly kind: "end"; readonly stage: EndStage }
  /** Asks what a new Thread on the card should do (`T`). */
  | { readonly kind: "start-thread" }
  /** Starts picking the card to merge the card into (`M`). */
  | { readonly kind: "merge" }
  /** Selects the card, or takes it out of the selection (`X`). */
  | { readonly kind: "select" }
  | { readonly kind: "fold-lane" }
  | { readonly kind: "fold-all-lanes" }
  | { readonly kind: "find" }
  | { readonly kind: "toggle-keys-sheet" }
  | { readonly kind: "step-back" };

const ARROW_WALKS: Readonly<Record<string, BoardWalk>> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};

/** The walk each letter does, in the order of the Vim keys. */
const LETTER_WALKS: Readonly<Record<string, BoardWalk>> = {
  h: "left",
  j: "down",
  k: "up",
  l: "right",
};

/**
 * Returns the command that `press` is on the Work board, or `null` when the
 * board does not use the key.
 *
 * A single key is one that types a character: a letter, a digit, a bracket,
 * `/` or `?`. Backspace and Delete count as single keys too, though they type
 * nothing: they drop a card, and Display's switch is how a user makes sure a
 * stray key never does. Single keys are the only ones `hasSingleKeys` turns off. The
 * arrows, Return, Space and Esc stay on, because they act on the focused
 * element or are not typed characters. Shift only counts with the arrows (to
 * move a card) and with F (to fold every lane): Alt, ⌘ and Ctrl make the key
 * the app's or the system's. Undo is not a board key: the shell listens for it
 * on every screen.
 */
export const readBoardKey = (
  press: DeskKeyPress,
  hasSingleKeys: boolean,
): BoardKeyCommand | null => {
  if (press.altKey || press.metaKey || press.ctrlKey) return null;

  const { key, shiftKey } = press;
  if (key === "Escape") return { kind: "step-back" };
  const walk = ARROW_WALKS[key];
  if (walk !== undefined) {
    if (!shiftKey) return { kind: "walk", walk };
    if (key === "ArrowLeft") return { kind: "shift-stage", direction: -1 };
    if (key === "ArrowRight") return { kind: "shift-stage", direction: 1 };
    return null;
  }
  if (key === "Enter" || key === " ") return shiftKey ? null : { kind: "open-card" };

  if (!hasSingleKeys) return null;
  if (key === "Backspace" || key === "Delete") {
    return shiftKey ? null : { kind: "end", stage: "dropped" };
  }
  if (key === "?") return { kind: "toggle-keys-sheet" };
  if (key === "/") return { kind: "find" };
  if (key === "[") return { kind: "walk", walk: "previousLane" };
  if (key === "]") return { kind: "walk", walk: "nextLane" };
  const stage = /^[1-5]$/.test(key) ? BOARD_STAGES[Number(key) - 1] : undefined;
  if (stage !== undefined) return { kind: "pick-stage", stage };
  const letter = key.toLowerCase();
  if (letter === "f") return { kind: shiftKey ? "fold-all-lanes" : "fold-lane" };
  if (shiftKey) return null;
  if (letter === "a") return { kind: "add" };
  if (letter === "d") return { kind: "end", stage: "done" };
  if (letter === "t") return { kind: "start-thread" };
  if (letter === "m") return { kind: "merge" };
  if (letter === "x") return { kind: "select" };
  const letterWalk = LETTER_WALKS[letter];
  return letterWalk === undefined ? null : { kind: "walk", walk: letterWalk };
};
