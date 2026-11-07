import type { InboxWalk } from "@hercule/client-core/inbox";
import { isUndoKey, type DeskKeyPress } from "../desk/desk-keys";
import type { DesktopPlatform } from "../../../ipc/platform/desktop-platform";

/** What a key press asks of the Inbox page. */
export type InboxKeyCommand =
  | { readonly kind: "walk"; readonly walk: InboxWalk }
  | { readonly kind: "open" }
  | { readonly kind: "take" }
  | { readonly kind: "dismiss" }
  | { readonly kind: "see-task" }
  | { readonly kind: "undo" }
  | { readonly kind: "toggle-keys-sheet" }
  | { readonly kind: "step-back" };

const ARROW_WALKS: Readonly<Record<string, InboxWalk>> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};

/** The single-letter keys and what each asks. J and K read through the page in its order. */
const LETTER_COMMANDS: Readonly<Record<string, InboxKeyCommand>> = {
  j: { kind: "walk", walk: "next" },
  k: { kind: "walk", walk: "previous" },
  t: { kind: "take" },
  e: { kind: "dismiss" },
  g: { kind: "see-task" },
};

/**
 * Returns the command that `press` is on the Inbox page, or `null` when the
 * page does not use the key.
 *
 * Only ⌘Z (Ctrl Z on Linux) takes a modifier; with any other modifier a key
 * belongs to the app or the system. Shift is allowed only for `?`, which is
 * typed with it on most keyboards. `platform` decides which of ⌘ and Ctrl
 * undoes.
 */
export const readInboxKey = (
  press: DeskKeyPress,
  platform: DesktopPlatform,
): InboxKeyCommand | null => {
  if (press.altKey) return null;
  if (press.metaKey || press.ctrlKey) return isUndoKey(press, platform) ? { kind: "undo" } : null;
  const { key, shiftKey } = press;
  if (key === "?") return { kind: "toggle-keys-sheet" };
  if (key === "Escape") return { kind: "step-back" };
  if (shiftKey) return null;
  const walk = ARROW_WALKS[key];
  if (walk !== undefined) return { kind: "walk", walk };
  if (key === "Enter" || key === " ") return { kind: "open" };
  return LETTER_COMMANDS[key.toLowerCase()] ?? null;
};
