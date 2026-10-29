/** Builds choices for a new workspace's Git source and shows existing files' observed branch. */
import type { ResourceBranches, StartingRevision, Workspace } from "@hercule/contract";
import { readErrorMessage } from "../errors";
import { buildStartingRevisionKey, describeStartingRevision } from "../starting-revision";
import { findPrimaryWorkspace, type Phrase, type WorkspacePick } from "./workspaces";

export interface BranchRow {
  readonly key: string;
  readonly label: string;
  readonly startingRevision: StartingRevision;
  readonly badge: "current" | "default" | null;
  /** Why this source cannot currently be used. */
  readonly dimmed: string | null;
}

export interface BranchField {
  readonly header: string;
  readonly note: string;
  readonly label: string;
  /** The key of the selected source row. */
  readonly value: string;
  readonly glyph: boolean;
  /** Why the field is shown as text rather than a menu. */
  readonly locked: string | null;
  /**
   * The choices that need no branch list: the current working copy and the
   * remote default. The branches themselves come from `search`.
   */
  readonly rows: readonly BranchRow[];
  /**
   * The repo and runner whose branches the open menu reads with
   * `resource.listBranches`, or null when the menu offers only `rows`. A
   * repository can have tens of thousands of branches, so the menu reads
   * them live, filtered by what the user types, instead of storing them.
   */
  readonly search: BranchSearch | null;
  readonly foot: readonly Phrase[] | null;
}

/**
 * How many branches of each kind the starting revision menu lists. A longer
 * list is cut, and the menu asks the user to type more of the name.
 */
export const MENU_BRANCHES_PER_KIND = 20;

/**
 * How long the menu's filter text must stay unchanged before the menu reads
 * the branches again, so typing a name sends one read, not one per key.
 */
export const BRANCH_SEARCH_DELAY_MS = 200;

/** The repo and the runner whose branches the starting revision menu lists. */
export interface BranchSearch {
  readonly resourceId: string;
  readonly runnerId: string;
}

/** What the menu has of the live branch list: still reading it, the read failed, or the answer. */
export type BranchListing =
  | { readonly status: "reading" }
  | { readonly status: "failed"; readonly message: string }
  | { readonly status: "read"; readonly branches: ResourceBranches };

/** The branch rows of the starting revision menu, and the line under them. */
export interface BranchListRows {
  readonly rows: readonly BranchRow[];
  /** Why the rows are empty or incomplete, or null when they are the whole answer. */
  readonly note: string | null;
}

/** Returns the explicit revision or the selected source's default without using another runner's refs. */
const readStartingRevision = (
  checkout: Extract<WorkspacePick, { kind: "ephemeral" }>["checkouts"][number],
  source: Workspace | undefined,
): StartingRevision =>
  checkout.startingRevision ??
  (checkout.baseBranch === undefined
    ? source?.ownership === "adopted"
      ? { kind: "current" }
      : { kind: "remote" }
    : { kind: "remote", branch: checkout.baseBranch });

/** Returns a row whose identity preserves the selected source kind. */
const buildRevisionRow = (
  startingRevision: StartingRevision,
  label: string,
  badge: BranchRow["badge"],
  dimmed: string | null,
): BranchRow => ({
  key: buildStartingRevisionKey(startingRevision),
  label,
  startingRevision,
  badge,
  dimmed,
});

