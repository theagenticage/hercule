/**
 * Reading the workspace a thread works in: what a repo is called, what a
 * workspace is called, which one a draft opens in by default, and the sentence
 * the draft stands under once it is picked (spec 14 §The composer).
 *
 * A workspace carries no name of its own. An ephemeral one is named after the
 * branch its checkout sits on (`hydra/run-3f1`), which is what the user typed
 * nothing to get; a primary - the repo's **main workspace** (D-20c) - is named
 * after the repo and the machine it stands on, because there is exactly one of
 * those per pair.
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
import { projectTone, type ProjectTone } from "./tone";

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

/**
 * A workspace's label in two parts: what may be cut short where the sidebar is
 * narrower than the name, and what must stand whole whatever happens.
 *
 * On a primary that is the repo and ` · <machine>` (D-20c): the machine is
 * the whole point of the label - it is what tells one repo's two main
 * workspaces apart - so cutting the label's tail would eat the one word that
 * means something. An ephemeral workspace is named after its branch, which is
 * one word and is cut as one.
 */
export interface WorkspaceLabel {
  /** The part that may be cut short, with an ellipsis, when room runs out. */
  readonly clip: string;
  /** What stands whole beside it; empty where the whole label may be cut. */
  readonly keep: string;
}

export const workspaceLabelParts = (
  workspace: Workspace,
  resources: readonly Resource[],
  runners: readonly Runner[],
): WorkspaceLabel => {
  if (workspace.kind !== "primary") return { clip: workspaceName(workspace), keep: "" };
  const resource = resources.find((each) => each.id === workspace.checkouts[0]?.resourceId);
  const runner = runners.find((each) => each.id === workspace.runnerId);
  return {
    clip: repoName(resource),
    keep: ` · ${runner?.name ?? "unknown machine"}`,
  };
};

/** The same label read whole, which is what a tooltip and a reader get. */
export const labelText = (label: WorkspaceLabel): string => `${label.clip}${label.keep}`;

/** What a workspace is called in the sidebar, whichever kind it is. */
export const workspaceLabel = (
  workspace: Workspace,
  resources: readonly Resource[],
  runners: readonly Runner[],
): string => labelText(workspaceLabelParts(workspace, resources, runners));

/** The repo's main workspace on one machine, where that machine holds one. */
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
 * main workspace on the picked machine answers first, because that is the
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

/**
 * Why a draft takes no workspace pick at all, in the two shapes that happen:
 * a project with no repo has nowhere to work, and a draft standing in no
 * project has no project to add a repo to. None is the one thing on offer in
 * both, and the selector says what would put something else there (D-20d).
 */
export const NO_WORKSPACE_REASON = "Add a repository to the project to work in one";

export const NO_PROJECT_REASON = "Pick a project to work in a repository";

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
 * The same pick, on another branch: the branch a main workspace is switched
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
  /** That hue, read the one way every surface reads it (`projectTone`). */
  readonly tone: ProjectTone | null;
}

/**
 * What the draft's heading is about: the workspace it joins where it joins one,
 * else the project it stands in, else nothing - "What should the agent do?"
 * (spec 14 §The composer).
 */
export const draftSubject = (
  pick: WorkspacePick,
  workspaces: readonly Workspace[],
  projectId: string | null,
  projects: readonly Project[],
): DraftSubject | null => {
  const joined =
    pick.kind === "existing" ? workspaces.find((each) => each.id === pick.workspaceId) : undefined;
  if (joined !== undefined) return { label: workspaceName(joined), projectId: null, tone: null };
  const project = projects.find((each) => each.id === projectId);
  return project === undefined
    ? null
    : { label: project.name, projectId: project.id, tone: projectTone(project.id, projects) };
};

/**
 * The stored `thread.workspace` read as a preference: one of the two faces the
 * setting offers, or nothing. Anything else - a `none` stored before D-20d
 * dropped it - reads as unset, so the rule below decides rather than a value
 * nobody can set any more.
 */
export const preferredWorkspaceOf = (stored: string | null | undefined): ThreadWorkspace | null =>
  stored === "primary" || stored === "ephemeral" ? stored : null;

