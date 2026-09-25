import { useState, type JSX } from "react";
import { Link, useMatch, useRouteContext } from "@tanstack/react-router";
import { useQuery, type QueryClient } from "@tanstack/react-query";
import {
  formatAge,
  decideDraftPlace,
  joinLabelText,
  buildThreadGroups,
  decideAssistantPresence,
  findAnsweredAssistantId,
  type DraftPlace,
  type HerculeClient,
  type Live,
  type ProjectGroup,
  type WorkspaceGroup,
} from "@hercule/client-core";
import type { ThreadRows, ThreadWorkspace } from "@hercule/contract";
import { cn, useMinuteClock } from "@hercule/ui";
import { useLiveInvalidation } from "../app/live-invalidation";
import {
  assistantsQuery,
  localRunnerQuery,
  projectsQuery,
  providersQuery,
  resourcesQuery,
  runnersQuery,
  sessionsQuery,
  workspacesQuery,
} from "../app/queries";
import { AssistantRow } from "../screens/assistant/assistant-row";
import { ProjectDot } from "../screens/project-dot";
import { NewProject } from "../screens/new-project";
import { ProjectPicker } from "../screens/project-picker";
import { ThreadRowView } from "../screens/thread-row";

/**
 * The threads face of the sidebar: the threads grouped by project and, inside
 * a project, by workspace (spec 14 §App shell, amended by #160 and #72).
 * `buildThreadGroups` does the grouping; this component only draws it.
 *
 * The `ui.threadRows` setting (`rows`) decides how much each row shows.
 *
 * The Assistants group follows the thread groups: one row per assistant,
 * oldest first, each linking to its conversation. An assistant's sessions are
 * left out of the thread groups, because its conversation is where the user
 * reaches them.
 */
