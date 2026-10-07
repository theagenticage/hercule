/** Builds choices for a new workspace's Git source and shows existing files' observed branch. */
import type { StartingRevision, Workspace } from "@hercule/contract";
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
  readonly rows: readonly BranchRow[];
  readonly foot: readonly Phrase[] | null;
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
      foot: null,
    };
  }
  const only = pick.checkouts[0]!;
  const source = findPrimaryWorkspace(workspaces, only.resourceId, runnerId);
  const checkout = source?.checkouts.find((each) => each.resourceId === only.resourceId);
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
    ...(checkout?.branches ?? []).map((branch) =>
      buildRevisionRow({ kind: "local", branch }, `Local branch: ${branch}`, null, noLocalSource),
    ),
    ...(checkout?.remoteBranches ?? []).map((branch) =>
      buildRevisionRow({ kind: "remote", branch }, `Remote branch: ${branch}`, null, unavailable),
    ),
  ];
  return {
    header: "Starting revision",
    note: "the new branch starts from this source",
    label: describeStartingRevision(revision),
    value: buildStartingRevisionKey(revision),
    glyph: false,
    locked: null,
    rows,
    foot: [
      {
        text: "Current and local sources use this machine's committed Git state. Remote sources fetch before creating the new branch. Uncommitted edits stay in the original files.",
      },
    ],
  };
};
