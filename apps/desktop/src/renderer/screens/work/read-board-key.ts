import type { BoardWalk } from "@hercule/client-core/work";
import { BOARD_STAGES, type BoardStage } from "@hercule/contract";
import { isOtherModifierHeld, isPrimaryModifierHeld } from "../../app/primary-modifier";
import type { DesktopPlatform } from "../../../ipc/platform/desktop-platform";

/** What a key press asks of the Work board. */
export type BoardKeyCommand =
  | { readonly kind: "walk"; readonly walk: BoardWalk }
  | { readonly kind: "open-card" }
  /** Moves the card to the stage before (`-1`) or after (`1`) its own. */
  | { readonly kind: "shift-stage"; readonly direction: -1 | 1 }
  | { readonly kind: "pick-stage"; readonly stage: BoardStage }
  | { readonly kind: "add" }
  | { readonly kind: "fold-lane" }
  | { readonly kind: "fold-all-lanes" }
  | { readonly kind: "find" }
  | { readonly kind: "undo" }
  | { readonly kind: "toggle-keys-sheet" }
  | { readonly kind: "step-back" };

/** The parts of a keyboard event that decide which command a key is. */
export interface BoardKeyPress {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
}

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
 * `/` or `?`. Single keys are the only ones `hasSingleKeys` turns off. The
 * arrows, Return, Space, Esc and ⌘Z stay on, because they act on the focused
 * element or are not typed characters. Shift only counts with the arrows (to
 * move a card) and with F (to fold every lane): Alt, and ⌘ or Ctrl other than
 * for undo, make the key the app's or the system's.
 *
 * `platform` decides which of ⌘ and Ctrl undoes.
 */
export const readBoardKey = (
  press: BoardKeyPress,
  hasSingleKeys: boolean,
  platform: DesktopPlatform,
): BoardKeyCommand | null => {
  if (press.altKey) return null;
  if (press.metaKey || press.ctrlKey) {
    const isUndo =
      press.key.toLowerCase() === "z" &&
      !press.shiftKey &&
      isPrimaryModifierHeld(press, platform) &&
      !isOtherModifierHeld(press, platform);
    return isUndo ? { kind: "undo" } : null;
  }

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
  const letterWalk = LETTER_WALKS[letter];
  return letterWalk === undefined ? null : { kind: "walk", walk: letterWalk };
};
