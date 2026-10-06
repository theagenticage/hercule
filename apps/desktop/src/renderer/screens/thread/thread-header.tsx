import { useId, type JSX, type ReactNode } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link, notFound, useRouteContext } from "@tanstack/react-router";
import {
  decideSubagentPose,
  decideThreadPose,
  decideThreadRowEnd,
  describePose,
  isJoinable,
  isSubagentWaiting,
  listSubagentAncestors,
  listThreadTabs,
  nameSubagent,
  togglePane,
} from "@hercule/client-core";
import type { Project, Runner, Session } from "@hercule/contract";
import {
  projectsQuery,
  runnersQuery,
  sessionQuery,
  subagentsQuery,
  threadsQuery,
  workspacesQuery,
} from "../../app/queries";
import { EditorIcon } from "../../icons/editor";
import { MoreIcon } from "../../icons/more";
import { PlusIcon } from "../../icons/plus";
import { SidebarIcon } from "../../icons/sidebar";
import { Mark } from "../../marks";
import { AgeLabel } from "../age-label";
import { pickProjectTint, ProjectTile } from "../project-tile";
import { buildSubagentLook } from "../subagents/subagent-face";
import { useHasSidePane, useSidePaneLayout } from "../subagents/use-side-pane";
import "./thread-header.css";

/**
 * The classes a tab adds while its thread is open. The router also sets
 * `aria-current="page"` on it then.
 */
const SELECTED_TAB_PROPS = { className: "is-on" } as const;

/** Marks a link as the current page only on its own path, not on a path below it. */
const EXACT_PATH = { exact: true } as const;

/**
 * Renders the header of one agent's page on the thread `sessionId`: the
 * session's own agent's page when `subagentId` is undefined, else that
 * subagent's. See `SessionAgentHeader` and `SubagentHeader`.
 */
export function ThreadHeader({
  sessionId,
  subagentId,
}: {
  readonly sessionId: string;
  /** The subagent whose page this is; undefined on the session's own agent's page. */
  readonly subagentId?: string | undefined;
}): JSX.Element {
  return subagentId === undefined ? (
    <SessionAgentHeader sessionId={sessionId} />
  ) : (
    <SubagentHeader sessionId={sessionId} subagentId={subagentId} />
  );
}

/**
 * Renders the header of the session's own agent's page: pills that float
 * over the transcript, with no bar behind them, as the Bureau book's `.top`
 * draws them.
 *
 * - The first pill holds the thread's project, one tab per thread of the
 *   thread's workspace, in the workspace's order, and a `+` that opens a new
 *   thread in the workspace. A thread alone in its workspace, or in none, has
 *   one tab: its own. A thread in no workspace, or in one that is not ready,
 *   has no `+`, because a new thread could not join it.
 * - The side pane's toggle follows, on the thread's screen only.
 * - Open in editor and More are drawn but do nothing yet, and carry
 *   `aria-disabled` to say so.
 *
 * When the header runs out of room, the other threads' tabs shrink first,
 * down to about four letters, then the open thread's tab, whose title keeps
 * its tooltip. The pills on the right never move. The lists it reads are in
 * the cache before the thread screen renders, so nothing here waits in
 * practice.
 */
function SessionAgentHeader({ sessionId }: { readonly sessionId: string }): JSX.Element {
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
      <PaneToggle sessionId={sessionId} />
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
 * Renders the header of the page of the subagent `subagentId`: a crumb from
 * the thread down through the subagent's ancestors to the subagent, then the
 * side pane's toggle.
 *
 * - The thread and each ancestor are links to their pages.
 * - The subagent comes last, with its mark, its name and a "subagent" tag,
 *   tinted in its hue so the page cannot pass for a thread.
 *
 * When the header runs out of room, the thread and the ancestors shrink
 * first, down to about four letters each, then the subagent's name. The
 * thread's crumb is never wider than 260px and the subagent's than 340px.
 *
 * Fails with `notFound` when the session has no subagent `subagentId`.
 */
function SubagentHeader({
  sessionId,
  subagentId,
}: {
  readonly sessionId: string;
  readonly subagentId: string;
}): JSX.Element {
  const { controller } = useRouteContext({ from: "/_connected" });
  const { client } = controller;
  const session = useSuspenseQuery(sessionQuery(client, sessionId)).data;
  const subagents = useSuspenseQuery(subagentsQuery(client, sessionId)).data;
  const subagent = subagents.find((each) => each.id === subagentId);
  // The subagent's page has already checked that the subagent exists, so
  // this only guards the type. The router acts on a thrown `notFound`, which
  // is a plain descriptor rather than an Error.
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  if (subagent === undefined) throw notFound();
  const pose = decideSubagentPose(
    subagent.status,
    isSubagentWaiting(subagent, session.openRequests),
  );
  const name = nameSubagent(subagent);

  return (
    <header className="top">
      <nav className="pill subagent-crumbs" aria-label="Subagent of">
        {/* Exact, so the router does not mark the thread's page as the
            current one: the subagent's page sits under its path. */}
        <Link
          to="/threads/$sessionId"
          params={{ sessionId }}
          activeOptions={EXACT_PATH}
          className="ptab"
        >
          <span className="ptab-title" title={session.title}>
            {session.title}
          </span>
        </Link>
        {listSubagentAncestors(subagent, subagents).map((ancestor) => (
          <span key={ancestor.id} className="subagent-crumb">
            <span className="subagent-crumb-sep" aria-hidden="true">
              ›
            </span>
            <Link
              to="/threads/$sessionId/subagents/$subagentId"
              params={{ sessionId, subagentId: ancestor.id }}
              className="ptab"
            >
              <span className="ptab-title" title={nameSubagent(ancestor)}>
                {nameSubagent(ancestor)}
              </span>
            </Link>
          </span>
        ))}
        <span className="subagent-crumb">
          <span className="subagent-crumb-sep" aria-hidden="true">
            ›
          </span>
          <span
            className="ptab is-on subagent-crumb-here"
            aria-current="page"
            style={{ "--hue": `var(--hue-${buildSubagentLook(subagent).hue})` }}
          >
            {pose === "asleep" || pose === "away" ? null : <Mark state={pose} />}
            <span className="ptab-title" title={name}>
              {name}
            </span>
            <small className="subagent-tag">subagent</small>
          </span>
        </span>
      </nav>
      <span className="spacer" />
      <PaneToggle sessionId={sessionId} />
    </header>
  );
}

/**
 * Renders the toggle for the side pane of the thread `sessionId`, pressed
 * while the pane is open. The icon is the sidebar's, mirrored, because the
 * pane opens on the right.
 *
 * Renders nothing outside the thread's screen, such as in the Office's
 * thread drawer, which has no side pane.
 */
function PaneToggle({ sessionId }: { readonly sessionId: string }): JSX.Element | null {
  const hasSidePane = useHasSidePane();
  const { layout, changeLayout } = useSidePaneLayout(sessionId);
  if (!hasSidePane) return null;
  const label = layout.open ? "Hide the side pane" : "Show the side pane";
  return (
    <span className="pill">
      <button
        type="button"
        className={layout.open ? "icon-btn is-on" : "icon-btn"}
        aria-label={label}
        title={label}
        aria-pressed={layout.open}
        onClick={() => {
          changeLayout(togglePane);
        }}
      >
        <span className="pane-toggle-icon">
          <SidebarIcon />
        </span>
      </button>
    </span>
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
