import { useEffect, useRef, type JSX, type KeyboardEvent } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { buildProjectPickerRows } from "@hercule/client-core";
import { projectsQuery, resourcesQuery, threadsQuery, workspacesQuery } from "../../app/queries";
import { pickProjectTint, ProjectTile } from "../project-tile";
import "../thread/menus.css";
import "./project-picker.css";

/**
 * Returns the button after, or before, the focused one among the rows of
 * `list`, going round from the last row to the first and back. Returns the
 * first row when none is focused, and `undefined` when there are no rows.
 */
const findNextRow = (list: HTMLElement, step: 1 | -1): HTMLButtonElement | undefined => {
  const rows = [...list.querySelectorAll("button")];
  const focused = rows.findIndex((row) => row === document.activeElement);
  if (focused === -1) return rows[0];
  return rows[(focused + step + rows.length) % rows.length];
};

/**
 * Renders the project picker: the question a new thread starts with, which
 * project it is in. The project comes first because it bounds the repos and
 * workspaces the draft can offer (spec 14 §The composer).
 *
 * The picker is a modal dialog over a scrim, with one row per project: its
 * tile and name, its shortcut at the right, and what it holds under the
 * name. The row with focus is the one ⏎ picks, and focus starts on the
 * first row.
 *
 * - ↑ and ↓ move between the rows, and go round at either end.
 * - ⏎, or a click, picks a row.
 * - ⌘1 to ⌘9 pick the first nine projects directly.
 * - Esc, or a click on the scrim, closes the picker.
 *
 * Picking a project closes the picker, then calls `onPick` with the project,
 * where the caller opens a Draft Thread in it. The web app's picker also has
 * a New project row; the desktop app cannot create a project, so it has none,
 * and it is not opened when there is no project.
 *
 * `onClose` is called when the picker closes, whether a project was picked
 * or not. The caller then unmounts the picker.
 *
 * The picker closes before `onPick` is called because an open modal dialog
 * keeps the focus inside it, so the draft could not take it.
 */
export function ProjectPicker({
  onPick,
  onClose,
}: {
  readonly onPick: (projectId: string) => void;
  readonly onClose: () => void;
}): JSX.Element {
  const { controller } = useRouteContext({ from: "/_connected" });
  const { client } = controller;
  const projects = useSuspenseQuery(projectsQuery(client)).data;
  const resources = useSuspenseQuery(resourcesQuery(client)).data;
  const workspaces = useSuspenseQuery(workspacesQuery(client)).data;
  const threads = useSuspenseQuery(threadsQuery(client)).data;
  const rows = buildProjectPickerRows({ projects, resources, workspaces, sessions: threads });
  const dialogRef = useRef<HTMLDialogElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Whether the last press began on the scrim. A press inside the dialog that
  // is released on the scrim, as when the user selects text, fires its click
  // on the dialog element itself, just as a click on the scrim does.
  const pressedScrimRef = useRef(false);

  useEffect(() => {
    dialogRef.current?.showModal();
    // Which element a modal dialog focuses when it opens has changed between
    // browser versions, so the first row is focused here.
    listRef.current?.querySelector("button")?.focus();
  }, []);

  const openProject = (projectId: string): void => {
    dialogRef.current?.close();
    onPick(projectId);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDialogElement>): void => {
    if (event.metaKey) {
      const row = /^[1-9]$/.test(event.key) ? rows[Number(event.key) - 1] : undefined;
      if (row === undefined) return;
      event.preventDefault();
      openProject(row.projectId);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    // Without this, the arrow would also scroll the list.
    event.preventDefault();
    if (listRef.current === null) return;
    findNextRow(listRef.current, event.key === "ArrowDown" ? 1 : -1)?.focus();
  };

  return (
    <dialog
      ref={dialogRef}
      className="pop picker"
      aria-label="New thread in"
      // The browser closes the dialog itself on Esc, and then fires `close`.
      onClose={onClose}
      onKeyDown={handleKeyDown}
      // A press on the scrim reaches the dialog itself; a press inside the
      // dialog reaches one of its children, which fill it.
      onPointerDown={(event) => {
        pressedScrimRef.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        if (pressedScrimRef.current && event.target === event.currentTarget)
          event.currentTarget.close();
      }}
    >
      <div className="pop-h">
        <b>New thread in</b>
        <span>the project bounds the repos and workspaces on offer</span>
      </div>
      <div className="pop-sec picker-rows" ref={listRef}>
        {rows.map((row) => (
          <button
            key={row.projectId}
            type="button"
            className="line picker-row"
            onClick={() => {
              openProject(row.projectId);
            }}
          >
            <span className="grow">
              <ProjectTile tint={pickProjectTint(row.projectId, projects)} name={row.name} />
              <small>{row.sub}</small>
            </span>
            {row.shortcut === null ? null : <kbd>{row.shortcut}</kbd>}
          </button>
        ))}
      </div>
      <p className="pop-foot picker-keys">
        <span>
          <kbd>↑↓</kbd> Navigate
        </span>
        <span>
          <kbd>⏎</kbd> Select
        </span>
        <span>
          <kbd>Esc</kbd> Close
        </span>
      </p>
    </dialog>
  );
}
