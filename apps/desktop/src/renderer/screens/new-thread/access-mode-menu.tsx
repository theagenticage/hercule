import type { JSX } from "react";
import type { AccessModeMenuItem } from "@hercule/client-core";
import type { AccessMode } from "@hercule/contract";
import { MenuLine } from "./menu-line";

/**
 * Renders the content of a Draft Thread's access-mode menu: one row per mode,
 * with what the mode means under its name, and the current mode checked.
 *
 * A mode the provider does not support keeps its row and can still be
 * picked: the controller runs the nearest mode the provider supports. The
 * row says so on a line of its own, so the fallback is never silent.
 */
export function AccessModeMenu({
  value,
  rows,
  onPick,
}: {
  readonly value: AccessMode;
  readonly rows: readonly AccessModeMenuItem[];
  readonly onPick: (mode: AccessMode) => void;
}): JSX.Element {
  return (
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
  );
}
