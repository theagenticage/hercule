/**
 * Helpers for the desktop sidebar's rows: where a row's workspace is named,
 * and when a thread last started.
 *
 * The desktop sorts by when each thread last started: created, or reopened
 * after it was marked Done, whichever is later. It does not sort by latest
 * activity, so a row stays where it is while its thread works. Sorted by
 * latest activity, rows jumped every time a thread did something, which made
 * the sidebar hard to read and to click.
 *
 * The web app keeps the grouping of `buildThreadGroups` (spec 14 §App shell).
 */
import {
  THREAD_BRANCH_PREFIX,
  type Resource,
  type Runner,
  type Session,
  type Workspace,
} from "@hercule/contract";
import { buildWorkspaceLabelParts, type WorkspaceLabel } from "./workspaces";

/** Matches the end of a generated branch name: the last hex digits of the session id. */
const SESSION_ID_TAIL = /^[0-9a-f]+$/;

/**
 * Checks whether `branch` is a name the controller generated for a thread's
 * new workspace, such as `hercule/thread-3f1`, rather than one a person
 * chose. Nobody chose such a name and it tells threads apart by nothing a
 * person knows, so a sidebar row never shows it.
 */
export const isGeneratedBranch = (branch: string): boolean =>
  branch.startsWith(THREAD_BRANCH_PREFIX) &&
  SESSION_ID_TAIL.test(branch.slice(THREAD_BRANCH_PREFIX.length));

/**
 * How many characters at the end of a branch name a row always shows. The
 * end of a branch name is the part that tells branches apart, such as
 * `fix-sidebar` in `rogier/fix-sidebar`, so a narrow row cuts the middle.
 */
const BRANCH_TAIL_LENGTH = 12;

/**
 * Returns when a thread last started: when its session was created, or when
 * it was last reopened after being marked Done, whichever is later.
 */
export const pickLastStartedAt = (session: Session): string =>
  session.reopenedAt !== undefined && Date.parse(session.reopenedAt) > Date.parse(session.createdAt)
    ? session.reopenedAt
    : session.createdAt;

/**
 * Returns where a thread works as its sidebar row's second line shows it, in
 * the two parts of a `WorkspaceLabel`: the part that may be cut short, then
 * the part that never is. A Draft Thread's row uses it too, so a draft's row
 * says what the thread's row will say once it starts. The first case that
 * applies decides:
 *
 * - a branch a person named, such as `rogier/fix-sidebar` or `main`: its
 *   last `BRANCH_TAIL_LENGTH` characters are kept, so the middle is cut;
 * - a main workspace: the repo and the machine, as `buildWorkspaceLabelParts`
 *   splits them;
 * - the machine the thread runs on, because the only other name the
 *   workspace has is the branch the controller generated;
 * - "No workspace" when the thread has none, or "unknown machine" when the
 *   runner list does not hold its machine.
 */
export const buildThreadPlaceLabel = ({
  workspace,
  branch,
  machine,
  resources,
  runners,
}: {
  readonly workspace: Workspace | undefined;
  readonly branch: string | null;
  readonly machine: string | null;
  readonly resources: readonly Resource[];
  readonly runners: readonly Runner[];
}): WorkspaceLabel => {
  if (branch !== null && !isGeneratedBranch(branch)) {
    const cut = Math.max(0, branch.length - BRANCH_TAIL_LENGTH);
    return { clip: branch.slice(0, cut), keep: branch.slice(cut) };
  }
  if (workspace?.kind === "primary") return buildWorkspaceLabelParts(workspace, resources, runners);
  if (machine !== null) return { clip: machine, keep: "" };
  return { clip: workspace === undefined ? "No workspace" : "unknown machine", keep: "" };
};
