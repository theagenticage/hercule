/**
 * Builds the tab strip above a thread (spec 14 §The thread surface). When the
 * thread's workspace has more than one thread, the thread's title is the
 * active tab and the other threads sit beside it, in the workspace's thread
 * order. A draft that joins the workspace is the last tab.
 *
 * Returns no tabs for a single thread with no draft: the title alone is shown.
 */
import type { Session, Workspace } from "@hercule/contract";
import { decideThreadMark, type ThreadMark } from "./rows";

export interface ThreadTab {
  /** `null` for the draft, which is not a session yet. */
  readonly sessionId: string | null;
  readonly title: string;
  /** `draft` for the draft, which the sidebar marks with a dot; otherwise the thread's mark. */
  readonly mark: ThreadMark | "draft";
  readonly active: boolean;
}

export const buildSiblingTabs = ({
  workspace,
  sessions,
  activeSessionId,
  draft = false,
}: {
  readonly workspace: Workspace | undefined;
  readonly sessions: readonly Session[];
  /** The thread on screen, or `null` while the draft is on screen. */
  readonly activeSessionId: string | null;
  /** Whether the draft being written joins this workspace. */
  readonly draft?: boolean;
}): readonly ThreadTab[] => {
  if (workspace === undefined) return [];
  const tabs: ThreadTab[] = [];
  for (const id of workspace.sessionIds) {
    const session = sessions.find((each) => each.id === id);
    if (session === undefined) continue;
    tabs.push({
      sessionId: session.id,
      title: session.title,
      mark: decideThreadMark(session),
      active: session.id === activeSessionId,
    });
  }
  if (draft) tabs.push({ sessionId: null, title: "New thread", mark: "draft", active: true });
  return tabs.length < 2 ? [] : tabs;
};

/**
 * Returns the threads the desktop's thread header shows as tabs: one per
 * thread of `session`'s workspace, in the workspace's thread order, taken
 * from `threads`. Returns `session` alone when it has no workspace, or when
 * its workspace is not in `workspaces`.
 *
 * `session` always has a tab, and its tab shows `session` rather than its
 * entry in `threads`: `session` is the thread screen's own read, so the tab
 * never disagrees with the rest of the screen. A thread that has exited no
 * longer works in its workspace, so the workspace does not list it; its tab
 * is then the last.
 */
export const listThreadTabs = (
  session: Session,
  threads: readonly Session[],
  workspaces: readonly Workspace[],
): readonly Session[] => {
  const workspace = workspaces.find((each) => each.id === session.workspaceId);
  if (workspace === undefined) return [session];
  const tabs = workspace.sessionIds.flatMap((id) =>
    id === session.id ? [session] : threads.filter((each) => each.id === id),
  );
  return workspace.sessionIds.includes(session.id) ? tabs : [...tabs, session];
};
