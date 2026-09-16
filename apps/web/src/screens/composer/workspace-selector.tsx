import { useState, type JSX } from "react";
import type { WorkspaceMenu, WorkspacePick } from "@hydra/client-core";
import { MenuFoot, MenuHeader, MenuRow } from "./menu";
import { SelectorShell } from "./selector-shell";
import { AddRepoForm, AdoptForm } from "./workspace-foot";

/**
 * The lip's first selector: where the thread works (spec 14 §The composer, the
 * Workspace selector). Every row is a thing that exists or a thing that would
 * be made, with what it means on its sub-line; nothing that cannot be picked is
 * hidden, it says why instead.
 *
 * The foot is the way out of an empty project: a repo to add, or a folder on
 * this machine to adopt. On a draft that belongs to no project there is no
 * project to add a repo to, so the foot stands and says so.
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
  const [form, setForm] = useState<"add" | "adopt" | null>(null);

  return (
    <SelectorShell
      keyLabel="workspace"
      label={menu.label}
      locked={locked}
      open={open}
      onOpenChange={(next) => {
        if (!next) setForm(null);
        onOpenChange(next);
      }}
      contentClassName="w-[420px]"
      // A form inside the menu is what Esc leaves first: the menu stands, and
      // a second Esc closes it.
      onEscapeKeyDown={(event) => {
        if (form === null) return;
        event.preventDefault();
        setForm(null);
      }}
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
      <MenuFoot>
        {menu.foot === null ? (
          // Both ways out need a project to put the repo in, so a draft that
          // stands in none says what would unlock them instead of hiding them.
          <>
            <div>
              <span>Add a repo →</span>
              <span> · pick a project first</span>
            </div>
            <div>
              <span>Adopt a folder on this machine…</span>
              <span> · pick a project first</span>
            </div>
          </>
        ) : form === "add" ? (
          <AddRepoForm
            projectId={menu.foot.projectId}
            onDone={() => {
              setForm(null);
            }}
            onCancel={() => {
              setForm(null);
            }}
          />
        ) : form === "adopt" ? (
          <AdoptForm
            projectId={menu.foot.projectId}
            runnerId={menu.foot.runnerId}
            onCancel={() => {
              setForm(null);
            }}
          />
        ) : (
          <>
            <FootAction
              label={menu.foot.addRepo}
              onPick={() => {
                setForm("add");
              }}
            />
            <FootAction
              label="Adopt a folder on this machine…"
              onPick={() => {
                setForm("adopt");
              }}
            />
          </>
        )}
      </MenuFoot>
    </SelectorShell>
  );
}

/** One of the two ways out of an empty project, as the foot offers it. */
function FootAction({
  label,
  onPick,
}: {
  readonly label: string;
  readonly onPick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onPick}
      className="block cursor-pointer text-left hover:text-ink"
    >
      {label}
    </button>
  );
}
