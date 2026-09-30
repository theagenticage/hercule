/**
 * Functions about the workspace a thread works in: the display names of repos
 * and workspaces, the workspace a draft opens in by default, and the lead
 * sentence shown above a draft (spec 14 §The composer).
 *
 * A workspace has no name of its own:
 *
 * - an ephemeral workspace is named after the branch its checkout is on
 *   (`hercule/thread-3f1`), which Hercule generated;
 * - a primary workspace, the repo's **main workspace**, is named after the
 *   repo and the runner it is on, because there is exactly one per repo and
 *   runner.
 */
import type {
  Project,
  Resource,
  Runner,
  Session,
  SpawnWorkspace,
  ThreadWorkspace,
  Workspace,
} from "@hercule/contract";
import { pickProjectTone, type ProjectTone } from "./tone";

/**
 * The value of the composer's workspace selector: the contract's
 * `SpawnWorkspace`, plus `none`, which the API expresses by leaving the field
 * out.
 */
export type WorkspacePick = SpawnWorkspace | { readonly kind: "none" };

/**
 * Returns a repo's short name: the last segment of its canonical remote, which
 * every row and sentence uses. A resource with no canonical remote falls back
 * to its label, then its remote. A missing resource returns "the repo", so a
 * sentence still reads correctly.
 */
export const formatRepoName = (resource: Resource | undefined): string => {
  if (resource === undefined) return "the repo";
  const canonical = resource.canonicalRemote;
  if (canonical === null) return resource.label ?? resource.remote ?? "";
  return canonical.slice(canonical.lastIndexOf("/") + 1);
};

/** Returns the repos of a project, in catalog order, or none when `projectId` is `null`. */
export const listProjectRepos = (
  resources: readonly Resource[],
  projectId: string | null,
): readonly Resource[] =>
  projectId === null
    ? []
    : resources.filter((each) => each.kind === "repo" && each.projectIds.includes(projectId));

/**
 * Returns a workspace's name: the branch of its first checkout. A workspace
 * with no checkout, or whose branch is unknown, is called "workspace".
 */
export const formatWorkspaceName = (workspace: Workspace): string =>
  workspace.checkouts[0]?.branch ?? "workspace";

/**
 * A workspace's label in two parts: the part that may be truncated when the
 * sidebar is too narrow, and the part that is always shown in full.
 *
 * For a primary workspace the parts are the repo and ` · <runner>`. The runner
 * name is what tells one repo's main workspaces apart, so truncating the end
 * of the label would hide the only part that matters. An ephemeral workspace
 * is named after its branch, which is truncated as a whole.
 */
export interface WorkspaceLabel {
  /** The part that may be truncated, with an ellipsis, when there is not enough room. */
  readonly clip: string;
  /** The part always shown in full after it; empty when the whole label may be truncated. */
  readonly keep: string;
}

/**
 * Returns a workspace's label, split into the part that may be truncated and
 * the part that may not.
 */
export const buildWorkspaceLabelParts = (
  workspace: Workspace,
  resources: readonly Resource[],
  runners: readonly Runner[],
): WorkspaceLabel => {
  if (workspace.kind !== "primary") return { clip: formatWorkspaceName(workspace), keep: "" };
  const resource = resources.find((each) => each.id === workspace.checkouts[0]?.resourceId);
  const runner = runners.find((each) => each.id === workspace.runnerId);
  return {
    clip: formatRepoName(resource),
    keep: ` · ${runner?.name ?? "unknown machine"}`,
  };
};

/** Returns the label as one string, for a tooltip or a screen reader. */
export const joinLabelText = (label: WorkspaceLabel): string => `${label.clip}${label.keep}`;

/** Returns a workspace's full sidebar label, for either kind of workspace. */
export const formatWorkspaceLabel = (
  workspace: Workspace,
  resources: readonly Resource[],
  runners: readonly Runner[],
): string => joinLabelText(buildWorkspaceLabelParts(workspace, resources, runners));

/**
 * Checks whether a new thread can join the workspace. Only a ready workspace
 * takes threads: the controller refuses to start a thread in a workspace that
 * is still being set up, failed, was deleted or was lost. Returns `false` for
 * `undefined`, a workspace the list does not hold.
 */
export const isJoinable = (workspace: Workspace | undefined): boolean =>
  workspace?.status === "ready";

