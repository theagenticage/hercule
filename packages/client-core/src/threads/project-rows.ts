/**
 * Lists the desktop sidebar's threads: one flat list per project, with no
 * workspace groups, each row naming its workspace, machine, branch and
 * provider so the row and its hover card can show them.
 *
 * The desktop sorts threads, and projects, by when each thread last started:
 * created, or reopened after it was marked Done, whichever is later. It does
 * not sort by latest activity, so a row stays where it is while its thread
 * works. Sorted by latest activity, rows jumped every time a thread did
 * something, which made the sidebar hard to read and to click. A reopened
 * thread climbs to the top of its project, because reopening is the user
 * picking it up again.
 *
 * The web app keeps the grouping of `buildThreadGroups` (spec 14 §App shell).
 */
import {
  THREAD_BRANCH_PREFIX,
  type ProviderInstance,
  type Resource,
  type Runner,
  type Session,
  type Workspace,
} from "@hercule/contract";
import type { ProjectGroup } from "./groups";
import type { ThreadRow } from "./rows";
import { describeThreadPlace } from "./thread-place";
import { isMarkedDone } from "./status";
import { buildWorkspaceLabelParts, type WorkspaceLabel } from "./workspaces";

/** A thread's row in a project's flat list, with the details its hover card shows. */
export interface ProjectRow extends ThreadRow {
  /** When the thread last started, created or reopened, as `pickLastStartedAt` returns it. The list is sorted by it. */
  readonly lastStartedAt: string;
  /** Where the thread works, as the row's second line shows it: `buildThreadPlaceLabel`'s answer. */
  readonly placeLabel: WorkspaceLabel;
  /** The name of the machine the thread runs on, or `null` when the runner list does not hold it. */
  readonly machine: string | null;
  /** The branch of the workspace's first checkout, or `null` when there is no workspace or no known branch. */
  readonly branch: string | null;
  /** The provider of the thread's instance, such as `claude-code`, or `null` when the instance is unknown. */
  readonly providerId: string | null;
  /** Where the thread works, in words, as `describeThreadPlace` returns it, for the row's accessible description. */
  readonly placeDescription: string;
}

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
 * Compares two rows so that sorting puts the one that last started most
 * recently first, and two rows that started at the same moment in session id order. The id breaks ties
 * so the order never depends on the order the server listed the sessions in.
 */
const compareByLastStartNewestFirst = (a: ProjectRow, b: ProjectRow): number =>
  Date.parse(b.lastStartedAt) - Date.parse(a.lastStartedAt) ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Returns the rows of every workspace group in `group`, as one list sorted by
 * `compareByLastStartNewestFirst`. `group` may be a capped `ProjectSection`; only the
 * rows it holds are listed.
 *
 * `sessions` holds each thread's session by id. A row whose session is not in
 * `sessions` is left out. That does not happen in practice, because the rows
 * are built from the same sessions.
 */
export const listProjectRows = ({
  group,
  sessions,
  workspaces,
  resources,
  runners,
  instances,
}: {
  readonly group: ProjectGroup;
  readonly sessions: ReadonlyMap<string, Session>;
  readonly workspaces: readonly Workspace[];
  readonly resources: readonly Resource[];
  readonly runners: readonly Runner[];
  readonly instances: readonly ProviderInstance[];
}): readonly ProjectRow[] => {
  const workspacesById = new Map(workspaces.map((each) => [each.id, each]));
  const runnersById = new Map(runners.map((each) => [each.id, each]));
  const instancesById = new Map(instances.map((each) => [each.id, each]));
  return group.workspaces
    .flatMap((lane) => lane.rows)
    .flatMap((row): ProjectRow[] => {
      const session = sessions.get(row.id);
      if (session === undefined) return [];
      const workspace =
        session.workspaceId === null ? undefined : workspacesById.get(session.workspaceId);
      const machine = runnersById.get(session.runnerId)?.name ?? null;
      const branch = workspace?.checkouts[0]?.branch ?? null;
      return [
        {
          ...row,
          lastStartedAt: pickLastStartedAt(session),
          placeLabel: buildThreadPlaceLabel({ workspace, branch, machine, resources, runners }),
          machine,
          branch,
          providerId: instancesById.get(session.instanceId)?.providerId ?? null,
          placeDescription: describeThreadPlace({
            projectName: group.name,
            workspace:
              workspace === undefined
                ? null
                : {
                    kind: workspace.kind,
                    name: buildWorkspaceLabelParts(workspace, resources, runners).clip,
                  },
            machine,
            branch,
          }),
        },
      ];
    })
    .sort(compareByLastStartNewestFirst);
};

