import { isOtherModifierHeld, isPrimaryModifierHeld } from "../../app/primary-modifier";
import type { DesktopPlatform } from "../../../ipc/platform/desktop-platform";

/** The parts of a keyboard event that decide which command a key is on a page of the desk. */
export interface DeskKeyPress {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
}

/**
 * Returns whether `press` is the Undo key on `platform`: Z with ⌘ on a Mac or
 * Ctrl elsewhere, and no Shift (that is Redo), no Alt and not the other of
 * ⌘ and Ctrl.
 */
export const isUndoKey = (press: DeskKeyPress, platform: DesktopPlatform): boolean =>
  !press.altKey &&
  press.key.toLowerCase() === "z" &&
  !press.shiftKey &&
  isPrimaryModifierHeld(press, platform) &&
  !isOtherModifierHeld(press, platform);

/**
 * Matches what a key press can land on without being the page's: a menu or
 * popover, a dialog, and a side sheet. They keep their own keys.
 */
export const OVERLAY_SELECTOR = "[popover], dialog, [role='menu'], .side-sheet";

/** Matches a popover or a dialog that is open right now, which closes itself on Esc. */
export const OPEN_OVERLAY_SELECTOR = 'dialog[open], [popover="auto"]:popover-open';