export function ThreadsFace({
  rows,
  preferredWorkspace,
  client,
  queryClient,
  live,
}: {
  readonly rows: ThreadRows;
  /** The workspace a draft opens in when its URL names no workspace. */
  readonly preferredWorkspace: ThreadWorkspace | null;
  readonly client: HerculeClient;
  readonly queryClient: QueryClient;
  readonly live: Live;
}): JSX.Element {
  useLiveInvalidation(live, queryClient, "session");
  useLiveInvalidation(live, queryClient, "assistant");
  // Ages are computed from a clock that ticks every minute, not from the time
  // of the last refetch, so "2m" becomes "3m" without new data.
  const now = useMinuteClock();
  const sessions = useQuery(sessionsQuery(client)).data?.items ?? [];
  const projects = useQuery(projectsQuery(client)).data?.items ?? [];
  const resources = useQuery(resourcesQuery(client)).data?.items ?? [];
  const workspaces = useQuery(workspacesQuery(client)).data?.items ?? [];
  const runners = useQuery(runnersQuery(client)).data?.items ?? [];
  const assistants = useQuery(assistantsQuery(client)).data?.items ?? [];
  // The provider catalogs let a meta row show the model's display name
  // (`Claude Sonnet 5`) instead of the slug a request uses.
  const instances = useQuery(providersQuery(client)).data ?? [];
  // The runner on this browser's machine. It decides whether the project's
  // main workspace already exists where the draft would run.
  const { detectLocalRunner } = useRouteContext({ from: "/_shell" });
  const localRunnerId = useQuery(localRunnerQuery(detectLocalRunner, runners)).data ?? null;
  // At most one overlay is open: the project picker or the New project dialog.
  // The picker's New project row closes the picker and opens the dialog.
  const [overlay, setOverlay] = useState<"picker" | "new-project" | null>(null);

  // Ask the router which thread is open and which draft is being written, so
  // neither can drift from the route files the way a hand-written path pattern
  // could.
  const currentId =
    useMatch({ from: "/_shell/threads/$sessionId", shouldThrow: false })?.params.sessionId ?? null;
  // An assistant's row is marked on its conversation screen, and on the
  // session view of one of its sessions, where the crumb leads back to it.
  const openSession = sessions.find((session) => session.id === currentId);
  const openAssistantId =
    useMatch({ from: "/_shell/assistants/$assistantId", shouldThrow: false })?.params.assistantId ??
    (openSession === undefined ? null : findAnsweredAssistantId(openSession));
  const drafted = useMatch({ from: "/_shell/threads/new", shouldThrow: false });
  const draft: DraftPlace | null =
    drafted === undefined
      ? null
      : decideDraftPlace({
          projectId: drafted.search.project ?? null,
          workspaceId: drafted.search.workspace ?? null,
          resources,
          workspaces,
          runnerId: localRunnerId,
          preferred: preferredWorkspace,
        });
  const groups = buildThreadGroups({
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
      <div className="mb-2.5 flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => {
            setOverlay("picker");
          }}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-control border border-line bg-raised px-2.5 py-1.5 text-left text-row font-emph text-ink shadow-card hover:bg-line-soft"
        >
          <span className="font-mono text-row text-faint">+</span>
          Create new thread
        </button>
        {/* The New project button. It shows a `+`, like the project and
            workspace headers below, because the marks family has no folder
            glyph and #35 fixed which glyphs it has. */}
        <button
          type="button"
          aria-label="New project"
          title="New project"
          onClick={() => {
            setOverlay("new-project");
          }}
          className="flex size-[30px] shrink-0 cursor-pointer items-center justify-center rounded-control border border-line bg-raised font-mono text-row text-faint shadow-card hover:bg-line-soft hover:text-ink"
        >
          +
        </button>
      </div>
      {overlay === "picker" ? (
        <ProjectPicker
          client={client}
          onClose={() => {
            setOverlay(null);
          }}
          onNewProject={() => {
            setOverlay("new-project");
          }}
        />
      ) : null}
      {overlay === "new-project" ? (
        <NewProject
          client={client}
          onClose={() => {
            setOverlay(null);
          }}
        />
      ) : null}
      <div data-thread-rows={rows} className="min-h-0 flex-1 overflow-auto">
        {groups.length === 0 ? (
          <>
            <p className="px-2.5 py-1 text-fine text-faint">No threads yet</p>
            {/* The bottom padding matches a thread row's, so the Assistants
                header below sits as far from this text as it would from the
                last row of a thread group. */}
            <p className="px-2.5 pt-1 pb-[7px] text-fine text-faint">
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
        {assistants.length === 0 ? null : (
          <div>
            {/* The same box as a project's header, so the group titles form
                one column: the text is indented as far as a project's name,
                which follows the project's colour dot, and the row is as tall
                as a project header with its + button. */}
            <div className="flex h-8 items-center pt-2.5 pr-1 pb-0.5 pl-6 text-meta font-emph text-ink">
              Assistants
            </div>
            {assistants.map((assistant) => (
              <AssistantRow
                key={assistant.id}
                assistantId={assistant.id}
                name={assistant.name}
                presence={decideAssistantPresence(assistant.id, sessions)}
                selected={assistant.id === openAssistantId}
              />
            ))}
          </div>
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

/** One project's header, then its workspaces. Threads with no project get no header. */
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
          <ProjectDot tone={group.tone ?? "hercule"} />
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

/** One workspace's label, then its threads, then the draft being written in it, if any. */
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
          {/* In a narrow sidebar the repo part is truncated and ` · <machine>`
              stays whole, because the machine is what tells two main
              workspaces of one repo apart. The tooltip shows the whole label.
              A label with no machine part is a single element: nested elements
              would repeat the same text, for a reader and for a text search. */}
          {lane.label.keep === "" ? (
            <span
              title={lane.label.clip}
              className="min-w-0 truncate font-mono text-[11px] text-faint"
            >
              {lane.label.clip}
            </span>
          ) : (
            <span
              title={joinLabelText(lane.label)}
              className="flex min-w-0 font-mono text-[11px] text-faint"
            >
              <span className="truncate">{lane.label.clip}</span>
              <span className="shrink-0 whitespace-pre">{lane.label.keep}</span>
            </span>
          )}
          {lane.workspaceId === null ? null : (
            <Plus
              name={`New thread in ${joinLabelText(lane.label)}`}
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
          age={formatAge(row.activityAt, now)}
          secondLine={row.secondLine}
          sessionId={row.id}
          selected={row.id === current}
        />
      ))}
      {/* The draft is the lane's last row, just as it is the last thread tab
          (spec 14 §The thread surface). */}
      {lane.draft ? (
        <div className="flex items-center gap-2 rounded-control px-2.5 py-[7px] text-row text-muted">
          {/* The same marker column a thread row has, so the draft's title
              lines up with the thread titles above it. */}
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

/** A `+` link that opens a new thread draft in the project or workspace it sits beside. */
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
