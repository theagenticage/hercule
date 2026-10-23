/**
 * Helpers for the desktop sidebar's rows: where a row's workspace is named,
 * when a thread last started, and the order of the projects.
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
import { isMarkedDone } from "./status";
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

/**
 * Returns the ids of the projects that hold threads, in the order the
 * desktop sidebar lists them: by when the project's newest thread started
 * (`pickLastStartedAt`), newest first, and projects that tie by project id.
 * The result is a plain array of ids, so a caller that reads it through
 * React Query's `select` keeps the same array while nothing changed.
 *
 * It counts the threads the sidebar counts and no others: a session with no
 * agent, not marked Done, that belongs to a project. A Done thread leaves
 * its project for the Done shelf, an Agent's session belongs to that Agent,
 * and a session with no project is in no project's list. A project with no
 * such thread is not in the result. The sidebar sorts those last, by project
 * id, and so should a caller that lists them.
 *
 * It ignores a Draft Thread on purpose. A draft is not a session until it
 * starts, and the sidebar moves the project that holds the draft being
 * written to the top. This order is for the lists of other screens, and they should not reorder their project groups
 * when the user opens or abandons a draft.
 *
 * It does not know which projects exist. The sidebar files the threads of a
 * deleted project under "No project", so a caller drops ids it does not
 * list, as `groupByProject` does.
 */
export const orderProjectIdsByNewestThread = (sessions: readonly Session[]): readonly string[] => {
  const newestByProject = new Map<string, number>();
  for (const session of sessions) {
    if (session.kind !== "thread" || isMarkedDone(session) || session.projectId === null) continue;
    const started = Date.parse(pickLastStartedAt(session));
    newestByProject.set(
      session.projectId,
      Math.max(newestByProject.get(session.projectId) ?? 0, started),
    );
  }
  return [...newestByProject]
    .map(([projectId, newest]) => ({ projectId, newest }))
    .sort(
      (a, b) =>
        b.newest - a.newest || (a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0),
    )
    .map(({ projectId }) => projectId);
};
