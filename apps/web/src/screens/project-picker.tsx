import { useEffect, useRef, useState, type JSX } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  buildProjectPickerRows,
  type HerculeClient,
  type ProjectPickerRow,
} from "@hercule/client-core";
import { cn } from "@hercule/ui";
import { ProjectDot } from "./project-dot";
import { projectsQuery, resourcesQuery, sessionsQuery, workspacesQuery } from "../app/queries";

/**
 * The project picker (spec 14 §The composer): "Creating a thread is one step,
 * after the project." It opens over a scrim rather than as a screen of its
 * own, because choosing a project is not a place the user goes. It is a
 * single question asked before the draft opens.
 *
 * A fresh install has no project, so the picker shows only the New project
 * row. Projects are created in the New project dialog, not in the picker.
 */
export function ProjectPicker({
  client,
  onClose,
  onNewProject,
}: {
  readonly client: HerculeClient;
  readonly onClose: () => void;
  /** Opens the New project dialog; called by the New project row. */
  readonly onNewProject: () => void;
}): JSX.Element {
  const navigate = useNavigate();
  const projects = useQuery(projectsQuery(client)).data?.items ?? [];
  const resources = useQuery(resourcesQuery(client)).data?.items ?? [];
  const workspaces = useQuery(workspacesQuery(client)).data?.items ?? [];
  const sessions = useQuery(sessionsQuery(client)).data?.items ?? [];
  const rows = buildProjectPickerRows({ projects, resources, workspaces, sessions });

  const openProject = (projectId: string): void => {
    onClose();
    void navigate({ to: "/threads/new", search: { project: projectId } });
  };

  const [active, setActive] = useState(0);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    panel.current?.focus();
  }, []);

  // ↑↓, ⏎, Esc and ⌘<n> are handled on the document rather than on the panel.
  // The picker is the only thing that handles keys while it is open, and a
  // click on the scrim or a row would otherwise move focus away from the
  // panel and stop its key handling.
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.metaKey || event.ctrlKey) {
        const row = rows[Number(event.key) - 1];
        if (row !== undefined) {
          event.preventDefault();
          openProject(row.projectId);
        }
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const last = rows.length; // the New project row sits past the last project
        const next = active + (event.key === "ArrowDown" ? 1 : -1);
        setActive(next < 0 ? last : next > last ? 0 : next);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const row = rows[active];
        if (row === undefined) onNewProject();
        else openProject(row.projectId);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  });

  return (
    <div
      className="fixed inset-0 z-40 flex justify-center bg-scrim pt-[18vh]"
      // Clicking the page behind closes the picker, as on every other overlay
      // in the app, so a picker opened by accident is easy to dismiss.
      onClick={onClose}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="New thread in"
        tabIndex={-1}
        onClick={(event) => {
          event.stopPropagation();
        }}
        className="h-fit w-[520px] max-w-[92vw] rounded-card border border-line bg-raised p-1.5 shadow-lift outline-none"
      >
        {/* The hint ends 20px from the card's edge, as in the prototype. */}
        <div className="flex items-baseline gap-2 px-2 pt-1.5 pr-3.5 pb-[5px]">
          <span className="text-label font-emph tracking-[0.1em] text-faint uppercase">
            New thread in
          </span>
          <span className="ml-auto font-mono text-[10.5px] text-faint">
            the project bounds the repos and workspaces on offer
          </span>
        </div>
        {rows.map((row, index) => (
          <PickerRow
            key={row.projectId}
            row={row}
            active={index === active}
            onPick={() => {
              openProject(row.projectId);
            }}
          />
        ))}
        <button
          type="button"
          onClick={onNewProject}
          className={cn(
            // The same grid as a project row, so the label lines up with the
            // project names above it.
            "grid w-full cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2",
            "rounded-[6px] px-2 py-[5px] text-left text-meta text-muted",
            "hover:bg-line-soft hover:text-ink",
            active === rows.length && "bg-line-soft text-ink",
          )}
        >
          {/* An empty marker column, matching a project row's dot, so the
              label lines up with the project names above it. */}
          <span aria-hidden="true" className="w-2.5" />
          <span className="min-w-0 truncate">New project</span>
        </button>
        <div className="mt-1.5 flex gap-3.5 border-t border-line-soft px-2 pt-2 pb-1 text-[11.5px] text-faint">
          <span>
            <Keycap>↑↓</Keycap>Navigate
          </span>
          <span>
            <Keycap>⏎</Keycap>Select
          </span>
          <span>
            <Keycap>Esc</Keycap>Close
          </span>
        </div>
      </div>
    </div>
  );
}

/** One key in the keyboard legend below the rows. */
function Keycap({ children }: { readonly children: string }): JSX.Element {
  return (
    <kbd className="mr-1 rounded-[4px] border border-line px-[5px] font-mono text-[10.5px] text-muted">
      {children}
    </kbd>
  );
}

/** One project row: its name, its keyboard shortcut, and a summary of what it holds. */
function PickerRow({
  row,
  active,
  onPick,
}: {
  readonly row: ProjectPickerRow;
  readonly active: boolean;
  readonly onPick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onPick}
      aria-current={active ? "true" : undefined}
      className={cn(
        "grid w-full cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 rounded-[6px] px-2 py-[5px] text-left text-meta",
        "hover:bg-line-soft hover:text-ink",
        active ? "bg-line-soft text-ink" : "text-muted",
      )}
    >
      <ProjectDot tone={row.tone} />
      <span className="min-w-0 truncate font-emph text-ink">{row.name}</span>
      <span className="shrink-0 font-mono text-[11px] text-faint">{row.shortcut}</span>
      <span className="col-start-2 col-end-4 truncate text-[11px] text-faint">{row.sub}</span>
    </button>
  );
}
