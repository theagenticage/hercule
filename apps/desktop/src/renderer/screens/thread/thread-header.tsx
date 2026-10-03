import { useId, type JSX, type ReactNode } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link, useRouteContext } from "@tanstack/react-router";
import {
  decideThreadPose,
  decideThreadRowEnd,
  describePose,
  isJoinable,
  listThreadTabs,
} from "@hercule/client-core";
import type { Project, Runner, Session } from "@hercule/contract";
import {
  projectsQuery,
  runnersQuery,
  sessionQuery,
  threadsQuery,
  workspacesQuery,
} from "../../app/queries";
import { EditorIcon } from "../../icons/editor";
import { MoreIcon } from "../../icons/more";
import { PlusIcon } from "../../icons/plus";
import { Mark } from "../../marks";
import { AgeLabel } from "../age-label";
import { pickProjectTint, ProjectTile } from "../project-tile";
import "./thread-header.css";

/**
 * The classes a tab adds while its thread is open. The router also sets
 * `aria-current="page"` on it then.
 */
const SELECTED_TAB_PROPS = { className: "is-on" } as const;

/**
 * Renders the thread header: pills that float over the transcript, with no
 * bar behind them, as the Bureau book's `.top` draws them.
 *
 * - The first pill holds the thread's project, one tab per thread of the
 *   thread's workspace, in the workspace's order, and a `+` that opens a new
 *   thread in the workspace. A thread alone in its workspace, or in none, has
 *   one tab: its own. A thread in no workspace, or in one that is not ready,
 *   has no `+`, because a new thread could not join it.
 * - Open in editor and More are drawn but do nothing yet, and carry
 *   `aria-disabled` to say so.
 *
 * A long title ellipsizes, and the tabs shrink before the pills on the right
 * move. The lists it reads are in the cache before the thread screen renders,
 * so nothing here waits in practice.
 */
export function ThreadHeader({ sessionId }: { readonly sessionId: string }): JSX.Element {
  const { controller } = useRouteContext({ from: "/_connected" });
  const { client } = controller;
  const session = useSuspenseQuery(sessionQuery(client, sessionId)).data;
  const threads = useSuspenseQuery(threadsQuery(client)).data;
  const projects = useSuspenseQuery(projectsQuery(client)).data;
  const workspaces = useSuspenseQuery(workspacesQuery(client)).data;
  const runners = useSuspenseQuery(runnersQuery(client)).data;

  const workspace = workspaces.find((each) => each.id === session.workspaceId);

  return (
    <header className="top">
      <ThreadTabsPill
        projectId={session.projectId}
        projects={projects}
        tabs={listThreadTabs(session, threads, workspaces)}
        runners={runners}
      >
        {workspace === undefined || !isJoinable(workspace) ? null : (
          <Link
            to="/"
            search={
              session.projectId === null
                ? { workspace: workspace.id }
                : { project: session.projectId, workspace: workspace.id }
            }
            className="icon-btn"
            title="New thread in this workspace"
          >
            <PlusIcon />
          </Link>
        )}
      </ThreadTabsPill>
      <span className="spacer" />
      <span className="pill">
        <button type="button" className="icon-btn" title="Open in editor" aria-disabled="true">
          <EditorIcon />
        </button>
      </span>
      <MorePill />
    </header>
  );
}

/**
 * Renders a header's More pill. More is drawn but does nothing yet, and
 * carries `aria-disabled` to say so.
 */
export function MorePill(): JSX.Element {
  return (
    <span className="pill">
      <button type="button" className="icon-btn" title="More" aria-disabled="true">
        <MoreIcon />
      </button>
    </span>
  );
}

/**
 * Renders a header's first pill: the project `projectId`, then one tab per
 * thread in `tabs`, then `children`.
 *
 * - `projectId` is `null` for a thread in no project, which the pill calls
 *   "No project".
 * - The project's tint follows its place in `projects`, as everywhere else.
 * - Each tab's pose is drawn with the runner it names in `runners`.
 */
export function ThreadTabsPill({
  projectId,
  projects,
  tabs,
  runners,
  children,
}: {
  readonly projectId: string | null;
  readonly projects: readonly Project[];
  readonly tabs: readonly Session[];
  readonly runners: readonly Runner[];
  readonly children: ReactNode;
}): JSX.Element {
  const project = projects.find((each) => each.id === projectId);
  const runnersById = new Map(runners.map((runner) => [runner.id, runner]));
  return (
    <nav className="pill" aria-label="Threads in this workspace">
      <span className="pill-crumb">
        <ProjectTile
          tint={project === undefined ? null : pickProjectTint(project.id, projects)}
          name={project?.name ?? "No project"}
        />
      </span>
      {tabs.map((tab) => (
        <ThreadTab
          key={tab.id}
          session={tab}
          runner={tab.runnerId === null ? undefined : runnersById.get(tab.runnerId)}
        />
      ))}
      {children}
    </nav>
  );
}

/**
 * Renders one thread of the workspace as a tab: the mark of its pose, when
 * the pose has one, its title, and, when its sidebar row would not end in a
 * mark, the word or the age that row ends in.
 *
 * The tab is named "<title>, <pose words>", as the thread's sidebar row is,
 * and described by the word or the age in words, such as "20 minutes ago".
 * The mark says the pose, which the name already holds, so it is hidden.
 */
function ThreadTab({
  session,
  runner,
}: {
  readonly session: Session;
  readonly runner: Runner | undefined;
}): JSX.Element {
  const endId = useId();
  const pose = decideThreadPose(session, runner);
  const end = decideThreadRowEnd(session, runner);
  return (
    <Link
      to="/threads/$sessionId"
      params={{ sessionId: session.id }}
      className="ptab"
      activeProps={SELECTED_TAB_PROPS}
      aria-label={`${session.title}, ${describePose(pose)}`}
      aria-describedby={end.kind === "mark" ? undefined : endId}
    >
      {pose === "asleep" || pose === "away" ? null : <Mark state={pose} />}
      <span className="ptab-title" title={session.title}>
        {session.title}
      </span>
      {end.kind === "mark" ? null : end.kind === "word" ? (
        <small id={endId}>{end.word}</small>
      ) : (
        <AgeLabel at={end.at} onScreen descriptionId={endId} as="small" />
      )}
    </Link>
  );
}