/** Returns the repo's ready main workspace on a runner, or `undefined` when the runner has none. */
export const findReadyPrimary = (
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

/** Returns the live worktrees of a project's repos that a thread could join, on any runner. */
export const listProjectWorkspaces = (
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
 * Returns the default base branch for a new branch of a repo. The Base branch
 * field, its fine print and the draft's lead sentence all use it. It looks in:
 *
 * - the main workspace on the picked runner first, because the worktree is
 *   created from that clone;
 * - otherwise any checkout of the repo on any runner, because the default
 *   branch belongs to the remote, not to the runner.
 *
 * Returns `null` when no runner has cloned the repo. Only `ready` workspaces
 * are read: a deleted workspace's branches are gone, and a failed clone never
 * had any.
 */
export const findBaseBranch = (
  workspaces: readonly Workspace[],
  resourceId: string,
  runnerId: string | null,
): string | null => {
  const ready = workspaces.filter((each) => each.status === "ready");
  const here = findReadyPrimary(ready, resourceId, runnerId)?.checkouts.find(
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

/**
 * Why the workspace selector is locked. There are two cases:
 *
 * - a project with no repo has nowhere to work;
 * - a draft with no project has no project to add a repo to.
 *
 * In both, "None" is the only option, and the selector's reason tells the
 * user what would give them another option.
 */
export const NO_WORKSPACE_REASON = "Add a repository to the project to work in one";

export const NO_PROJECT_REASON = "Pick a project to work in a repository";

/**
 * Returns a key that identifies a pick. The branch is ignored: it is a choice
 * inside a pick, not a different pick.
 */
export const buildPickKey = (pick: WorkspacePick): string => {
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
 * Returns the pick with a different branch: the branch a main workspace
 * switches to, or the base a new worktree starts from.
 *
 * Returns the pick unchanged in these cases:
 *
 * - a worktree of several repos. Choosing a base per repo comes after v1
 *   (spec 14 §The composer, the Branch selector), and applying one branch to
 *   every repo could name a `main` that only one of them has. The field is
 *   read-only there for the same reason.
 * - a joined workspace, or a thread with no checkout: there is no branch to
 *   change.
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
 * Returns the runner a pick requires, or `null` when the pick leaves the runner
 * free. An existing workspace is on one runner and never moves (spec 02
 * §Workspace), so joining it means running on that runner.
 */
export const findRunnerForPick = (
  pick: WorkspacePick,
  workspaces: readonly Workspace[],
): string | null =>
  pick.kind === "existing"
    ? (workspaces.find((each) => each.id === pick.workspaceId)?.runnerId ?? null)
    : null;

/** What a draft's heading names, and which project's identity hue it uses. */
export interface DraftSubject {
  readonly label: string;
  /** The project whose hue the name uses, or `null` when the heading names a workspace. */
  readonly projectId: string | null;
  /** The project's hue, from `pickProjectTone` like on every other screen. */
  readonly tone: ProjectTone | null;
}

/**
 * Returns what the draft's heading names: the workspace it joins, if any, else
 * its project. Returns `null` when there is neither, and the heading is then
 * just "What should the agent do?" (spec 14 §The composer).
 */
export const findDraftSubject = (
  pick: WorkspacePick,
  workspaces: readonly Workspace[],
  projectId: string | null,
  projects: readonly Project[],
): DraftSubject | null => {
  const joined =
    pick.kind === "existing" ? workspaces.find((each) => each.id === pick.workspaceId) : undefined;
  if (joined !== undefined)
    return { label: formatWorkspaceName(joined), projectId: null, tone: null };
  const project = projects.find((each) => each.id === projectId);
  return project === undefined
    ? null
    : { label: project.name, projectId: project.id, tone: pickProjectTone(project.id, projects) };
};

/**
 * Parses the stored `thread.workspace` setting: `primary`, `ephemeral`, or
 * `null`. Any other value, such as a `none` stored by an older version, counts
 * as unset, so the default rule decides rather than a value nobody can set any
 * more.
 */
export const parsePreferredWorkspace = (
  stored: string | null | undefined,
): ThreadWorkspace | null => (stored === "primary" || stored === "ephemeral" ? stored : null);

/**
 * Returns the workspace a draft opens in before the user picks one (spec 14
 * §The composer):
 *
 * - a project with no repo works without a checkout, whatever the setting;
 * - otherwise the stored `thread.workspace` setting, when it is set;
 * - otherwise the main workspace for a one-repo project, and a worktree of
 *   each repo for a project with several.
 *
 * A stored `none` is ignored (see `parsePreferredWorkspace`), so a project
 * with a repo never starts a thread outside it.
 */
export const decideDefaultWorkspacePick = (
  repos: readonly Resource[],
  preferred: ThreadWorkspace | null,
): WorkspacePick => {
  const first = repos[0];
  if (first === undefined) return { kind: "none" };
  const mode = parsePreferredWorkspace(preferred) ?? (repos.length === 1 ? "primary" : "ephemeral");
  if (mode === "primary") return { kind: "primary", resourceId: first.id };
  return { kind: "ephemeral", checkouts: repos.map((repo) => ({ resourceId: repo.id })) };
};

/** The records the lead sentence needs to name the workspace, repo and runner. */
export interface WorkspaceReading {
  readonly resources: readonly Resource[];
  readonly workspaces: readonly Workspace[];
  /** The sessions, so the lead can name the threads of a workspace a draft joins. */
  readonly sessions?: readonly Session[];
  /** The name of the runner the thread would be placed on. */
  readonly machine: string;
  /** The runner's id, used to look up the main workspace. */
  readonly runnerId: string | null;
}

/**
 * One piece of a sentence the composer shows. Git names (a branch, a ref) are
 * always set in mono, so a sentence is a list of pieces rather than one
 * string.
 */
export interface Phrase {
  readonly text: string;
  readonly mono?: boolean;
}

/** Returns the sentence as one plain string, for example for a screen reader. */
export const joinPhraseText = (parts: readonly Phrase[]): string =>
  parts.map((part) => part.text).join("");

/**
 * Returns the titles of the threads in a workspace, for the lead sentence: at
 * most two titles, and a count of the rest. A thread that is not in `sessions`
 * has no known title, so it is counted with the rest.
 */
const describeThreadTitles = (workspace: Workspace, sessions: readonly Session[]): string => {
  const titles = workspace.sessionIds.map(
    (id) => sessions.find((session) => session.id === id)?.title ?? null,
  );
  const named = titles.filter((title): title is string => title !== null).map((t) => `“${t}”`);
  const rest = workspace.sessionIds.length - Math.min(named.length, 2);
  const shown = named.slice(0, 2);
  if (shown.length === 0) return "";
  if (rest > 0) return `${shown.join(", ")} and ${String(rest)} more`;
  return shown.length === 1 ? shown[0]! : `${shown[0]!} and ${shown[1]!}`;
};

/**
 * Returns the composer's placeholder text. It lives next to the lead sentence
 * because it follows the same rules: a draft that joins a workspace works on
 * files that already exist, so the placeholder names the workspace (spec 14
 * §The composer).
 */
export const buildComposerPlaceholder = ({
  readOnly,
  busy,
  active,
  pick,
  workspaces,
}: {
  /** Why the thread cannot take input, or `null` when it can. */
  readonly readOnly: string | null;
  readonly busy: boolean;
  /** Whether the thread has started; a draft has not. */
  readonly active: boolean;
  readonly pick: WorkspacePick;
  readonly workspaces: readonly Workspace[];
}): string => {
  if (readOnly !== null) return `This thread can't be resumed: ${readOnly}.`;
  if (busy) return "Queued until the turn finishes…";
  if (active) return "Reply…";
  const joined =
    pick.kind === "existing" ? workspaces.find((each) => each.id === pick.workspaceId) : undefined;
  return joined === undefined
    ? "Say what you want done…"
    : `Say what this thread should do in ${formatWorkspaceName(joined)}…`;
};

/**
 * Returns the lead sentence shown above a draft: where the thread will work,
 * in one of the four forms spec 14 §The composer defines. When no runner has
 * cloned the main workspace yet, its branch is unknown, so the branch clause
 * is left out rather than filled with a word for "unknown".
 */
export const buildWorkspaceLead = (
  pick: WorkspacePick,
  reading: WorkspaceReading,
): readonly Phrase[] => {
  switch (pick.kind) {
    case "none":
      return [{ text: "It works without a checkout." }];
    case "primary": {
      const repo = formatRepoName(reading.resources.find((each) => each.id === pick.resourceId));
      const branch =
        pick.branch ??
        findReadyPrimary(reading.workspaces, pick.resourceId, reading.runnerId)?.checkouts[0]
          ?.branch ??
        null;
      const where: readonly Phrase[] =
        branch === null
          ? [{ text: `It works in the main workspace of ${repo} on ${reading.machine}.` }]
          : [
              { text: `It works in the main workspace of ${repo} on ${reading.machine}, on ` },
              { text: branch, mono: true },
              { text: "." },
            ];
      return [...where, { text: " You and the agent share the files." }];
    }
    case "ephemeral": {
      const only = pick.checkouts.length === 1 ? pick.checkouts[0] : undefined;
      if (only === undefined) {
        return [{ text: "It gets a worktree of each repo, side by side, each on a new branch." }];
      }
      const repo = formatRepoName(reading.resources.find((each) => each.id === only.resourceId));
      const base =
        only.baseBranch ?? findBaseBranch(reading.workspaces, only.resourceId, reading.runnerId);
      const from: readonly Phrase[] =
        base === null ? [{ text: "its default branch" }] : [{ text: base, mono: true }];
      return [
        { text: `It gets its own worktree of ${repo}, on a new branch from ` },
        ...from,
        { text: "." },
      ];
    }
    case "existing": {
      const joined = reading.workspaces.find((each) => each.id === pick.workspaceId);
      const name = joined === undefined ? "that workspace" : formatWorkspaceName(joined);
      const threads =
        joined === undefined ? "" : describeThreadTitles(joined, reading.sessions ?? []);
      // Name the threads already working there. A workspace with no threads
      // is named after itself.
      const subject = threads === "" ? `“${name}”` : threads;
      return [
        { text: `It joins ${subject} there: the agents see each other's edits, on one branch.` },
      ];
    }
  }
};
