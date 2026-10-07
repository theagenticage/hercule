import type { JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link, useRouteContext } from "@tanstack/react-router";
import { isJoinable, listThreadTabs, toggleSidePane } from "@hercule/client-core";
import {
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
import { MorePill, ThreadTabsPill } from "./header-pills";
import "../session/floating-header.css";
import "./thread-header.css";

/**
 * Renders the header of the page of the thread `sessionId`'s own agent:
 * pills that float over the transcript, with no bar behind them, as the
 * Bureau book's `.top` draws them. A subagent's page draws its own header,
 * `SubagentHeader`, which loads with that page.
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
