import { useId, type JSX } from "react";
import type { DesktopPlatform } from "../../../ipc/platform/desktop-platform";
import { describeUndoKey } from "../../app/primary-modifier";
import "./keys-sheet.css";

/** One line of the sheet: the keys, as they are written, and what they do. */
export type KeyRow = readonly [keys: string, words: string];

/**
 * Renders the sheet that lists the keys of a page, over the page at the top
 * right. It is a dialog that does not hold the focus, so the keys keep
 * working while it is open. The page closes it with `?` and with Esc.
 *
 * `rows` are the page's own keys. Undo and Esc follow them on every page. Undo
 * is ⌘Z on a Mac and Ctrl Z elsewhere, so `platform` decides its row.
 */
export function KeysSheet({
  rows,
  platform,
}: {
  readonly rows: readonly KeyRow[];
  readonly platform: DesktopPlatform;
}): JSX.Element {
  const titleId = useId();
  const allRows: readonly KeyRow[] = [
    ...rows,
    [describeUndoKey(platform), "Undo"],
    ["Esc", "Step back"],
  ];
  return (
    <section className="keys-sheet" role="dialog" aria-labelledby={titleId}>
      <h2 id={titleId}>Keys</h2>
      <dl>
        {allRows.map(([keys, words]) => (
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
