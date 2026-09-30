/**
 * Builds the label that names the workspace a started thread works in, as the
 * composer shows it under its card. A draft picks its workspace from the
 * workspace menu instead, see `buildWorkspaceMenu`.
 */
import type { Session, Workspace } from "@hercule/contract";

/** One piece of the label that names the workspace a started thread works in. */
export type ThreadWorkspaceLabelPiece =
  /** The kind of workspace, or that there is none. */
  | { readonly kind: "workspace"; readonly text: string }
  /** The branch checked out in the workspace. A branch is a git name, so it is always set in mono. */
  | {
      readonly kind: "branch";
      readonly text: string;
      /**
       * The words that name the branch an ephemeral workspace's branch was
       * started from, such as "from main", or `null` when that branch is not
       * known. Always `null` for a main workspace, which starts no branch of
       * its own.
       */
      readonly startedFrom: string | null;
    };

/** The piece that names a main workspace. */
const MAIN_WORKSPACE: ThreadWorkspaceLabelPiece = { kind: "workspace", text: "Main workspace" };

/**
 * Returns the pieces of the label that names the workspace `session` works in,
 * in the order they are shown:
 *
 * - a main workspace: "Main workspace", then the branch it is on;
 * - an ephemeral workspace: its branch, with the branch it was started from.
 *   An ephemeral workspace is named after its branch, so no second piece
 *   repeats the name;
 * - no workspace: "None", or "No workspace" when the thread has no project
 *   either, as the workspace menu calls it.
 *
 * An ephemeral workspace was started from the base branch the caller named,
 * or, when the caller named none, from its repo's default branch.
 *
 * A branch the runner has not reported is left out. An ephemeral workspace
 * with no branch, or a workspace whose record is not in `workspaces`, is
 * called "Workspace", so the label never claims the thread has no workspace.
 */
export const buildThreadWorkspaceLabel = (
  session: Session,
  workspaces: readonly Workspace[],
): readonly ThreadWorkspaceLabelPiece[] => {
  if (session.workspaceId === null)
    return [{ kind: "workspace", text: session.projectId === null ? "No workspace" : "None" }];
  const workspace = workspaces.find((each) => each.id === session.workspaceId);
  const checkout = workspace?.checkouts[0];
  const branch = checkout?.branch ?? null;
  if (workspace?.kind === "primary")
    return branch === null
      ? [MAIN_WORKSPACE]
      : [MAIN_WORKSPACE, { kind: "branch", text: branch, startedFrom: null }];
  if (checkout === undefined || branch === null) return [{ kind: "workspace", text: "Workspace" }];
  const base = checkout.baseBranch ?? checkout.defaultBranch;
  return [{ kind: "branch", text: branch, startedFrom: base === null ? null : `from ${base}` }];
};
