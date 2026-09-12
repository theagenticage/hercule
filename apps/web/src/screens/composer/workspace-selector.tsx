import type { JSX } from "react";
import { MenuFoot, MenuHeader, MenuRow } from "./menu";
import { SelectorShell } from "./selector-shell";

/** Until a thread can join one, the only workspace on offer is no workspace. */
const NONE = "No workspace";

/**
 * The lip's first selector. Adding a repo and adopting a folder are what its
 * foot will offer (#72); they are on show and dimmed rather than absent, so
 * the shape of the menu is the shape it keeps.
 */
export function WorkspaceSelector({
  locked,
  open,
  onOpenChange,
}: {
  readonly locked: string | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
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
      <MenuHeader label="Workspace" note="locks when the thread starts" />
      <MenuRow
        name={NONE}
        sub="the agent works without a checkout"
        current
        onPick={() => {
          onOpenChange(false);
        }}
      />
      <MenuFoot>
        <div>
          <span>Add a repo →</span>
          <span> · not built yet</span>
        </div>
        <div>
          <span>Adopt a folder on this machine…</span>
          <span> · not built yet</span>
        </div>
      </MenuFoot>
    </SelectorShell>
  );
}
