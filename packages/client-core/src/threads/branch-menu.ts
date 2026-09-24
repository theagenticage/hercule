/**
 * Builds the composer's branch selector, which is two different fields in the
 * same place (spec 14 §The composer, the Branch selector):
 *
 * - for a main workspace, it picks the branch the checkout switches to;
 * - for a new worktree, it picks the base the thread's new branch starts
 *   from. The new branch's name is generated.
 *
 * Returns `null` for an existing worktree the thread joins (the worktree is
 * named after its branch already), and for a thread with no checkout.
 */
import type { Workspace } from "@hercule/contract";
import {
  findBaseBranch,
  findReadyPrimary,
  formatWorkspaceName,
  type Phrase,
  type WorkspacePick,
} from "./workspaces";

export interface BranchRow {
  readonly branch: string;
  readonly badge: "current" | "default" | null;
  /** The worktree that has the branch checked out, if a live one does. */
  readonly dimmed: string | null;
}

export interface BranchField {
  readonly header: string;
  readonly note: string;
  /** The selector's text. For a main workspace, the branch glyph is drawn beside it. */
  readonly label: string;
  /** The branch that currently applies, which is the row the menu marks. */
  readonly value: string;
  readonly glyph: boolean;
  /** Why there is nothing to choose. When set, the field is shown as text, not a menu. */
  readonly locked: string | null;
  readonly rows: readonly BranchRow[];
  /** The fine print under the rows; the git names in it are set in mono. */
  readonly foot: readonly Phrase[] | null;
}

/** The branch label shown before any runner has cloned the repo. */
const UNKNOWN = "default";

/** Why the field is locked. */
const NOT_CLONED = "Nothing is cloned on this machine yet: it lands on the default branch";
const NO_BRANCH = "This machine could not read the checkout's branch";
const PER_REPO = "A base branch per repo is not built yet";

/**
 * Returns the branches that live worktrees of the repo on the same runner
 * have checked out, mapped to the worktree's name.
 */
const findBranchesHeldNearby = (
  workspaces: readonly Workspace[],
  resourceId: string,
  runnerId: string | null,
): ReadonlyMap<string, string> => {
  const held = new Map<string, string>();
  for (const workspace of workspaces) {
    if (workspace.kind !== "ephemeral" || workspace.status !== "ready") continue;
    if (workspace.runnerId !== runnerId) continue;
    for (const checkout of workspace.checkouts) {
      if (checkout.resourceId !== resourceId || checkout.branch === null) continue;
      held.set(checkout.branch, formatWorkspaceName(workspace));
    }
  }
  return held;
};

export const buildBranchField = (
  pick: WorkspacePick,
  {
    workspaces,
    runnerId,
  }: {
    readonly workspaces: readonly Workspace[];
    readonly runnerId: string | null;
  },
): BranchField | null => {
  if (pick.kind === "none" || pick.kind === "existing") return null;

  if (pick.kind === "primary") {
    const primary = findReadyPrimary(workspaces, pick.resourceId, runnerId);
    const checkout = primary?.checkouts[0];
    // Nothing is cloned on the runner yet, so there is no branch list, and the
    // clone will check out the remote's default branch. A checkout whose
    // branch the runner could not read is just as unknown, and switching away
    // from a branch nobody can name is not something to offer.
    if (checkout === undefined || checkout.branch === null) {
      return {
        header: "Branch",
        note: "the checkout switches to it",
        label: UNKNOWN,
        value: UNKNOWN,
        glyph: false,
        locked: checkout === undefined ? NOT_CLONED : NO_BRANCH,
        rows: [],
        foot: null,
      };
    }
    const held = findBranchesHeldNearby(workspaces, pick.resourceId, runnerId);
    // The main checkout's own branches, plus the branches that live worktrees
    // of the same repo on the same runner have checked out. Those are dimmed,
    // because git does not allow the same branch to be checked out twice.
    const names = [...new Set([...checkout.branches, ...held.keys()])];
    return {
      header: "Branch",
      note: "the checkout switches to it",
      label: pick.branch ?? checkout.branch,
      value: pick.branch ?? checkout.branch,
      glyph: true,
      locked: null,
      rows: names.map((branch) => {
        const holder = held.get(branch);
        return {
          branch,
          badge: branch === checkout.branch ? ("current" as const) : null,
          dimmed: holder === undefined ? null : `in workspace ${holder}`,
        };
      }),
      foot: null,
    };
  }

  const findPickedOrBaseBranch = (resourceId: string, picked?: string): string | null =>
    picked ?? findBaseBranch(workspaces, resourceId, runnerId);

  // Choosing a base per repo comes after v1, so a multi-repo worktree lists
  // the bases it will use and allows no pick. A repo that no runner has cloned
  // has no known base, and showing the placeholder as if it were a branch
  // would be wrong, so the label then only says "from default branches".
  if (pick.checkouts.length !== 1) {
    const bases = pick.checkouts.map((each) =>
      findPickedOrBaseBranch(each.resourceId, each.baseBranch),
    );
    return {
      header: "Base branch",
      note: "the new branch starts from it",
      label: bases.includes(null) ? "from default branches" : `from ${bases.join(" · ")}`,
      value: "",
      glyph: false,
      locked: PER_REPO,
      rows: [],
      foot: null,
    };
  }

  const only = pick.checkouts[0]!;
  const base = findPickedOrBaseBranch(only.resourceId, only.baseBranch);
  const checkout = findReadyPrimary(workspaces, only.resourceId, runnerId)?.checkouts[0];
  const defaultBranch = findBaseBranch(workspaces, only.resourceId, runnerId);
  const names = checkout?.branches ?? [];
  return {
    header: "Base branch",
    note: "the new branch starts from it",
    label: base === null ? UNKNOWN : `from ${base}`,
    value: base ?? UNKNOWN,
    glyph: false,
    locked: names.length === 0 ? NOT_CLONED : null,
    rows: names.map((branch) => ({
      branch,
      badge: branch === defaultBranch ? "default" : branch === checkout?.branch ? "current" : null,
      dimmed: null,
    })),
    foot:
      base === null
        ? null
        : [
            { text: "The new branch is " },
            { text: "hercule/run-…", mono: true },
            { text: ", named after the thread, and starts from " },
            { text: `origin/${base}`, mono: true },
            { text: " when the remote has it." },
          ],
  };
};
