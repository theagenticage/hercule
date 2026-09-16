/**
 * Reading the workspace a thread works in: what a repo is called, what a
 * workspace is called, which one a draft opens in by default, and the sentence
 * the draft stands under once it is picked (spec 14 §The composer).
 *
 * A workspace carries no name of its own. An ephemeral one is named after the
 * branch its checkout sits on (`hydra/run-3f1`), which is what the user typed
 * nothing to get; a primary is named after the repo and the machine it stands
 * on, because there is exactly one of those per pair.
 */
import type {
  Project,
  Resource,
  Runner,
  SpawnWorkspace,
  ThreadWorkspace,
  Workspace,
} from "@hydra/contract";

/**
 * What the composer's workspace selector holds: the contract's own spelling,
 * plus the fourth face the API spells by leaving the field off entirely.
 */
export type WorkspacePick = SpawnWorkspace | { readonly kind: "none" };

/**
 * A repo's short name: the last segment of its canonical remote, which is what
 * every row and every sentence calls it. A resource that is not a repo has no
 * remote, so it falls back to the label it carries; a resource the catalog no
 * longer holds still has to read as something in a sentence.
 */
export const repoName = (resource: Resource | undefined): string => {
  if (resource === undefined) return "the repo";
  const canonical = resource.canonicalRemote;
  if (canonical === null) return resource.label ?? resource.remote ?? "";
  return canonical.slice(canonical.lastIndexOf("/") + 1);
};

/** The repos filed under one project, in the catalog's own order. */
export const projectRepos = (
  resources: readonly Resource[],
  projectId: string | null,
): readonly Resource[] =>
  projectId === null
    ? []
    : resources.filter((each) => each.kind === "repo" && each.projectIds.includes(projectId));

/**
 * What a workspace is called where it stands for itself: the branch its first
 * checkout sits on. A scratch workspace has no checkout and so no name.
 */
export const workspaceName = (workspace: Workspace): string =>
  workspace.checkouts[0]?.branch ?? "workspace";

/** What a primary is called in the sidebar, where the repo and machine tell it apart. */
export const primaryName = (
  workspace: Workspace,
  resources: readonly Resource[],
  runners: readonly Runner[],
): string => {
  const resource = resources.find((each) => each.id === workspace.checkouts[0]?.resourceId);
  const runner = runners.find((each) => each.id === workspace.runnerId);
  return `${repoName(resource)} checkout · ${runner?.name ?? "unknown machine"}`;
};

/** What a workspace is called in the sidebar, whichever kind it is. */
export const workspaceLabel = (
  workspace: Workspace,
  resources: readonly Resource[],
  runners: readonly Runner[],
): string =>
  workspace.kind === "primary"
    ? primaryName(workspace, resources, runners)
    : workspaceName(workspace);

/** The repo's shared checkout on one machine, where that machine holds one. */
export const readyPrimary = (
  workspaces: readonly Workspace[],
  resourceId: string,
  runnerId: string | null,
): Workspace | undefined =>
  workspaces.find(
    (each) =>
      each.kind === "primary" &&
      each.status === "ready" &&
      each.runnerId === runnerId &&
      each.checkouts.some((checkout) => checkout.resourceId === resourceId),
  );

/** The live worktrees a project's threads could join, whichever machine they stand on. */
export const projectWorkspaces = (
  workspaces: readonly Workspace[],
  repos: readonly Resource[],
): readonly Workspace[] =>
  workspaces.filter(
    (each) =>
      each.kind === "ephemeral" &&
      each.status === "ready" &&
      each.checkouts.some((checkout) => repos.some((repo) => repo.id === checkout.resourceId)),
  );

/**
 * What a repo's new branch starts from, read once for everything that names it
 * - the Base branch field, its foot, and the draft's own lead sentence. The
 * shared checkout on the picked machine answers first, because that is the
 * clone the worktree is cut from; failing that, any machine that has reported
 * a checkout of the repo, because a default branch is the remote's fact rather
 * than the machine's. Null while nothing anywhere has cloned it.
 *
 * Only a `ready` workspace is read: a dead one's branches are gone, and a
 * failed clone never had any.
 */
export const baseBranchOf = (
  workspaces: readonly Workspace[],
  resourceId: string,
  runnerId: string | null,
): string | null => {
  const ready = workspaces.filter((each) => each.status === "ready");
  const here = readyPrimary(ready, resourceId, runnerId)?.checkouts.find(
    (checkout) => checkout.resourceId === resourceId,
  );
  if (here?.defaultBranch != null) return here.defaultBranch;
  for (const workspace of ready) {
    for (const checkout of workspace.checkouts) {
      if (checkout.resourceId === resourceId && checkout.defaultBranch !== null)
        return checkout.defaultBranch;
    }
  }
  return null;
};

/** What tells two picks apart. A branch is a choice inside a pick, not a pick. */
export const pickKey = (pick: WorkspacePick): string => {
  switch (pick.kind) {
    case "none":
      return "none";
    case "primary":
      return `primary:${pick.resourceId}`;
    case "ephemeral":
      return "ephemeral";
    case "existing":
      return `existing:${pick.workspaceId}`;
  }
};

