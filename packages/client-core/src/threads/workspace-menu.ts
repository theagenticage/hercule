/**
 * Builds the composer's workspace menu: the workspaces a thread can open in.
 * There is one row per option: each repo's main workspace, a new worktree,
 * and every live worktree of the project. Each row explains itself on its
 * second line. A row the user cannot pick is dimmed with the reason, never
 * hidden, so the user learns why it is not available. Spec 14 §The composer
 * owns the Workspace selector.
 *
 * "No workspace" is usually not offered: a project with a repo always works
 * in one of its workspaces. "No workspace" is the only row when there is no
 * repo, and then the selector is locked.
 */
import type { Resource, Runner, Session, Workspace } from "@hercule/contract";
import {
  buildPickKey,
  listProjectWorkspaces,
  findPrimaryWorkspace,
  formatRepoName,
  formatWorkspaceLabel,
  formatWorkspaceName,
  type WorkspacePick,
} from "./workspaces";

export interface WorkspaceMenuRow {
  readonly key: string;
  readonly pick: WorkspacePick;
  readonly name: string;
  /**
   * Whether the name is shown in mono. A worktree is named after its branch,
   * and branches are always mono.
   */
  readonly mono: boolean;
  /** The note on the right of the row: the runner the workspace is on. */
  readonly note: string | null;
  readonly sub: string | null;
  readonly current: boolean;
}

export interface WorkspaceMenu {
  /** The text on the selector's button. */
  readonly label: string;
  readonly rows: readonly WorkspaceMenuRow[];
}

/** The pick for a thread that works without a checkout. */
const NONE: WorkspacePick = { kind: "none" };

/** The name of the pick for a thread that works without a checkout. */
const NO_WORKSPACE = "No workspace";

/**
 * Returns a summary of the workspace's threads, such as `2 threads · “Fix flaky
 * webhook tests”, “Write the retry runbook”`, or `null` when it has none.
 */
const describeThreadsIn = (workspace: Workspace, sessions: readonly Session[]): string | null => {
  const titles = workspace.sessionIds.map(
    (id) => sessions.find((session) => session.id === id)?.title ?? null,
  );
  const named = titles.filter((title): title is string => title !== null);
  const count = workspace.sessionIds.length;
  if (count === 0) return null;
  const head = `${String(count)} ${count === 1 ? "thread" : "threads"}`;
  return named.length === 0 ? head : `${head} · ${named.map((title) => `“${title}”`).join(", ")}`;
};

export const buildWorkspaceMenu = ({
  repos,
  workspaces,
  sessions,
  runners,
  runnerId,
  pick,
}: {
  readonly repos: readonly Resource[];
  readonly workspaces: readonly Workspace[];
  readonly sessions: readonly Session[];
  readonly runners: readonly Runner[];
  readonly runnerId: string | null;
  readonly pick: WorkspacePick;
}): WorkspaceMenu => {
  const machine = runners.find((each) => each.id === runnerId)?.name ?? "this machine";
  const freshPick: WorkspacePick = {
    kind: "ephemeral",
    checkouts: repos.map((repo) => ({ resourceId: repo.id })),
  };
  const current = buildPickKey(pick);
  const rows: WorkspaceMenuRow[] = [];

  // New work gets separate files by default. Sharing is an explicit choice.
  const fresh: WorkspaceMenuRow | null =
    repos.length === 0
      ? null
      : {
          key: buildPickKey(freshPick),
          pick: freshPick,
          name: "New workspace",
          mono: false,
          note: null,
          sub:
            repos.length === 1
              ? `a fresh worktree of ${formatRepoName(repos[0])} on a new branch`
              : "a worktree of each repo, side by side, each on a new branch",
          current: current === buildPickKey(freshPick),
        };

  const shared = repos.map((repo): WorkspaceMenuRow => {
    const primary = findPrimaryWorkspace(workspaces, repo.id, runnerId);
    const branch = primary?.checkouts[0]?.branch ?? null;
    const sharedPick: WorkspacePick = { kind: "primary", resourceId: repo.id };
    return {
      key: buildPickKey(sharedPick),
      pick: sharedPick,
      name:
        repos.length === 1 ? "Use main workspace" : `Use main workspace of ${formatRepoName(repo)}`,
      mono: false,
      // Every row that is on a runner shows the runner's name on the right,
      // including the main workspace: it is on a runner just like a worktree.
      note: runnerId === null ? null : machine,
      sub:
        primary !== undefined && primary.status !== "ready"
          ? (primary.message ??
            `The source on ${machine} is ${primary.status}; restore it before sharing files`)
          : branch === null
            ? `shares the main working files on ${machine} · prepares on first use`
            : `on ${branch} · you and the agent share the files`,
      current: current === buildPickKey(sharedPick),
    };
  });

  if (fresh !== null) rows.push(fresh, ...shared);

  for (const workspace of listProjectWorkspaces(workspaces, repos)) {
    const joinPick: WorkspacePick = { kind: "existing", workspaceId: workspace.id };
    rows.push({
      key: buildPickKey(joinPick),
      pick: joinPick,
      name: formatWorkspaceName(workspace),
      mono: true,
      note: runners.find((each) => each.id === workspace.runnerId)?.name ?? null,
      sub: describeThreadsIn(workspace, sessions),
      current: current === buildPickKey(joinPick),
    });
  }

  // A project with a repo always works in one of its workspaces. Only a
  // project with no repo, or a draft with no project, offers "No workspace",
  // and then it is the only row.
  if (repos.length === 0) {
    rows.push({
      key: buildPickKey(NONE),
      pick: NONE,
      name: NO_WORKSPACE,
      mono: false,
      note: null,
      sub: "the agent works without a checkout",
      current: current === buildPickKey(NONE),
    });
  }

  // A thread that is already in a workspace shows its name even when no row
  // offers it, because an active thread's main workspace is not a menu row.
  const joined =
    pick.kind === "existing" ? workspaces.find((each) => each.id === pick.workspaceId) : undefined;

  return {
    label:
      rows.find((row) => row.current)?.name ??
      (joined === undefined ? NO_WORKSPACE : formatWorkspaceLabel(joined, repos, runners)),
    rows,
  };
};
