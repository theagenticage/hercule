import { lazy, Suspense, type JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link, useRouteContext } from "@tanstack/react-router";
import {
  findGroupRow,
  isJoinable,
  listWorkspaceSessionTabs,
  toggleSidePane,
  type GroupRow,
} from "@hercule/client-core";
import type { Session } from "@hercule/contract";
import { useDoneMoves } from "../../app/done-moves";
import {
  liveAgentSessionsQuery,
  projectsQuery,
  providersQuery,
  runnersQuery,
  threadAndAgentSessionsQuery,
  workspacesQuery,
} from "../../app/queries";
import { useSessionPresentation } from "../../app/session-presentation";
import { CheckIcon } from "../../icons/check";
import { PlusIcon } from "../../icons/plus";
import { SidebarIcon } from "../../icons/sidebar";
import { UndoIcon } from "../../icons/undo";
import { useHasSidePane, useSidePaneLayout } from "../subagents/use-side-pane";
import { MorePill, ProjectCrumb, ThreadTabsPill } from "./header-pills";
import { TranscriptSyncMarker } from "./transcript-sync-marker";
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
 * Renders the header of the page of the thread `session`'s own agent:
 * pills that float over the transcript, with no bar behind them, as the
 * Bureau book's `.top` draws them. A subagent's page draws its own header,
 * `SubagentHeader`, which loads with that page.
 *
 * - The first pill (`ThreadTabsPill`) holds the place of the session, the
 *   name of the work, and one tab per line of the work's sidebar row: the
 *   Threads, the Agent sessions (ended ones too) and the Threads marked
 *   Done, in the row's order. A `+` follows them that opens a new thread in
 *   the workspace.
 * - A step session has no row, because a run's sessions stay out of the
 *   sidebar. Its place is Workflows, its run's workflow and its run, each a
 *   link, it has no work name, and its tabs are the sessions of its
 *   workspace, which read as their steps' ids. It has no `+`, because a new
 *   thread would not be a session of the run, and no Done.
 * - A session that has no row and is not a step session, such as an Agent
 *   session in a workspace with no Thread, is named by its own title.
 * - A thread in no workspace, or in one that is not ready, has no `+`,
 *   because a new thread could not join it.
 * - The free space after the pill holds "Syncing…" while the thread, opened
 *   from its saved copy, is brought up to date (`TranscriptSyncMarker`).
 * - The buttons on the right are the side pane's toggle, on the thread's
 *   screen only, Done (or Reopen), and More, which is drawn but does nothing
 *   yet and carries `aria-disabled` to say so.
 *
 * Done marks every Thread of the row that is not done yet, as the sidebar
 * row's Done does. Once every Thread of the row is done, the button is
 * Reopen, which reopens them all. A move shows the shell's toast, with Undo.
 *
 * The lists it reads are shell data, in the cache before any thread renders,
 * so nothing here waits in practice. It takes the session record rather
 * than reading it, so the screen shown while a thread opens can draw it from
 * the sidebar's list before the session's own read has answered.
 */
export function ThreadHeader({ session }: { readonly session: Session }): JSX.Element {
  const { controller } = useRouteContext({ from: "/_connected" });
  const { client } = controller;
  const { groupRows } = useSessionPresentation();
  const threadsAndPartners = useSuspenseQuery(threadAndAgentSessionsQuery(client)).data;
  const agentSessions = useSuspenseQuery(liveAgentSessionsQuery(client)).data;
  const projects = useSuspenseQuery(projectsQuery(client)).data;
  const workspaces = useSuspenseQuery(workspacesQuery(client)).data;
  const runners = useSuspenseQuery(runnersQuery(client)).data;
  const instances = useSuspenseQuery(providersQuery(client)).data;

  const workspace = workspaces.find((each) => each.id === session.workspaceId);
  const isStepSession = session.kind === "run";
  const row = findGroupRow(groupRows, session);
  const tabs =
    row?.members ??
    listWorkspaceSessionTabs(session, [...threadsAndPartners, ...agentSessions], {
      workspaces,
      runners,
      instances,
    });
  const projectId = row?.projectId ?? session.projectId;
  const canStartThread = !isStepSession && workspace !== undefined && isJoinable(workspace);

  return (
    <header className="top">
      <ThreadTabsPill
        label={isStepSession ? "Sessions in this workspace" : "Threads in this workspace"}
        className={isStepSession ? "workflow-crumbs" : undefined}
        crumbs={
          session.runId === null ? (
            <ProjectCrumb projectId={projectId} projects={projects} />
          ) : (
            // Nothing is drawn while the crumbs' code loads, which happens once.
            <Suspense fallback={null}>
              <RunSessionCrumbs runId={session.runId} />
            </Suspense>
          )
        }
        workName={isStepSession ? null : (row?.title ?? session.title)}
        tabs={tabs}
        openId={session.id}
        freeSpace={<TranscriptSyncMarker sessionId={session.id} />}
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
      <SidePaneToggle sessionId={session.id} />
      {row === undefined ? null : <DonePill row={row} />}
      <MorePill />
    </header>
  );
}

/**
 * Renders the pill with the Done button of `row`, the row of the work the
 * header shows. While a Thread of the row is not done, the button reads
 * "Done", is named "Mark done", and marks exactly those Threads
 * (`row.doneIds`). Once every Thread is done, it reads "Reopen" and reopens
 * every Thread of the row (`row.threadIds`), as the Done shelf's Reopen does.
 */
function DonePill({ row }: { readonly row: GroupRow }): JSX.Element {
  const { markDone, reopen } = useDoneMoves();
  const marksDone = row.doneIds.length > 0;
  return (
    <span className="pill">
      <button
        type="button"
        className="pill-btn"
        aria-label={marksDone ? "Mark done" : "Reopen"}
        onClick={() => {
          if (marksDone) markDone(row.doneIds);
          else reopen(row.threadIds);
        }}
      >
        {marksDone ? <CheckIcon size={14} /> : <UndoIcon size={14} />}
        {marksDone ? "Done" : "Reopen"}
      </button>
    </span>
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
