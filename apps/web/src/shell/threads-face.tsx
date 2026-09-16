import { useState, type JSX } from "react";
import { Link, useMatch, useRouteContext } from "@tanstack/react-router";
import { useQuery, type QueryClient } from "@tanstack/react-query";
import {
  ageOf,
  draftPlace,
  labelText,
  threadGroups,
  type DraftPlace,
  type HydraClient,
  type Live,
  type ProjectGroup,
  type WorkspaceGroup,
} from "@hydra/client-core";
import type { ThreadRows, ThreadWorkspace } from "@hydra/contract";
import { cn, useMinuteClock } from "@hydra/ui";
import { useLiveInvalidation } from "../app/live-invalidation";
import {
  localRunnerQuery,
  projectsQuery,
  providersQuery,
  resourcesQuery,
  runnersQuery,
  sessionsQuery,
  workspacesQuery,
} from "../app/queries";
import { ProjectDot } from "../screens/project-dot";
import { ProjectPicker } from "../screens/project-picker";
import { ThreadRowView } from "../screens/thread-row";

/**
 * The threads face: the threads grouped per project and, inside a project, per
 * workspace (spec 14 §App shell, amended by #160 and by #72). The grouping
 * itself is `threadGroups`'; what is left here is the drawing of it.
 *
 * The row density is the seam the thread list is built on: what a row shows is
 * the `ui.threadRows` setting's to say, and the list reads it from here.
 */
export function ThreadsFace({
  rows,
  preferredWorkspace,
  client,
  queryClient,
  live,
}: {
  readonly rows: ThreadRows;
  /** What a draft opens in where its address names no workspace. */
  readonly preferredWorkspace: ThreadWorkspace | null;
  readonly client: HydraClient;
  readonly queryClient: QueryClient;
  readonly live: Live;
}): JSX.Element {
  useLiveInvalidation(live, queryClient, "session");
  // Ages are read against the clock, not against whenever the last
  // invalidation happened, so "2m" becomes "3m" on its own.
  const now = useMinuteClock();
  const sessions = useQuery(sessionsQuery(client)).data?.items ?? [];
  const projects = useQuery(projectsQuery(client)).data?.items ?? [];
  const resources = useQuery(resourcesQuery(client)).data?.items ?? [];
  const workspaces = useQuery(workspacesQuery(client)).data?.items ?? [];
  const runners = useQuery(runnersQuery(client)).data?.items ?? [];
  // What a meta row names its model from: the catalogs, so a row reads
  // `Claude Sonnet 5` rather than the slug a request is written with.
  const instances = useQuery(providersQuery(client)).data ?? [];
  // Which machine is this browser's: what decides whether the project's shared
  // checkout already stands where the draft would run.
  const { detectLocalRunner } = useRouteContext({ from: "/_shell" });
  const localRunnerId = useQuery(localRunnerQuery(detectLocalRunner, runners)).data ?? null;
  const [picking, setPicking] = useState(false);

  // The router's own answers for which thread is open and which draft is being
  // written, so neither can drift from the route file the way a path pattern
  // written out here would.
  const currentId =
    useMatch({ from: "/_shell/threads/$sessionId", shouldThrow: false })?.params.sessionId ?? null;
  const drafted = useMatch({ from: "/_shell/threads/new", shouldThrow: false });
  const draft: DraftPlace | null =
    drafted === undefined
      ? null
      : draftPlace({
          projectId: drafted.search.project ?? null,
          workspaceId: drafted.search.workspace ?? null,
          resources,
          workspaces,
          runnerId: localRunnerId,
          preferred: preferredWorkspace,
        });
  const groups = threadGroups({
    sessions,
    projects,
    workspaces,
    resources,
    runners,
    instances,
    mode: rows,
    draft,
  });

  return (
    <nav aria-label="Threads" className="flex min-h-0 flex-col">
      <button
        type="button"
        onClick={() => {
          setPicking(true);
        }}
        className="mb-2.5 flex w-full cursor-pointer items-center gap-2 rounded-control border border-line bg-raised px-2.5 py-1.5 text-left text-row font-emph text-ink shadow-card hover:bg-line-soft"
      >
        <span className="font-mono text-row text-faint">+</span>
        Create new thread
      </button>
      {picking ? (
        <ProjectPicker
          client={client}
          onClose={() => {
            setPicking(false);
          }}
        />
      ) : null}
      <div data-thread-rows={rows} className="min-h-0 flex-1 overflow-auto">
        {groups.length === 0 ? (
          <>
            <p className="px-2.5 py-1 text-fine text-faint">No threads yet</p>
            <p className="px-2.5 pt-1 text-fine text-faint">
              A thread needs a runner with a provider login on it.
            </p>
          </>
        ) : (
          groups.map((group) => (
            <ProjectLane
              key={group.projectId ?? "none"}
              group={group}
              now={now}
              current={currentId}
            />
          ))
        )}
      </div>
      <Link
        to="/sessions"
        className="mt-1.5 rounded-control px-2.5 py-1 text-fine text-muted hover:bg-line-soft hover:text-ink"
      >
        All sessions →
      </Link>
    </nav>
  );
}

