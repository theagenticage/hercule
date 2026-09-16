/**
 * The composer's branch selector, which is two fields wearing one slot (spec 14
 * §The composer, the Branch selector). On a main workspace it picks the branch
 * the checkout is switched to; on a fresh worktree it picks the ref the
 * thread's own branch starts from, the branch name itself being generated. It
 * is absent on a workspace the thread merely joins - that workspace is named
 * after its branch - and on a thread with no checkout at all.
 */
import type { Workspace } from "@hydra/contract";
import {
  baseBranchOf,
  readyPrimary,
  workspaceName,
  type Phrase,
  type WorkspacePick,
} from "./workspaces";

export interface BranchRow {
  readonly branch: string;
  readonly badge: "current" | "default" | null;
  /** What holds it, where a live worktree already sits on it. */
  readonly dimmed: string | null;
}

export interface BranchField {
  readonly header: string;
  readonly note: string;
  /** What the lip reads; the branch glyph is drawn beside it on a checkout. */
  readonly label: string;
  /** The branch in force, which is the row the menu marks. */
  readonly value: string;
  readonly glyph: boolean;
  /** Why there is nothing to choose between; a field like that is text, not a menu. */
  readonly locked: string | null;
  readonly rows: readonly BranchRow[];
  /** The fine print under the rows; the git words in it are set in mono. */
  readonly foot: readonly Phrase[] | null;
}

/** What a branch reads as before any machine has cloned the repo it is in. */
const UNKNOWN = "default";

/** Why the field takes no pick, where it takes none. */
const NOT_CLONED = "Nothing is cloned on this machine yet: it lands on the default branch";
const NO_BRANCH = "This machine could not read the checkout's branch";
const PER_REPO = "A base branch per repo is not built yet";

const branchesHeldNearby = (
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
      held.set(checkout.branch, workspaceName(workspace));
    }
  }
  return held;
};

export const branchField = (
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
    const primary = readyPrimary(workspaces, pick.resourceId, runnerId);
    const checkout = primary?.checkouts[0];
    // Nothing is cloned there yet, so there is no branch list to read and the
    // clone will land on whatever the remote calls its default; a checkout
    // whose branch the machine could not read is the same unknown, and
    // switching from one nobody can name is not something to offer (D-21).
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
    const held = branchesHeldNearby(workspaces, pick.resourceId, runnerId);
    // The primary's own branches, plus whatever a live worktree of the same
    // repo on the same machine is sitting on, the latter dimmed - checking one
    // of those out twice is what git itself refuses.
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

  const baseOf = (resourceId: string, picked?: string): string | null =>
    picked ?? baseBranchOf(workspaces, resourceId, runnerId);

  // A base per repo is post-v1, so a multi-repo worktree reads the bases it
  // will use side by side and takes no pick. A repo nothing has cloned has no
  // base to name, and naming the placeholder as if it were a branch would be a
  // lie, so the whole reading steps back to what it can honestly say.
  if (pick.checkouts.length !== 1) {
    const bases = pick.checkouts.map((each) => baseOf(each.resourceId, each.baseBranch));
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
  const base = baseOf(only.resourceId, only.baseBranch);
  const checkout = readyPrimary(workspaces, only.resourceId, runnerId)?.checkouts[0];
  const defaultBranch = baseBranchOf(workspaces, only.resourceId, runnerId);
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
            { text: "hydra/run-…", mono: true },
            { text: ", named after the thread, and starts from " },
            { text: `origin/${base}`, mono: true },
            { text: " when the remote has it." },
          ],
  };
};
