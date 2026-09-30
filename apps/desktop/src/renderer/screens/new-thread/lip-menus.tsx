import type { JSX } from "react";
import {
  describeMachineRow,
  joinPhraseText,
  type BranchField,
  type MachineRow,
  type WorkspaceMenu,
  type WorkspacePick,
} from "@hercule/client-core";
import { MenuLine } from "./menu-line";

// The three menus of a Draft Thread's lip. Branch names and worktree names
// are set in the UI face like every other name: the desktop keeps monospace
// for code, commands and diffs (spec 17 §Design system, Bureau change 2).

/**
 * Renders the content of the workspace menu: where the thread works. Each
 * row is a workspace the thread can join or one it would create, with the
 * machine it is on at the right and what it holds under its name.
 */
export function WorkspaceMenuContent({
  menu,
  onPick,
}: {
  readonly menu: WorkspaceMenu;
  readonly onPick: (pick: WorkspacePick) => void;
}): JSX.Element {
  return (
    <>
      <div className="pop-h">
        <b>Workspace</b>
        <span>locks when the thread starts</span>
      </div>
      <div className="pop-sec">
        {menu.rows.map((row) => (
          <MenuLine
            key={row.key}
            name={row.name}
            sub={row.sub}
            note={row.note}
            current={row.current}
            onPick={() => {
              onPick(row.pick);
            }}
          />
        ))}
      </div>
    </>
  );
}

/**
 * Renders the content of the branch menu. For a main workspace it picks the
 * branch the checkout switches to; for a new workspace, the branch the
 * thread's new branch starts from. `field` says which, in its header.
 *
 * A branch another live workspace on the machine has checked out cannot be
 * picked, because git lets one branch be checked out in one place only; its
 * row names that workspace.
 */
export function BranchMenuContent({
  field,
  onPick,
}: {
  readonly field: BranchField;
  readonly onPick: (branch: string) => void;
}): JSX.Element {
  return (
    <>
      <div className="pop-h">
        <b>{field.header}</b>
        <span>{field.note}</span>
      </div>
      <div className="pop-sec">
        {field.rows.map((row) => (
          <MenuLine
            key={row.branch}
            name={row.branch}
            note={[row.badge, row.dimmed].filter((each) => each !== null).join(" · ") || null}
            current={row.branch === field.value}
            inert={row.dimmed !== null}
            onPick={() => {
              onPick(row.branch);
            }}
          />
        ))}
      </div>
      {field.foot === null ? null : <p className="pop-foot">{joinPhraseText(field.foot)}</p>}
    </>
  );
}

/**
 * Renders the content of the machine menu: the runners the thread can be
 * placed on. Each row has the runner's state and how many of its places are
 * taken at the right, and under its name what kind of machine it is and why
 * it cannot be picked, if it cannot.
 *
 * The web app's menu ends with a link to add a machine. The desktop app has
 * no screen to add one, so its foot keeps only the sentence.
 */
export function MachineMenuContent({
  rows,
  onPick,
}: {
  readonly rows: readonly MachineRow[];
  readonly onPick: (runnerId: string) => void;
}): JSX.Element {
  return (
    <>
      <div className="pop-h">
        <b>Machine</b>
        <span>locks when the thread starts</span>
      </div>
      <div className="pop-sec">
        {rows.map((row) => (
          <MenuLine
            key={row.runnerId}
            name={row.name}
            sub={describeMachineRow(row)}
            note={
              <>
                <span className="machine-state" data-state={row.state}>
                  {row.state}
                </span>{" "}
                {row.capacity}
              </>
            }
            current={row.current}
            inert={row.dimmed !== null}
            onPick={() => {
              onPick(row.runnerId);
            }}
          />
        ))}
      </div>
      <p className="pop-foot">The thread runs where you say; nothing moves it later.</p>
    </>
  );
}
