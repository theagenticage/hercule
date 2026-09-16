import type { JSX } from "react";
import type { WorkspaceMenu, WorkspacePick } from "@hydra/client-core";
import { MenuHeader, MenuRow } from "./menu";
import { SelectorShell } from "./selector-shell";

/**
 * The lip's first selector: where the thread works (spec 14 §The composer, the
 * Workspace selector). Every row is a thing that exists or a thing that would
 * be made, with what it means on its sub-line; nothing that cannot be picked is
 * hidden, it says why instead.
 *
 * Setting a project up is no longer done from here (D-20b): a project with
 * nothing to work in locks the selector with the way out as its reason, and
 * repos are added in the New project dialog.
 */
export function WorkspaceSelector({
  menu,
  locked,
  open,
  onOpenChange,
  onPick,
}: {
  readonly menu: WorkspaceMenu;
  readonly locked: string | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onPick: (pick: WorkspacePick) => void;
}): JSX.Element {
  return (
    <SelectorShell
      keyLabel="workspace"
      label={menu.label}
      locked={locked}
      open={open}
      onOpenChange={onOpenChange}
      contentClassName="w-[420px]"
    >
      <MenuHeader label="Workspace" note="locks when the thread starts" />
      {menu.rows.map((row) => (
        <MenuRow
          key={row.key}
          // Wrapped only where the wrapper says something: a second element
          // holding the same text is a second element a reader finds.
          name={row.mono ? <span className="font-mono">{row.name}</span> : row.name}
          note={row.note}
          sub={row.sub}
          current={row.current}
          onPick={() => {
            onPick(row.pick);
            onOpenChange(false);
          }}
        />
      ))}
    </SelectorShell>
  );
}
