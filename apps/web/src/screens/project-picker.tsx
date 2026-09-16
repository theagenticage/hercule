import { useEffect, useRef, useState, type JSX } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { projectPickerRows, type HydraClient, type ProjectPickerRow } from "@hydra/client-core";
import { cn } from "@hydra/ui";
import { ProjectDot } from "./project-dot";
import { projectsQuery, resourcesQuery, sessionsQuery, workspacesQuery } from "../app/queries";

/**
 * The project picker (spec 14 §The composer): "Creating a thread is one step,
 * after the project." It stands over a scrim rather than on a screen of its
 * own, because choosing a project is not a place the user goes - it is the one
 * question asked before the draft opens.
 *
 * A fresh install has no project, so the picker is the New project row alone:
 * there is nothing to choose between and one thing to do. Making one is the
 * New project dialog's job (D-20b), not a field in here.
 */
export function ProjectPicker({
  client,
  onClose,
  onNewProject,
}: {
  readonly client: HydraClient;
  readonly onClose: () => void;
  /** The way to the New project dialog, which this row opens. */
  readonly onNewProject: () => void;
}): JSX.Element {
  const navigate = useNavigate();
  const projects = useQuery(projectsQuery(client)).data?.items ?? [];
  const resources = useQuery(resourcesQuery(client)).data?.items ?? [];
  const workspaces = useQuery(workspacesQuery(client)).data?.items ?? [];
  const sessions = useQuery(sessionsQuery(client)).data?.items ?? [];
  const rows = projectPickerRows({ projects, resources, workspaces, sessions });

  const open = (projectId: string): void => {
    onClose();
    void navigate({ to: "/threads/new", search: { project: projectId } });
  };

  const [active, setActive] = useState(0);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    panel.current?.focus();
  }, []);

  // ↑↓ ⏎ Esc and ⌘<n>, heard on the document rather than on the panel: the
  // picker is the only thing that answers keys while it stands, and a click on
  // the scrim or on a row would otherwise take the focus the panel was
  // listening with.
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
          open(row.projectId);
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
        else open(row.projectId);
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
      // The page behind it is the way out, as it is on every other overlay
      // here: a picker opened by accident closes by clicking past it.
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
        {/* The hint ends 20px from the card's own edge, as the prototype's does. */}
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
              open(row.projectId);
            }}
          />
        ))}
        <button
          type="button"
          onClick={onNewProject}
          className={cn(
            // The same grid a project row stands on, so its label keeps the
            // left edge the names above it have.
            "grid w-full cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2",
            "rounded-[6px] px-2 py-[5px] text-left text-meta text-muted",
            "hover:bg-line-soft hover:text-ink",
            active === rows.length && "bg-line-soft text-ink",
          )}
        >
          {/* The marker column a project row carries, empty: the label keeps
              the left edge the names above it stand on. */}
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

/** One key of the legend under the rows. */
function Keycap({ children }: { readonly children: string }): JSX.Element {
  return (
    <kbd className="mr-1 rounded-[4px] border border-line px-[5px] font-mono text-[10.5px] text-muted">
      {children}
    </kbd>
  );
}

/** One project on offer: what it is, and how much stands under it. */
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