/** One project's header, then its workspaces. Threads in no project head nothing. */
function ProjectLane({
  group,
  now,
  current,
}: {
  readonly group: ProjectGroup;
  readonly now: Date;
  readonly current: string | null;
}): JSX.Element {
  return (
    <div>
      {group.projectId === null || group.name === null ? null : (
        <div className="flex items-center gap-1.5 pt-2.5 pr-1 pb-0.5 pl-2">
          <ProjectDot projectId={group.projectId} />
          <span className="min-w-0 truncate text-meta font-emph text-ink">{group.name}</span>{" "}
          <span className="font-mono text-[11px] text-faint">{group.count}</span>
          <Plus
            name={`New thread in ${group.name}`}
            search={{ project: group.projectId }}
            className="ml-auto"
          />
        </div>
      )}
      {group.workspaces.map((lane) => (
        <WorkspaceLane
          key={lane.workspaceId ?? "none"}
          lane={lane}
          projectId={group.projectId}
          now={now}
          current={current}
        />
      ))}
    </div>
  );
}

/** One workspace's faint mono label, the draft that joins it, then its threads. */
function WorkspaceLane({
  lane,
  projectId,
  now,
  current,
}: {
  readonly lane: WorkspaceGroup;
  readonly projectId: string | null;
  readonly now: Date;
  readonly current: string | null;
}): JSX.Element {
  return (
    <div className="group/lane">
      {projectId === null || lane.label === null ? null : (
        <div className="flex items-center gap-1.5 pt-1.5 pr-1 pb-px pl-2">
          {/* The repo is what gives when the sidebar is narrow; ` checkout ·
              <machine>` stands whole, because the machine is what tells one
              repo's two checkouts apart. The whole label is the title. A label
              that is one word is one element: two would be the same text
              twice, to a reader and to anything looking for it. */}
          {lane.label.keep === "" ? (
            <span
              title={lane.label.clip}
              className="min-w-0 truncate font-mono text-[11px] text-faint"
            >
              {lane.label.clip}
            </span>
          ) : (
            <span
              title={labelText(lane.label)}
              className="flex min-w-0 font-mono text-[11px] text-faint"
            >
              <span className="truncate">{lane.label.clip}</span>
              <span className="shrink-0 whitespace-pre">{lane.label.keep}</span>
            </span>
          )}
          {lane.workspaceId === null ? null : (
            <Plus
              name={`New thread in ${labelText(lane.label)}`}
              search={{ project: projectId, workspace: lane.workspaceId }}
              className="ml-auto opacity-0 group-hover/lane:opacity-100 focus-visible:opacity-100"
            />
          )}
        </div>
      )}
      {lane.rows.map((row) => (
        <ThreadRowView
          key={row.id}
          mark={row.mark}
          title={row.title}
          age={ageOf(row.activityAt, now)}
          secondLine={row.secondLine}
          sessionId={row.id}
          selected={row.id === current}
        />
      ))}
      {/* The draft is the lane's last row, as it is the last tab of the thread
          chrome (spec 14 §The thread surface). */}
      {lane.draft ? (
        <div className="flex items-center gap-2 rounded-control px-2.5 py-[7px] text-row text-muted">
          {/* The same marker column a thread row carries, so the draft's title
              stands on the same left edge as the titles under it. */}
          <span aria-hidden="true" className="flex w-3 shrink-0 justify-center">
            <span className="text-faint">·</span>
          </span>
          <span className="min-w-0 flex-1 truncate">New thread</span>{" "}
          <span className="shrink-0 font-mono text-fine text-faint">draft</span>
        </div>
      ) : null}
    </div>
  );
}

/** The `+` that opens a draft already standing where it was pressed. */
function Plus({
  name,
  search,
  className,
}: {
  readonly name: string;
  readonly search: { readonly project: string; readonly workspace?: string };
  readonly className?: string;
}): JSX.Element {
  return (
    <Link
      to="/threads/new"
      search={search}
      aria-label={name}
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded-[4px] font-mono text-[11px] text-faint",
        "hover:bg-line-soft hover:text-ink",
        className,
      )}
    >
      +
    </Link>
  );
}
