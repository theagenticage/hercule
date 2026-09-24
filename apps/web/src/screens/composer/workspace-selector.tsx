import type { JSX } from "react";
import type { WorkspaceMenu, WorkspacePick } from "@hercule/client-core";
import { MenuHeader, MenuRow } from "./menu";
import { SelectorShell } from "./selector-shell";

/**
 * The lip's first selector: where the thread works (spec 14 §The composer, the
 * Workspace selector). Each row is an existing workspace or one that would be
 * created, with an explanation on its sub-line.
 *
 * Projects are not set up from here. For a project with nothing to work in,
 * the selector is locked and its reason tells the user what to do; repos are
 * added in the New project dialog.
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
          // Wrap the name only when it needs the mono font, so the same text
          // does not appear in two nested elements.
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