/** Returns the revision menu for new files, or a locked observed branch for shared main files. */
export const buildBranchField = (
  pick: WorkspacePick,
  {
    workspaces,
    runnerId,
  }: { readonly workspaces: readonly Workspace[]; readonly runnerId: string | null },
): BranchField | null => {
  if (pick.kind === "none" || pick.kind === "existing") return null;
  if (pick.kind === "primary") {
    const source = findPrimaryWorkspace(workspaces, pick.resourceId, runnerId);
    const branch = source?.checkouts.find(
      (checkout) => checkout.resourceId === pick.resourceId,
    )?.branch;
    return {
      header: "Branch",
      note: "existing files keep their branch",
      label: branch ?? "Not observed",
      value: "",
      glyph: branch != null,
      locked: source?.message ?? "Starting a Thread here leaves the branch unchanged",
      rows: [],
      search: null,
      foot: null,
    };
  }
  if (pick.checkouts.length !== 1) {
    const revisions = pick.checkouts.map((checkout) =>
      readStartingRevision(
        checkout,
        findPrimaryWorkspace(workspaces, checkout.resourceId, runnerId),
      ),
    );
    return {
      header: "Starting revision",
      note: "each new branch starts from its selected source",
      label: revisions.map(describeStartingRevision).join(" · "),
      value: "",
      glyph: false,
      locked: "Each repository uses the starting revision shown here",
      rows: [],
      search: null,
      foot: null,
    };
  }
  const only = pick.checkouts[0]!;
  const source = findPrimaryWorkspace(workspaces, only.resourceId, runnerId);
  const revision = readStartingRevision(only, source);
  const unavailable =
    source !== undefined && source.status !== "ready"
      ? (source.message ?? "Restore the selected source workspace before starting new work")
      : null;
  const noLocalSource =
    unavailable ??
    (source === undefined ? "Create or attach a local source on this machine first" : null);
  const rows = [
    buildRevisionRow({ kind: "current" }, "Current working copy", "current", noLocalSource),
    buildRevisionRow({ kind: "remote" }, "Remote default", "default", unavailable),
  ];
  return {
    header: "Starting revision",
    note: "the new branch starts from this source",
    label: describeStartingRevision(revision),
    value: buildStartingRevisionKey(revision),
    glyph: false,
    locked: null,
    rows,
    // Only a ready main workspace on this runner has branches to list. When
    // there is none, the rows above already say why nothing can be picked.
    search:
      source?.status === "ready"
        ? { resourceId: only.resourceId, runnerId: source.runnerId }
        : null,
    foot: [
      {
        text: "Current and local sources use this machine's committed Git state. Remote sources fetch before creating the new branch. Uncommitted edits stay in the original files.",
      },
    ],
  };
};

/**
 * Returns what the menu has of the live branch list, from the latest answer
 * of the read and its error. An answer counts first: while a new filter text
 * is read, the menu keeps the previous answer instead of going blank.
 */
export const buildBranchListing = (
  answer: ResourceBranches | undefined,
  error: unknown,
): BranchListing =>
  answer !== undefined
    ? { status: "read", branches: answer }
    : error !== null && error !== undefined
      ? { status: "failed", message: readErrorMessage(error) }
      : { status: "reading" };

/**
 * Builds the branch rows of the starting revision menu from the live branch
 * list: the local branches, then the remote ones, each newest first as the
 * runner sorted them. `text` is what the user typed to filter the list.
 *
 * The note under the rows says, in this order:
 *
 * - that the list is still being read, or why reading it failed;
 * - why the runner could not list branches;
 * - that no branch name contains `text`;
 * - that more branches match than are shown, so the user should type more.
 */
export const buildBranchListRows = (listing: BranchListing, text: string): BranchListRows => {
  if (listing.status === "reading") return { rows: [], note: "Reading branches…" };
  if (listing.status === "failed")
    return { rows: [], note: `Branches could not be read: ${listing.message}` };
  const { local, remote, more, unavailableReason } = listing.branches;
  const rows = [
    ...local.map((branch) =>
      buildRevisionRow({ kind: "local", branch }, `Local branch: ${branch}`, null, null),
    ),
    ...remote.map((branch) =>
      buildRevisionRow({ kind: "remote", branch }, `Remote branch: ${branch}`, null, null),
    ),
  ];
  const note =
    unavailableReason ??
    (rows.length === 0 && text !== ""
      ? `No branch name contains "${text}".`
      : more
        ? "More branches match. Type to narrow the list."
        : null);
  return { rows, note };
};
