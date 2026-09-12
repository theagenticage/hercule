import type { JSX } from "react";
import type { AccessModeMenuItem } from "@hydra/client-core";
import type { AccessMode } from "@hydra/contract";
import { MenuRow } from "./menu";
import { SelectorShell } from "./selector-shell";

/**
 * The four access modes, with no header: the modes are their own heading.
 *
 * A mode the provider does not declare native keeps its row and stays
 * pickable - the controller runs it at the nearest mode it does declare, and
 * the row says so in the attention hue rather than refusing the choice.
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
            item.dimmed === null ? item.meaning : <span className="text-attn">{item.dimmed}</span>
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
