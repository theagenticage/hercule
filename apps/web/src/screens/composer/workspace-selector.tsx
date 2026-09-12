import type { JSX } from "react";
import { MenuRow } from "./menu-row";
import { SelectorShell } from "./selector-shell";

/** Until a thread can join one, the only workspace on offer is no workspace. */
const NONE = "No workspace";

/**
 * The lip's first selector. Adopting a folder and adding a repo are the two
 * entries it will hold (#72); they are on show and dimmed rather than absent,
 * so the shape of the menu is the shape it keeps.
 */
export function WorkspaceSelector({
  locked,
  open,
  onOpenChange,
  onPick,
}: {
  readonly locked: string | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onPick: () => void;
}): JSX.Element {
  return (
    <SelectorShell
      keyLabel="workspace"
      label={NONE}
      locked={locked}
      open={open}
      onOpenChange={onOpenChange}
      contentClassName="w-[420px]"
    >
      <MenuRow name={NONE} current onPick={onPick} />
      <MenuRow name="Adopt a folder on this machine…" dimmed="not built yet" />
      <MenuRow name="Add a repo →" dimmed="not built yet" />
    </SelectorShell>
  );
}
