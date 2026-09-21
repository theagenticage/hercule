import type { JSX } from "react";
import type { AccessModeMenuItem } from "@hercule/client-core";
import type { AccessMode } from "@hercule/contract";
import { MenuRow } from "./menu";
import { SelectorShell } from "./selector-shell";

/**
 * The four access modes, with no header: the modes are their own heading.
 *
 * A mode the provider does not declare native keeps its row and stays
 * pickable - the controller runs it at the nearest mode it does declare, and
 * the row says so in the attention hue under its meaning, rather than
 * refusing the choice or dropping what the mode means.
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
