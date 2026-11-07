import type { JSX } from "react";
import type { DesktopPlatform } from "../../../ipc/platform/desktop-platform";
import { KeysSheet as DeskKeysSheet, type KeyRow } from "../desk";

/** The keys of the Work board and what each does, as the sheet lists them. */
const KEY_ROWS: readonly KeyRow[] = [
  ["↑ ↓ ← →", "Walk the board (also H J K L)"],
  ["[ ]", "Previous and next lane"],
  ["Return", "Open a card"],
  ["⇧← ⇧→", "Move a card a stage"],
  ["1 to 5", "Move a card to a stage"],
  ["X", "Select a card"],
  ["D", "Mark a card Done"],
  ["⌫", "Drop a card"],
  ["T", "Start a thread on a card"],
  ["M", "Merge a card into another"],
  ["A", "Add to Work"],
  ["F", "Fold this lane"],
  ["⇧F", "Fold every lane"],
  ["/", "Find"],
];

/**
 * Renders the sheet that lists the keys of the Work board, over the board at
 * the top right. The screen closes it with `?` and with Esc.
 */
export function KeysSheet({ platform }: { readonly platform: DesktopPlatform }): JSX.Element {
  return <DeskKeysSheet rows={KEY_ROWS} platform={platform} />;
}
