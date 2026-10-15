import { lazy, Suspense, type JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link, useRouteContext } from "@tanstack/react-router";
import { isJoinable, listWorkspaceSessionTabs, toggleSidePane } from "@hercule/client-core";
import {
  liveAgentSessionsQuery,
  projectsQuery,
  runnersQuery,
  sessionQuery,
  threadsQuery,
  workspacesQuery,
} from "../../app/queries";
import { EditorIcon } from "../../icons/editor";
import { PlusIcon } from "../../icons/plus";
import { SidebarIcon } from "../../icons/sidebar";
import { useHasSidePane, useSidePaneLayout } from "../subagents/use-side-pane";
import { MorePill, ProjectCrumb, ThreadTabsPill } from "./header-pills";
import "../session/floating-header.css";
import "./thread-header.css";

/**
 * The crumbs of a step session's header, loaded the first time one opens, so
 * the run's code stays out of the thread's chunk.
 */
const RunSessionCrumbs = lazy(() =>
  import("./run-session-crumbs").then((module) => ({ default: module.RunSessionCrumbs })),
);

/**
 * Renders the header of the page of the thread `sessionId`'s own agent:
 * pills that float over the transcript, with no bar behind them, as the
 * Bureau book's `.top` draws them. A subagent's page draws its own header,
 * `SubagentHeader`, which loads with that page.
 *
 * - The first pill holds the place of the session, then one tab per session
 *   of its workspace, in the workspace's order. A thread's place is its
 *   project, its tabs are the threads of its workspace, and a `+` follows
 *   them that opens a new thread in the workspace. A step session's place is
 *   Workflows, its run's workflow and its run, each a link; its tabs also
 *   hold the sessions an Agent spawned, and it has no `+`, because a new
 *   thread would not be a session of the run. A step session's tab reads as
 *   its step's id.
 *   A session alone in its workspace, or in none, has one tab: its own. A
 *   thread in no workspace, or in one that is not ready, has no `+`, because
 *   a new thread could not join it.
 * - The side pane's toggle follows, on the thread's screen only.
 * - Open in editor and More are drawn but do nothing yet, and carry
 *   `aria-disabled` to say so.
 *
 * When the header runs out of room, the other sessions' tabs shrink first,
 * down to about four letters, then the open thread's tab, whose title keeps
 * its tooltip. The pills on the right never move. The lists it reads are in
 * the cache before the thread screen renders, so nothing here waits in
 * practice.
 */
export function ThreadHeader({ sessionId }: { readonly sessionId: string }): JSX.Element {
  const { controller } = useRouteContext({ from: "/_connected" });
  const { client } = controller;
  const session = useSuspenseQuery(sessionQuery(client, sessionId)).data;
  const threads = useSuspenseQuery(threadsQuery(client)).data;
  const agentSessions = useSuspenseQuery(liveAgentSessionsQuery(client)).data;
  const projects = useSuspenseQuery(projectsQuery(client)).data;
  const workspaces = useSuspenseQuery(workspacesQuery(client)).data;
  const runners = useSuspenseQuery(runnersQuery(client)).data;

  const workspace = workspaces.find((each) => each.id === session.workspaceId);

  const isStepSession = session.runId !== null;
  // A thread's tabs are its workspace's threads, as the draft that joins the
  // workspace lists them. A step session's tabs also hold the sessions an
  // Agent spawned, which are the rest of what it works beside.
  const tabs = listWorkspaceSessionTabs(
    session,
    isStepSession ? [...threads, ...agentSessions] : threads,
    workspaces,
  );
  const canStartThread = !isStepSession && workspace !== undefined && isJoinable(workspace);

  return (
    <header className="top">
      <ThreadTabsPill
        label={isStepSession ? "Sessions in this workspace" : "Threads in this workspace"}
        className={isStepSession ? "workflow-crumbs" : undefined}
        crumbs={
          session.runId === null ? (
            <ProjectCrumb projectId={session.projectId} projects={projects} />
          ) : (
            // Nothing is drawn while the crumbs' code loads, which happens once.
            <Suspense fallback={null}>
              <RunSessionCrumbs runId={session.runId} />
            </Suspense>
          )
        }
        tabs={tabs}
        runners={runners}
      >
        {canStartThread ? (
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
        ) : null}
      </ThreadTabsPill>
      <span className="spacer" />
      <SidePaneToggle sessionId={sessionId} />
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
 * Renders the toggle for the side pane of the thread `sessionId`, pressed
 * while the pane is open. The thread's header and a subagent's header both
 * draw it. The icon is the sidebar's, mirrored, because the
 * pane opens on the right.
 *
 * Renders nothing outside the thread's screen, such as in the Office's
 * thread drawer, which has no side pane.
 */
export function SidePaneToggle({ sessionId }: { readonly sessionId: string }): JSX.Element | null {
  const hasSidePane = useHasSidePane();
  const { layout, changeLayout } = useSidePaneLayout(sessionId);
  if (!hasSidePane) return null;
  // One name, with the pressed state telling whether the pane is open. A name
  // that flipped as well would contradict the state: "Hide the side pane,
  // pressed". The tooltip says what a press does.
  return (
    <span className="pill">
      <button
        type="button"
        className={layout.open ? "icon-btn is-on" : "icon-btn"}
        aria-label="Side pane"
        title={layout.open ? "Hide the side pane" : "Show the side pane"}
        aria-pressed={layout.open}
        onClick={() => {
          changeLayout(toggleSidePane);
        }}
      >
        <span className="pane-toggle-icon">
          <SidebarIcon />
        </span>
      </button>
    </span>
  );
}