/**
 * The workspace a draft opens in before the user touches anything: the stored
 * `thread.workspace` where there is one, else the main workspace of a project
 * that holds one repo and a worktree of each repo of a project that holds
 * several (spec 14 §The composer). A project with no repo has nothing to open
 * in, whatever the setting asks for.
 *
 * A stored `none` is honoured only where None is offered at all, which is a
 * project with no repo (D-20d); a project that holds one falls back to the
 * rule rather than starting a thread outside the repo the user picked.
 */
export const defaultWorkspacePick = (
  repos: readonly Resource[],
  preferred: ThreadWorkspace | null,
): WorkspacePick => {
  const first = repos[0];
  if (first === undefined) return { kind: "none" };
  const mode = preferredWorkspaceOf(preferred) ?? (repos.length === 1 ? "primary" : "ephemeral");
  if (mode === "primary") return { kind: "primary", resourceId: first.id };
  return { kind: "ephemeral", checkouts: repos.map((repo) => ({ resourceId: repo.id })) };
};

/** What the lead sentence needs to name the places it speaks about. */
export interface WorkspaceReading {
  readonly resources: readonly Resource[];
  readonly workspaces: readonly Workspace[];
  /** The threads the workspaces hold, which a joining draft names (D-19). */
  readonly sessions?: readonly Session[];
  /** The machine the thread would be placed on, already named. */
  readonly machine: string;
  /** The machine's id, which is what a main workspace is looked up by. */
  readonly runnerId: string | null;
}

/**
 * One piece of a sentence the composer writes. A git word - a branch, a ref -
 * is set in mono wherever it is read, here as everywhere else, so a sentence
 * is parts rather than one string.
 */
export interface Phrase {
  readonly text: string;
  readonly mono?: boolean;
}

/** The same sentence as plain words, which is what a reader hears. */
export const phraseText = (parts: readonly Phrase[]): string =>
  parts.map((part) => part.text).join("");

/**
 * The threads working in a workspace, as the lead names them: two of them at
 * most, and the rest counted (D-19). A thread the listing does not hold is one
 * the reader cannot be told about, so it is counted with the rest.
 */
const titlesIn = (workspace: Workspace, sessions: readonly Session[]): string => {
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
 * What the composer's box asks for before anything is typed. It follows the
 * same reading as the lead sentence, which is why it lives beside it: a draft
 * joining a workspace is being written into files that already stand, so it
 * says which (spec 14 §The composer).
 */
export const composerPlaceholder = ({
  readOnly,
  busy,
  active,
  pick,
  workspaces,
}: {
  /** Why the thread can take no input at all; null when it can. */
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
    : `Say what this thread should do in ${workspaceName(joined)}…`;
};

/**
 * The one sentence a draft stands under: where the thread will work, in the
 * four forms spec 14 §The composer pins. A main workspace no machine has
 * cloned yet has no branch to name, so that clause is left out rather than
 * filled with a word for "we do not know".
 */
export const workspaceLead = (
  pick: WorkspacePick,
  reading: WorkspaceReading,
): readonly Phrase[] => {
  switch (pick.kind) {
    case "none":
      return [{ text: "It works without a checkout." }];
    case "primary": {
      const repo = repoName(reading.resources.find((each) => each.id === pick.resourceId));
      const branch =
        pick.branch ??
        readyPrimary(reading.workspaces, pick.resourceId, reading.runnerId)?.checkouts[0]?.branch ??
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
      const repo = repoName(reading.resources.find((each) => each.id === only.resourceId));
      const base =
        only.baseBranch ?? baseBranchOf(reading.workspaces, only.resourceId, reading.runnerId);
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
      const name = joined === undefined ? "that workspace" : workspaceName(joined);
      const threads = joined === undefined ? "" : titlesIn(joined, reading.sessions ?? []);
      // What the draft joins is the work already going on there, named; a
      // workspace holding nothing yet is named after itself (D-19).
      const subject = threads === "" ? `“${name}”` : threads;
      return [
        { text: `It joins ${subject} there: the agents see each other's edits, on one branch.` },
      ];
    }
  }
};
