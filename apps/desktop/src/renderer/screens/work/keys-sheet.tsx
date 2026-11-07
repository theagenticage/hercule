import { useId, type JSX } from "react";
import type { DesktopPlatform } from "../../../ipc/platform/desktop-platform";
import { describeUndoKey } from "../../app/primary-modifier";
import "./keys-sheet.css";

/** The keys of the Work board and what each does, as the sheet lists them. */
const KEY_ROWS: ReadonlyArray<readonly [keys: string, words: string]> = [
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
 * the top right. It is a dialog that does not hold the focus, so the keys keep
 * working while it is open. The screen closes it with `?` and with Esc.
 *
 * Undo is ⌘Z on a Mac and Ctrl Z elsewhere, so `platform` decides its row.
 */
export function KeysSheet({ platform }: { readonly platform: DesktopPlatform }): JSX.Element {
  const titleId = useId();
  const rows: typeof KEY_ROWS = [
    ...KEY_ROWS,
    [describeUndoKey(platform), "Undo"],
    ["Esc", "Step back"],
  ];
  return (
    <section className="keys-sheet" role="dialog" aria-labelledby={titleId}>
      <h2 id={titleId}>Keys</h2>
      <dl>
        {rows.map(([keys, words]) => (
          <div key={keys}>
            <dt>
              <kbd>{keys}</kbd>
            </dt>
            <dd>{words}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