/**
 * The same pick, on another branch: the branch a shared checkout is switched
 * to, or the ref a fresh worktree starts from.
 *
 * A worktree of several repos is handed back untouched. A base per repo is
 * post-v1 (spec 14 §The composer, the Branch selector), so there is no one
 * branch to apply: applying the same ref to every repo would claim a `main`
 * that only one of them has. The field is read-only there for that reason, and
 * this refuses for the same one rather than inventing what the field will not
 * ask for. Nothing to switch on a joined workspace or on no checkout either.
 */
export const withBranch = (pick: WorkspacePick, branch: string): WorkspacePick => {
  if (pick.kind === "primary") return { ...pick, branch };
  if (pick.kind !== "ephemeral") return pick;
  const only = pick.checkouts.length === 1 ? pick.checkouts[0] : undefined;
  return only === undefined
    ? pick
    : { kind: "ephemeral", checkouts: [{ ...only, baseBranch: branch }] };
};

/**
 * The machine a pick settles, where it settles one: a workspace that already
 * stands is on one machine and never moves (spec 02 §Workspace), so joining it
 * takes the machine with it. Null where the pick leaves the machine free.
 */
export const runnerForPick = (
  pick: WorkspacePick,
  workspaces: readonly Workspace[],
): string | null =>
  pick.kind === "existing"
    ? (workspaces.find((each) => each.id === pick.workspaceId)?.runnerId ?? null)
    : null;

/** What a draft's heading names, and whose identity hue the name wears. */
export interface DraftSubject {
  readonly label: string;
  /** The project whose hue the name wears; null where a workspace names it. */
  readonly projectId: string | null;
}

/**
 * What the draft's heading is about: the workspace it joins where it joins one,
 * else the project it stands in, else nothing - "What should the agent do?"
 * (spec 14 §The composer).
 */
export const draftSubject = (
  pick: WorkspacePick,
  workspaces: readonly Workspace[],
  project: Project | undefined,
): DraftSubject | null => {
  const joined =
    pick.kind === "existing" ? workspaces.find((each) => each.id === pick.workspaceId) : undefined;
  if (joined !== undefined) return { label: workspaceName(joined), projectId: null };
  return project === undefined ? null : { label: project.name, projectId: project.id };
};

/**
 * The workspace a draft opens in before the user touches anything: the stored
 * `thread.workspace` where there is one, else the shared checkout of a project
 * that holds one repo and a worktree of each repo of a project that holds
 * several (spec 14 §The composer). A project with no repo has nothing to open
 * in, whatever the setting asks for.
 */
export const defaultWorkspacePick = (
  repos: readonly Resource[],
  preferred: ThreadWorkspace | null,
): WorkspacePick => {
  const first = repos[0];
  if (first === undefined) return { kind: "none" };
  const mode = preferred ?? (repos.length === 1 ? "primary" : "ephemeral");
  if (mode === "none") return { kind: "none" };
  if (mode === "primary") return { kind: "primary", resourceId: first.id };
  return { kind: "ephemeral", checkouts: repos.map((repo) => ({ resourceId: repo.id })) };
};

/** What the lead sentence needs to name the places it speaks about. */
export interface WorkspaceReading {
  readonly resources: readonly Resource[];
  readonly workspaces: readonly Workspace[];
  /** The machine the thread would be placed on, already named. */
  readonly machine: string;
  /** The machine's id, which is what a shared checkout is looked up by. */
  readonly runnerId: string | null;
}

/**
 * The one sentence a draft stands under: where the thread will work, in the
 * four forms spec 14 §The composer pins. A shared checkout no machine has
 * cloned yet has no branch to name, so that clause is left out rather than
 * filled with a word for "we do not know".
 */
export const workspaceLead = (pick: WorkspacePick, reading: WorkspaceReading): string => {
  switch (pick.kind) {
    case "none":
      return "It works without a checkout.";
    case "primary": {
      const repo = repoName(reading.resources.find((each) => each.id === pick.resourceId));
      const branch =
        pick.branch ??
        readyPrimary(reading.workspaces, pick.resourceId, reading.runnerId)?.checkouts[0]?.branch ??
        null;
      const where =
        branch === null
          ? `It works in the checkout of ${repo} on ${reading.machine}.`
          : `It works in the checkout of ${repo} on ${reading.machine}, on ${branch}.`;
      return `${where} You and the agent share the files.`;
    }
    case "ephemeral": {
      const only = pick.checkouts.length === 1 ? pick.checkouts[0] : undefined;
      if (only === undefined) {
        return "It gets a worktree of each repo, side by side, each on a new branch.";
      }
      const repo = repoName(reading.resources.find((each) => each.id === only.resourceId));
      const base =
        only.baseBranch ?? baseBranchOf(reading.workspaces, only.resourceId, reading.runnerId);
      return `It gets its own worktree of ${repo}, on a new branch from ${base ?? "its default branch"}.`;
    }
    case "existing": {
      const joined = reading.workspaces.find((each) => each.id === pick.workspaceId);
      const name = joined === undefined ? "that workspace" : workspaceName(joined);
      return `It joins “${name}” there: the agents see each other's edits, on one branch.`;
    }
  }
};
