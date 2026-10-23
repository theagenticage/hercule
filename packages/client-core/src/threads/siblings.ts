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
 * Returns the sessions shown as tabs in `session`'s header: one per session
 * of `session`'s workspace, in the workspace's session order, taken from
 * `sessions`. Returns `session` alone when it has no workspace, or when its
 * workspace is not in `workspaces`.
 *
 * `sessions` should hold every kind of session that may share a workspace:
 * the threads and the sessions an Agent spawned, such as a run's step
 * sessions. A session the workspace lists but `sessions` does not hold is
 * left out.
 *
 * `session` always has a tab, and the tab shows `session` rather than its
 * entry in `sessions`, which may be an older read. A session that has exited
 * no longer works in its workspace, so the workspace does not list it; its
 * tab is then the last.
 */
export const listWorkspaceSessionTabs = (
  session: Session,
  sessions: readonly Session[],
  workspaces: readonly Workspace[],
): readonly Session[] => {
  const workspace = workspaces.find((each) => each.id === session.workspaceId);
  if (workspace === undefined) return [session];
  const tabs = listWorkspaceThreads(workspace, [
    session,
    ...sessions.filter((each) => each.id !== session.id),
  ]);
  return workspace.sessionIds.includes(session.id) ? tabs : [...tabs, session];
};

/**
 * Returns each session's label among the sessions shown together, one
 * workspace's: a map from session id to label.
 *
 * - A run's step session is labelled with its step id, because its title
 *   starts with the workflow's name, which the header's crumb already shows.
 * - Any other session is labelled with its role, when it has one. Sessions
 *   that share a role, ignoring case, are numbered by `createdAt` (ties by
 *   session id, so the order of `sessions` never changes a label): `review`,
 *   `review 2`, `review 3`. Each keeps its own spelling.
 * - A session with no role is labelled with its full title, which the screen
 *   cuts short. Titles are not numbered.
 *
 * The header's tabs and the sidebar's rows both call this, so they name a
 * session the same way, as long as they pass the same Threads and Agent
 * sessions. A run's step session and an assistant's session have no role, so
 * they never change another session's number.
 *
 * - The header passes every session of the workspace that it holds
 *   (`listSessionsOfWorkspace`), exited Agent sessions included.
 * - The sidebar passes the sessions of a group (`SessionGroup.sessions`):
 *   the workspace's Threads and Agent sessions that it holds.
 *
 * Both read the sidebar's sessions, so both lack the same Threads, those
 * marked Done long ago, and they number alike.
 *
 * A list that lacks one of those sessions can number differently.
 */
export const labelWorkspaceSessions = (
  sessions: readonly Session[],
): ReadonlyMap<string, string> => {
  const labels = new Map<string, string>();
  const rolesSeen = new Map<string, number>();
  const oldestFirst = sessions.toSorted(
    (a, b) =>
      Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  for (const session of oldestFirst) {
    const role = session.role?.trim() ?? "";
    if (session.kind === "run" && session.stepId !== null) {
      labels.set(session.id, session.stepId);
    } else if (role === "") {
      labels.set(session.id, session.title);
    } else {
      const roleKey = role.toLowerCase();
      const number = (rolesSeen.get(roleKey) ?? 0) + 1;
      rolesSeen.set(roleKey, number);
      labels.set(session.id, number === 1 ? role : `${role} ${number}`);
    }
  }
  return labels;
};

/**
 * Returns the sessions of `sessions` that work in the workspace
 * `workspaceId`, each id once and in the order `sessions` first holds it.
 * `sessions` is the sessions of several reads put together, so a session that
 * two of them hold is returned once.
 *
 * Unlike a workspace's `sessionIds`, this keeps the sessions that have exited
 * and the Agent sessions, which is what `labelWorkspaceSessions` needs to
 * number a role the same way everywhere.
 */
export const listSessionsOfWorkspace = (
  workspaceId: string,
  sessions: readonly Session[],
): readonly Session[] => {
  const byId = new Map<string, Session>();
  for (const session of sessions) {
    if (session.workspaceId === workspaceId && !byId.has(session.id)) byId.set(session.id, session);
  }
  return [...byId.values()];
};

/**
 * Returns the threads of `workspace`, in the workspace's thread order, taken
 * from `threads`. Returns an empty list when `workspace` is undefined. A
 * thread the workspace lists but `threads` does not hold is left out.
 */
export const listWorkspaceThreads = (
  workspace: Workspace | undefined,
  threads: readonly Session[],
): readonly Session[] =>
  workspace === undefined
    ? []
    : workspace.sessionIds.flatMap((id) => threads.filter((each) => each.id === id));
