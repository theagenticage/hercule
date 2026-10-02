import { useEffect, useRef, type JSX, type KeyboardEvent } from "react";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { buildProjectPickerRows } from "@hercule/client-core";
import {
  connectionsQuery,
  projectsQuery,
  resourcesQuery,
  threadsQuery,
  workspacesQuery,
} from "../../app/queries";
import { GlassDialog } from "../glass-dialog";
import { pickProjectTint, ProjectTile } from "../project-tile";
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
 * The last row is New project, which closes the picker and calls
 * `onNewProject`, where the caller opens the New project dialog. With no
 * projects, a No project row comes first, so a thread can still start
 * without a project.
 *
 * Picking a row closes the picker, then calls `onPick` with the project, or
 * with `undefined` for No project, where the caller opens a Draft Thread.
 * The picker closes first because an open modal dialog keeps the focus
 * inside it, so the draft could not take it.
 *
 * `onClose` is called when the picker closes, whether a row was picked or
 * not. The caller then unmounts the picker.
 */
export function ProjectPicker({
  onPick,
  onNewProject,
  onClose,
}: {
  readonly onPick: (projectId: string | undefined) => void;
  readonly onNewProject: () => void;
  readonly onClose: () => void;
}): JSX.Element {
  const { controller } = useRouteContext({ from: "/_connected" });
  const { client } = controller;
  const queryClient = useQueryClient();
  const projects = useSuspenseQuery(projectsQuery(client)).data;
  const resources = useSuspenseQuery(resourcesQuery(client)).data;
  const workspaces = useSuspenseQuery(workspacesQuery(client)).data;
  const threads = useSuspenseQuery(threadsQuery(client)).data;
  const rows = buildProjectPickerRows({ projects, resources, workspaces, sessions: threads });
  const dialogRef = useRef<HTMLDialogElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // The New project form reads the Connections. Reading them now means the
    // form rarely waits for them when the user picks New project.
    void queryClient.prefetchQuery(connectionsQuery(client));
  }, [queryClient, client]);

  useEffect(() => {
    // Which element a modal dialog focuses when it opens has changed between
    // browser versions, so the first row is focused here. The dialog has
    // opened by now: a child's effects run before its parent's.
    listRef.current?.querySelector("button")?.focus();
  }, []);

  const openProject = (projectId: string | undefined): void => {
    dialogRef.current?.close();
    onPick(projectId);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDialogElement>): void => {
    if (event.metaKey && (/^[1-9]$/.test(event.key) || event.key === "Enter")) {
      // The page sees a shortcut before the menu does, and a handled one
      // never reaches the menu. Every ⌘1 to ⌘9 and ⌘↵ is handled, even a
      // number with no project, so that the Go menu does not open a thread and
      // Thread > Send does not send the message behind the picker.
      event.preventDefault();
      const row = event.key === "Enter" ? undefined : rows[Number(event.key) - 1];
      if (row !== undefined) openProject(row.projectId);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    // Without this, the arrow would also scroll the list.
    event.preventDefault();
    if (listRef.current === null) return;
    findNextRow(listRef.current, event.key === "ArrowDown" ? 1 : -1)?.focus();
  };

  return (
    <GlassDialog
      dialogRef={dialogRef}
      className="picker"
      label="New thread in"
      onClose={onClose}
      onKeyDown={handleKeyDown}
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
        {rows.length === 0 ? (
          <button
            type="button"
            className="line picker-row"
            onClick={() => {
              openProject(undefined);
            }}
          >
            <span className="grow">
              <ProjectTile tint={null} name="No project" />
            </span>
          </button>
        ) : null}
        <button
          type="button"
          className="line picker-row"
          onClick={() => {
            dialogRef.current?.close();
            onNewProject();
          }}
        >
          <span className="grow picker-new">New project</span>
        </button>
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
    </GlassDialog>
  );
}
