/**
 * Lists the desktop sidebar's threads: one flat list per project, with no
 * workspace groups, each row naming its workspace, machine, branch and
 * provider so the row and its hover card can show them.
 *
 * The desktop sorts threads, and projects, by when each thread was created,
 * not by its latest activity. A row then stays where it is while its thread
 * works. Sorted by latest activity, rows jumped every time a thread did
 * something, which made the sidebar hard to read and to click.
 *
 * The web app keeps the grouping of `buildThreadGroups` (spec 14 §App shell).
 */
import type { ProviderInstance, Resource, Runner, Session, Workspace } from "@hercule/contract";
import type { ProjectGroup } from "./groups";
import type { ThreadRow } from "./rows";
import { describeThreadPlace } from "./thread-place";
import { buildWorkspaceLabelParts, type WorkspaceLabel } from "./workspaces";

/** A thread's row in a project's flat list, with the details its hover card shows. */
export interface ProjectRow extends ThreadRow {
  /** When the thread's session was created. The list is sorted by it. */
  readonly createdAt: string;
  /** The thread's workspace, or "No workspace" when it has none or the workspace list does not hold it. */
  readonly workspace: WorkspaceLabel;
  /** The name of the machine the thread runs on, or `null` when the runner list does not hold it. */
  readonly machine: string | null;
  /** The branch of the workspace's first checkout, or `null` when there is no workspace or no known branch. */
  readonly branch: string | null;
  /** The provider of the thread's instance, such as `claude-code`, or `null` when the instance is unknown. */
  readonly providerId: string | null;
  /** Where the thread works, in words, as `describeThreadPlace` returns it, for the row's accessible description. */
  readonly placeDescription: string;
}

const NO_WORKSPACE: WorkspaceLabel = { clip: "No workspace", keep: "" };

/**
 * Compares two entries, each a session's creation time and its session id,
 * so that sorting puts the newest first, and two entries created at the same
 * moment in session id order. The id breaks ties so the order never depends
 * on the order the server listed the sessions in.
 */
const compareNewestCreated = (
  a: { readonly createdAt: string; readonly id: string },
  b: { readonly createdAt: string; readonly id: string },
): number =>
  Date.parse(b.createdAt) - Date.parse(a.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Returns the rows of every workspace group in `group`, as one list sorted by
 * `compareNewestCreated`. `group` may be a capped `ProjectSection`; only the
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
      const label =
        workspace === undefined
          ? NO_WORKSPACE
          : buildWorkspaceLabelParts(workspace, resources, runners);
      const machine = runnersById.get(session.runnerId)?.name ?? null;
      const branch = workspace?.checkouts[0]?.branch ?? null;
      return [
        {
          ...row,
          createdAt: session.createdAt,
          workspace: label,
          machine,
          branch,
          providerId: instancesById.get(session.instanceId)?.providerId ?? null,
          placeDescription: describeThreadPlace({
            projectName: group.name,
            workspace: workspace === undefined ? null : { kind: workspace.kind, name: label.clip },
            machine,
            branch,
          }),
        },
      ];
    })
    .sort(compareNewestCreated);
};

/**
 * Returns the creation time, in milliseconds, of the newest thread in any of
 * the group's workspace groups, or 0 when the group has none. A row whose
 * session is not in `sessions` is not counted.
 */
const findNewestCreated = (group: ProjectGroup, sessions: ReadonlyMap<string, Session>): number =>
  group.workspaces.reduce(
    (newest, lane) =>
      lane.rows.reduce((max, row) => {
        const createdAt = sessions.get(row.id)?.createdAt;
        return createdAt === undefined ? max : Math.max(max, Date.parse(createdAt));
      }, newest),
    0,
  );

/** Checks whether the draft being written sits in one of the project group's workspace groups. */
export const holdsDraft = (group: ProjectGroup): boolean =>
  group.workspaces.some((lane) => lane.draft);

/**
 * Returns `groups` sorted for the desktop sidebar:
 *
 * - the threads with no project last, even when they hold the draft, as
 *   `buildThreadGroups` sorts them;
 * - otherwise, the group that holds the draft being written first;
 * - otherwise, by the creation time of the group's newest thread, newest
 *   first. A group with no threads counts as created at time 0.
 *
 * Groups that tie keep the order they came in. `groups` must be the uncapped
 * groups from `buildThreadGroups`, because a capped section may hide its
 * newest thread. `sessions` holds each thread's session by id.
 */
export const sortProjectsByNewestThread = (
  groups: readonly ProjectGroup[],
  sessions: ReadonlyMap<string, Session>,
): readonly ProjectGroup[] =>
  groups
    .map((group) => ({ group, newest: findNewestCreated(group, sessions) }))
    .sort(
      (a, b) =>
        Number(a.group.projectId === null) - Number(b.group.projectId === null) ||
        Number(holdsDraft(b.group)) - Number(holdsDraft(a.group)) ||
        b.newest - a.newest,
    )
    .map(({ group }) => group);
