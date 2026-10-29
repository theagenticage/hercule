import type { JSX } from "react";
import type { StartingRevision } from "@hercule/contract";
import {
  describeMachineRow,
  joinPhraseText,
  type BranchField,
  type BranchListRows,
  type BranchRow,
  type MachineRow,
  type WorkspaceMenu,
  type WorkspacePick,
} from "@hercule/client-core";
import { MenuLine } from "../thread/menu-line";

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
 * The branch filter of the starting revision menu: the text typed in it, the
 * branch rows read for that text, and the line under them.
 */
export interface BranchMenuSearch {
  readonly text: string;
  readonly listed: BranchListRows;
  readonly onText: (text: string) => void;
}

/**
 * Renders the starting revisions a new workspace can use: the current
 * working copy and the remote default, then, with `search`, a filter and the
 * branches that match it. Each row keeps current, local and remote revisions
 * distinct when their branch names match.
 */
export function BranchMenuContent({
  field,
  search,
  onPick,
}: {
  readonly field: BranchField;
  /** The branch filter and its rows, or null when the menu lists no branches. */
  readonly search: BranchMenuSearch | null;
  readonly onPick: (revision: StartingRevision) => void;
}): JSX.Element {
  const renderRow = (row: BranchRow): JSX.Element => (
    <MenuLine
      key={row.key}
      name={row.label}
      note={[row.badge, row.dimmed].filter((each) => each !== null).join(" · ") || null}
      current={row.key === field.value}
      inert={row.dimmed !== null}
      onPick={() => {
        onPick(row.startingRevision);
      }}
    />
  );
  return (
    <>
      <div className="pop-h">
        <b>{field.header}</b>
        <span>{field.note}</span>
      </div>
      <div className="pop-sec">{field.rows.map(renderRow)}</div>
      {search === null ? null : (
        <div className="pop-sec">
          <input
            className="field menu-filter"
            aria-label="Filter branches"
            placeholder="Filter branches…"
            // A repository can have more branches than the menu lists, so
            // the filter is how the user finds one.
            autoFocus
            spellCheck={false}
            autoComplete="off"
            value={search.text}
            onChange={(event) => {
              search.onText(event.target.value);
            }}
          />
          <div className="branch-list">
            {search.listed.rows.map(renderRow)}
            {search.listed.note === null ? null : (
              <p className="fine branch-list-note">{search.listed.note}</p>
            )}
          </div>
        </div>
      )}
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
