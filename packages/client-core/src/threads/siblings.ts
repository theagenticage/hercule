/**
 * Builds the tab strip above a thread (spec 14 §The thread surface). When the
 * thread's workspace has more than one thread, the thread's title is the
 * active tab and the other threads sit beside it, in the workspace's thread
 * order. A draft that joins the workspace is the last tab.
 *
 * Returns no tabs for a single thread with no draft: the title alone is shown.
 */
import type { ProviderInstance, Runner, Session, Workspace } from "@hercule/contract";
import { findModelName } from "./model-name";
import { decideThreadPose, decideThreadRowStatus, type Pose, type ThreadRowStatus } from "./pose";
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
 * One session as the thread header draws it, in a tab or in the overflow
 * menu. The sidebar row's unfolded lines (`GroupMember`) describe a session
 * with the same fields, built by the same function, so the two never
 * disagree.
 */
export interface SessionTab {
  readonly sessionId: string;
  /** What the session is called among the sessions of its workspace, as `labelWorkspaceSessions` returns it. */
  readonly label: string;
  /** The session's full title, for a tooltip. */
  readonly title: string;
  readonly pose: Pose;
  readonly status: ThreadRowStatus;
  /** When the session was last active, which an `age` status counts from. */
  readonly activityAt: string;
  /** Whether the session is a Thread marked Done. */
  readonly done: boolean;
  /** The provider of the session's instance, such as `claude-code`, or `null` when the instance is unknown. */
  readonly providerId: string | null;
  /** The display name of the model the session runs on. */
  readonly model: string;
}

/**
 * Describes `session` with the fields a header tab and a sidebar line share.
 * `pose` is passed in because the sidebar decides every pose once, for all of
 * its readers. `runner` and `instance` are the records of the session's
 * runner and provider instance, or `undefined` when the caller does not hold
 * them.
 */
export const describeSessionTab = ({
  session,
  label,
  pose,
  runner,
  instance,
}: {
  readonly session: Session;
  readonly label: string;
  readonly pose: Pose;
  readonly runner: Runner | undefined;
  readonly instance: ProviderInstance | undefined;
}): SessionTab => ({
  sessionId: session.id,
  label,
  title: session.title,
  pose,
  status: decideThreadRowStatus(session, runner),
  activityAt: session.lastActivityAt,
  done: session.done !== undefined,
  providerId: instance?.providerId ?? null,
  model: findModelName(instance, session.modelSelection.model),
});

/**
 * Returns the tabs of the header of `session`, a session that has no row in
 * the sidebar: a run's step session, or an Agent session whose workspace
 * holds no Thread. (A Thread, and an Agent session that is part of a row,
 * take their tabs from the row's members.)
 *
 * The tabs are the sessions of `session`'s workspace, in the workspace's
 * session order, taken from `sessions`. `session` is the only tab when it
 * has no workspace, or when its workspace is not in `workspaces`.
 *
 * - `sessions` is every Thread and Agent session the caller holds, so it may
 *   hold a session twice, such as one read twice. The first record of an id
 *   wins. A session the workspace lists but `sessions` does not hold is left
 *   out.
 * - `session` always has a tab, and the tab describes `session` rather than
 *   its entry in `sessions`, which may be an older read. A session that has
 *   exited no longer works in its workspace, so the workspace does not list
 *   it; its tab is then the last.
 * - Labels are numbered among every session of the workspace that the caller
 *   holds, the exited ones and those without a tab too, as the sidebar
 *   numbers them (`labelWorkspaceSessions`).
 */
export const listWorkspaceSessionTabs = (
  session: Session,
  sessions: readonly Session[],
  {
    workspaces,
    runners,
    instances,
  }: {
    readonly workspaces: readonly Workspace[];
    readonly runners: readonly Runner[];
    readonly instances: readonly ProviderInstance[];
  },
): readonly SessionTab[] => {
  const workspace = workspaces.find((each) => each.id === session.workspaceId);
  const ofWorkspace =
    session.workspaceId === null
      ? [session]
      : listSessionsOfWorkspace(session.workspaceId, [session, ...sessions]);
  const labels = labelWorkspaceSessions(ofWorkspace);
  const shown = workspace === undefined ? [session] : listWorkspaceThreads(workspace, ofWorkspace);
  // A session that has exited is no longer in the workspace's list, but its tab is still wanted.
  const tabbed = shown.some((each) => each.id === session.id) ? shown : [...shown, session];
  return tabbed.map((each) => {
    const runner = runners.find((candidate) => candidate.id === each.runnerId);
    return describeSessionTab({
      session: each,
      label: labels.get(each.id) ?? each.title,
      pose: decideThreadPose(each, runner),
      runner,
      instance: instances.find((candidate) => candidate.id === each.instanceId),
    });
  });
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
 * The header's tabs (`listWorkspaceSessionTabs`) and the sidebar's rows both call
 * this, so they name a session the same way, as long as they pass the same
 * Threads and Agent sessions. A run's step session and an assistant's session
 * have no role, so they never change another session's number.
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
