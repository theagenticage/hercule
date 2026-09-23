import type { JSX } from "react";
import type { AccessModeMenuItem } from "@hercule/client-core";
import type { AccessMode } from "@hercule/contract";
import { MenuRow } from "./menu";
import { SelectorShell } from "./selector-shell";

/**
 * The selector for the four access modes. The menu has no header, because the
 * mode names are clear on their own.
 *
 * A mode the provider does not support natively keeps its row and can still be
 * picked. The controller runs it at the nearest mode the provider does
 * support, and the row explains this in the attention hue below the mode's
 * description. The menu neither blocks the choice nor hides the mode.
 */
export function AccessModeSelector({
  mode,
  items,
  locked,
  open,
  onOpenChange,
  onPick,
}: {
  readonly mode: AccessMode;
  readonly items: readonly AccessModeMenuItem[];
  readonly locked: string | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onPick: (mode: AccessMode) => void;
}): JSX.Element {
  return (
    <SelectorShell label={mode} locked={locked} open={open} onOpenChange={onOpenChange}>
      {items.map((item) => (
        <MenuRow
          key={item.mode}
          name={item.mode}
          current={item.mode === mode}
          sub={
            <>
              <span className="block">{item.meaning}</span>
              {item.dimmed === null ? null : <span className="block text-attn">{item.dimmed}</span>}
            </>
          }
          onPick={() => {
            onPick(item.mode);
            onOpenChange(false);
          }}
        />
      ))}
    </SelectorShell>
  );
}
