/**
 * The composer's workspace menu: what a thread may open in, as rows (spec 14
 * §The composer, the Workspace selector). One row per thing that exists - the
 * repo's main workspace, a fresh worktree, every live worktree of the project -
 * with the reason a row is what it is on its sub-line, because "dimmed with the
 * reason, never hidden" is the rule for everything here.
 *
 * None is not one of them: a project that holds a repo always works in one of
 * its workspaces, so None is offered only where there is nothing else to offer
 * (D-20d), and there the selector itself is locked.
 */
import type { Project, Resource, Runner, Session, Workspace } from "@hercule/contract";
import {
  buildPickKey,
  listProjectWorkspaces,
  findReadyPrimary,
  formatRepoName,
  formatWorkspaceLabel,
  formatWorkspaceName,
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

export interface WorkspaceMenu {
  /** What the selector's own trigger reads. */
  readonly label: string;
  readonly rows: readonly WorkspaceMenuRow[];
}

/** The pick a thread makes when it works without a checkout at all. */
const NONE: WorkspacePick = { kind: "none" };

/** `2 threads · “Fix flaky webhook tests”, “Write the retry runbook”`. */
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
  const freshPick: WorkspacePick = {
    kind: "ephemeral",
    checkouts: repos.map((repo) => ({ resourceId: repo.id })),
  };
  const current = buildPickKey(pick);
  const rows: WorkspaceMenuRow[] = [];

  // A project with several repos opens a worktree of each by default, so that
  // row leads; with one repo the main workspace leads, as t3 code's does.
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
    const primary = findReadyPrimary(workspaces, repo.id, runnerId);
    const branch = primary?.checkouts[0]?.branch ?? null;
    const sharedPick: WorkspacePick = { kind: "primary", resourceId: repo.id };
    return {
      key: buildPickKey(sharedPick),
      pick: sharedPick,
      name: repos.length === 1 ? "Main workspace" : `Main workspace of ${formatRepoName(repo)}`,
      mono: false,
      // The machine stands at the right of every row that has one, the shared
      // checkout included: it is on a machine as much as a worktree is.
      note: runnerId === null ? null : machine,
      sub:
        branch === null
          ? `not cloned on ${machine} · clones on first use`
          : `on ${branch} · you and the agent share the files`,
      current: current === buildPickKey(sharedPick),
    };
  });

  if (repos.length > 1 && fresh !== null) rows.push(fresh, ...shared);
  else if (fresh !== null) rows.push(...shared, fresh);

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

  // A project with a repo always works in one of its workspaces (D-20d). Only
  // one with nothing checked out anywhere - and a draft standing in no project
  // at all - has none to offer, and there it is the single row.
  const none = project === undefined ? "No workspace" : "None";
  if (repos.length === 0) {
    rows.push({
      key: buildPickKey(NONE),
      pick: NONE,
      name: none,
      mono: false,
      note: null,
      sub: "the agent works without a checkout",
      current: current === buildPickKey(NONE),
    });
  }

  // A thread that already stands in a workspace names it even when no row
  // offers it: an active thread's main workspace is not something to pick.
  const joined =
    pick.kind === "existing" ? workspaces.find((each) => each.id === pick.workspaceId) : undefined;

  return {
    label:
      rows.find((row) => row.current)?.name ??
      (joined === undefined ? none : formatWorkspaceLabel(joined, repos, runners)),
    rows,
  };
};