/**
 * Returns the time, in milliseconds, at which the thread that last started
 * most recently in any of the group's workspace groups started, or 0 when the group has
 * none. A row whose session is not in `sessions` is not counted.
 */
const findLatestStartInGroup = (
  group: ProjectGroup,
  sessions: ReadonlyMap<string, Session>,
): number =>
  group.workspaces.reduce(
    (newest, lane) =>
      lane.rows.reduce((max, row) => {
        const session = sessions.get(row.id);
        return session === undefined ? max : Math.max(max, Date.parse(pickLastStartedAt(session)));
      }, newest),
    0,
  );

/** Compares two project ids so that sorting puts them in ascending order. */
const compareProjectIds = (a: string | null, b: string | null): number =>
  a === b ? 0 : (a ?? "") < (b ?? "") ? -1 : 1;

/**
 * Compares two projects so that sorting puts the one whose newest thread
 * started most recently first, and two projects whose newest threads started
 * at the same moment in project id order. `newest` is a time in
 * milliseconds, as `findLatestStartInGroup` returns it. The sidebar's order
 * and `orderProjectIdsByNewestThread` both end in this comparison, so the
 * two cannot drift apart.
 */
const compareByNewestStartThenProjectId = (
  a: { readonly newest: number; readonly projectId: string | null },
  b: { readonly newest: number; readonly projectId: string | null },
): number => b.newest - a.newest || compareProjectIds(a.projectId, b.projectId);

/** Checks whether the draft being written sits in one of the project group's workspace groups. */
export const holdsDraft = (group: ProjectGroup): boolean =>
  group.workspaces.some((lane) => lane.draft);

/**
 * Returns `groups` sorted for the desktop sidebar:
 *
 * - the threads with no project last, even when they hold the draft, as
 *   `buildThreadGroups` sorts them;
 * - otherwise, the group that holds the draft being written first;
 * - otherwise, by when the group's thread that started last started,
 *   newest first. A group with no threads counts as started at time 0.
 *
 * Groups whose newest threads started at the same moment are sorted by
 * project id. They do not keep the order they came in, because
 * `buildThreadGroups` sorts by latest activity, and a tie would then move
 * the projects whenever a thread works. `groups` must be the uncapped
 * groups from `buildThreadGroups`, because a capped section may hide its
 * newest thread. `sessions` holds each thread's session by id.
 */
export const sortProjectsByNewestThread = (
  groups: readonly ProjectGroup[],
  sessions: ReadonlyMap<string, Session>,
): readonly ProjectGroup[] =>
  groups
    .map((group) => ({
      group,
      projectId: group.projectId,
      newest: findLatestStartInGroup(group, sessions),
    }))
    .sort(
      (a, b) =>
        Number(a.projectId === null) - Number(b.projectId === null) ||
        Number(holdsDraft(b.group)) - Number(holdsDraft(a.group)) ||
        compareByNewestStartThenProjectId(a, b),
    )
    .map(({ group }) => group);

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
 * written to the top (`sortProjectsByNewestThread`). This order is for the
 * lists of other screens, and they should not reorder their project groups
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
    .sort(compareByNewestStartThenProjectId)
    .map(({ projectId }) => projectId);
};
