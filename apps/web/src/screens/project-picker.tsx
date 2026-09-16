import { useEffect, useRef, useState, type JSX } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  projectPickerRows,
  queryKeys,
  type HydraClient,
  type ProjectPickerRow,
} from "@hydra/client-core";
import { Input, cn } from "@hydra/ui";
import { messageOf } from "./save-status";
import { ProjectDot } from "./project-dot";
import { projectsQuery, resourcesQuery, sessionsQuery, workspacesQuery } from "../app/queries";

/**
 * The project picker (spec 14 §The composer): "Creating a thread is one step,
 * after the project." It stands over a scrim rather than on a screen of its
 * own, because choosing a project is not a place the user goes - it is the one
 * question asked before the draft opens.
 *
 * A fresh install has no project, so the picker is the naming field alone:
 * there is nothing to choose between and one thing to do.
 */
export function ProjectPicker({
  client,
  onClose,
}: {
  readonly client: HydraClient;
  readonly onClose: () => void;
}): JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const projects = useQuery(projectsQuery(client)).data?.items ?? [];
  const resources = useQuery(resourcesQuery(client)).data?.items ?? [];
  const workspaces = useQuery(workspacesQuery(client)).data?.items ?? [];
  const sessions = useQuery(sessionsQuery(client)).data?.items ?? [];
  const rows = projectPickerRows({ projects, resources, workspaces, sessions });

  const open = (projectId: string): void => {
    onClose();
    void navigate({ to: "/threads/new", search: { project: projectId } });
  };

  // Derived, not latched: the listing may land after the first render, and a
  // picker that decided "there are no projects" before the answer arrived
  // would keep saying so with the projects on screen behind it.
  const [asked, setAsked] = useState(false);
  const naming = asked || rows.length === 0;
  const [name, setName] = useState("");
  const [active, setActive] = useState(0);
  const panel = useRef<HTMLDivElement>(null);

  const create = useMutation({
    mutationFn: (value: string) => client.project.create({ payload: { name: value } }),
    onSuccess: (project) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects() });
      open(project.id);
    },
  });

  useEffect(() => {
    panel.current?.focus();
  }, []);

  // ↑↓ ⏎ Esc and ⌘<n>, heard on the document rather than on the panel: the
  // picker is the only thing that answers keys while it stands, and a click on
  // the scrim or on a row would otherwise take the focus the panel was
  // listening with. While the name is being typed only Esc acts, so the field
  // keeps every key the user means for it.
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (naming) return;
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
        if (row === undefined) setAsked(true);
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
      className="fixed inset-0 z-40 flex justify-center bg-ink/20 pt-[18vh]"
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
        <div className="px-2 pt-1.5 pb-[5px] text-label font-emph tracking-[0.1em] text-faint uppercase">
          New thread in
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
        {naming ? (
          <div className="flex flex-col gap-1.5 border-t border-line-soft px-2 pt-2 pb-1.5 first:border-t-0">
            <label htmlFor="new-project" className="text-meta text-muted">
              New project
            </label>
            <Input
              id="new-project"
              autoFocus
              value={name}
              placeholder="What it is called"
              onChange={(event) => {
                setName(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || name.trim() === "") return;
                event.preventDefault();
                create.mutate(name.trim());
              }}
            />
            {create.error === null ? null : (
              <p className="text-fine text-fail" role="alert">
                {messageOf(create.error)}
              </p>
            )}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => {
              setAsked(true);
            }}
            className={cn(
              "flex w-full cursor-pointer items-center gap-2 rounded-[6px] px-2 py-[5px] text-left text-meta text-muted",
              "hover:bg-line-soft hover:text-ink",
              active === rows.length && "bg-line-soft text-ink",
            )}
          >
            New project
          </button>
        )}
      </div>
    </div>
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
      <ProjectDot projectId={row.projectId} />
      <span className="min-w-0 truncate font-emph text-ink">{row.name}</span>
      <span className="shrink-0 font-mono text-[11px] text-faint">{row.shortcut}</span>
      <span className="col-start-2 col-end-4 truncate text-[11px] text-faint">{row.sub}</span>
    </button>
  );
}
