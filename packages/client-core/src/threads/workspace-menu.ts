/**
 * The composer's workspace menu: what a thread may open in, as rows (spec 14
 * §The composer, the Workspace selector). One row per thing that exists - the
 * repo's shared checkout, a fresh worktree, every live worktree of the project,
 * and none - with the reason a row is what it is on its sub-line, because
 * "dimmed with the reason, never hidden" is the rule for everything here.
 */
import type { Project, Resource, Runner, Session, Workspace } from "@hydra/contract";
import {
  pickKey,
  projectWorkspaces,
  readyPrimary,
  repoName,
  workspaceLabel,
  workspaceName,
  type WorkspacePick,
} from "./workspaces";

export interface WorkspaceMenuRow {
  readonly key: string;
  readonly pick: WorkspacePick;
  readonly name: string;
  /** A workspace is named after its branch, which is mono everywhere. */
  readonly mono: boolean;
  /** The note at the row's right: the machine a live workspace stands on. */
  readonly note: string | null;
  readonly sub: string | null;
  readonly current: boolean;
}

/**
 * What the foot can act on: the project a repo would be added to and the
 * machine a folder would be adopted on. Null on a draft that stands in no
 * project, which has nothing to add a repo to.
 */
export interface WorkspaceMenuFoot {
  readonly projectId: string;
  readonly addRepo: string;
  readonly runnerId: string | null;
}

export interface WorkspaceMenu {
  /** What the selector's own trigger reads. */
  readonly label: string;
  readonly rows: readonly WorkspaceMenuRow[];
  readonly foot: WorkspaceMenuFoot | null;
}

/** `2 threads · “Fix flaky webhook tests”, “Write the retry runbook”`. */
const threadsIn = (workspace: Workspace, sessions: readonly Session[]): string | null => {
  const titles = workspace.sessionIds.map(
    (id) => sessions.find((session) => session.id === id)?.title ?? null,
  );
  const named = titles.filter((title): title is string => title !== null);
  const count = workspace.sessionIds.length;
  if (count === 0) return null;
  const head = `${String(count)} ${count === 1 ? "thread" : "threads"}`;
  return named.length === 0 ? head : `${head} · ${named.map((title) => `“${title}”`).join(", ")}`;
};

export const workspaceMenu = ({
  project,
  repos,
  workspaces,
  sessions,
  runners,
  runnerId,
  pick,
}: {
  /** The project the draft stands in; undefined means it stands in none. */
  readonly project: Project | undefined;
  readonly repos: readonly Resource[];
  readonly workspaces: readonly Workspace[];
  readonly sessions: readonly Session[];
  readonly runners: readonly Runner[];
  readonly runnerId: string | null;
  readonly pick: WorkspacePick;
}): WorkspaceMenu => {
  const machine = runners.find((each) => each.id === runnerId)?.name ?? "this machine";
  const current = pickKey(pick);
  const rows: WorkspaceMenuRow[] = [];

  // A project with several repos opens a worktree of each by default, so that
  // row leads; with one repo the shared checkout leads, as t3 code's does.
  const fresh: WorkspaceMenuRow | null =
    repos.length === 0
      ? null
      : {
          key: "ephemeral",
          pick: { kind: "ephemeral", checkouts: repos.map((repo) => ({ resourceId: repo.id })) },
          name: "New workspace",
          mono: false,
          note: null,
          sub:
            repos.length === 1
              ? `a fresh worktree of ${repoName(repos[0])} on a new branch`
              : "a worktree of each repo, side by side, each on a new branch",
          current: current === "ephemeral",
        };

  const shared = repos.map((repo): WorkspaceMenuRow => {
    const primary = readyPrimary(workspaces, repo.id, runnerId);
    const branch = primary?.checkouts[0]?.branch ?? null;
    return {
      key: `primary:${repo.id}`,
      pick: { kind: "primary", resourceId: repo.id },
      name: repos.length === 1 ? "Current checkout" : `Current checkout of ${repoName(repo)}`,
      mono: false,
      note: null,
      sub:
        branch === null
          ? `not cloned on ${machine} · clones on first use`
          : `on ${branch} · you and the agent share the files`,
      current: current === `primary:${repo.id}`,
    };
  });

  if (repos.length > 1 && fresh !== null) rows.push(fresh, ...shared);
  else if (fresh !== null) rows.push(...shared, fresh);

  for (const workspace of projectWorkspaces(workspaces, repos)) {
    rows.push({
      key: `existing:${workspace.id}`,
      pick: { kind: "existing", workspaceId: workspace.id },
      name: workspaceName(workspace),
      mono: true,
      note: runners.find((each) => each.id === workspace.runnerId)?.name ?? null,
      sub: threadsIn(workspace, sessions),
      current: current === `existing:${workspace.id}`,
    });
  }

  // A draft in no project has no repo to open in and no project to add one to,
  // so the only row is the one #160 pinned and the foot stands dimmed.
  const none = project === undefined ? "No workspace" : "None";
  rows.push({
    key: "none",
    pick: { kind: "none" },
    name: none,
    mono: false,
    note: null,
    sub: "the agent works without a checkout",
    current: current === "none",
  });

  // A thread that already stands in a workspace names it even when no row
  // offers it: an active thread's shared checkout is not something to pick.
  const joined =
    pick.kind === "existing" ? workspaces.find((each) => each.id === pick.workspaceId) : undefined;

  return {
    label:
      rows.find((row) => row.current)?.name ??
      (joined === undefined ? none : workspaceLabel(joined, repos, runners)),
    rows,
    foot:
      project === undefined
        ? null
        : { projectId: project.id, addRepo: `Add a repo to ${project.name} →`, runnerId },
  };
};
