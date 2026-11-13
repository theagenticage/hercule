import type { JSX } from "react";
import type { AccessModeMenuItem } from "@hercule/client-core";
import type { AccessMode } from "@hercule/contract";
import { MenuLine } from "../thread/menu-line";

/**
 * Renders the content of a Draft Thread's access-mode menu: one row per mode,
 * with what the mode means under its name, and the current mode checked.
 *
 * A mode the harness does not support keeps its row and can still be
 * picked: the controller runs the nearest mode the harness supports. The
 * row says so on a line of its own, so the fallback is never silent.
 */
export function AccessModeMenu({
  value,
  rows,
  reason,
  onPick,
}: {
  readonly value: AccessMode;
  readonly rows: readonly AccessModeMenuItem[];
  /** Why the value is what it is, drawn as a muted line above the rows, or `null`. */
  readonly reason?: string | null | undefined;
  readonly onPick: (mode: AccessMode) => void;
}): JSX.Element {
  return (
    <>
      {reason == null ? null : <p className="pop-reason">{reason}</p>}
      <div className="pop-sec">
        {rows.map((row) => (
          <MenuLine
            key={row.mode}
            name={row.label}
            sub={row.meaning}
            warning={row.dimmed}
            current={row.mode === value}
            onPick={() => {
              onPick(row.mode);
            }}
          />
        ))}
      </div>
    </>
  );
}
