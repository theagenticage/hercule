/**
 * Groups the sidebar's threads by project, and inside a project by workspace
 * (spec 14 §App shell, amended by #160 and #72).
 *
 * - Projects are sorted newest first by their latest thread, in any of their
 *   workspace groups. The draft's project comes first, and the threads with
 *   no project come last.
 * - A thread whose project is not in the project list joins the threads with
 *   no project, and so does the draft being written for such a project. That
 *   happens to a deleted project, whose threads keep its id, and briefly to a
 *   project created since the list was read. Without a name the group has
 *   nothing to title it, and an untitled group in the middle of the list
 *   would look like part of the project above it.
 * - Inside a project, worktrees come first in catalog order, then the main
 *   workspace, then the threads with no workspace (see `rankLane`).
 * - The threads with no project are not split by workspace. They form one
 *   workspace group with no label, newest first. The web app draws no header
 *   above them, so a workspace label there would read as part of the project
 *   above. The desktop app draws a "No project" header, and keeps the one
 *   group so that both apps list these threads the same way.
 *
 * The draft being written joins the group it will belong to once it starts,
 * so the sidebar shows where a thread will go before it exists.
 */
import type {
  Project,
  ProviderInstance,
  Resource,
  Runner,
  Session,
  ThreadRows,
  ThreadWorkspace,
  Workspace,
} from "@hercule/contract";
import { buildThreadRows, type ThreadRow } from "./rows";
import { pickProjectTone, type ProjectTone } from "./tone";
import {
  decideDefaultWorkspacePick,
  listProjectRepos,
  findReadyPrimary,
  buildWorkspaceLabelParts,
  isJoinable,
  type WorkspaceLabel,
  type WorkspacePick,
} from "./workspaces";

export interface WorkspaceGroup {
  /**
   * Tells a project's groups apart, as a key for a list: the workspace's id,
   * `none` for the threads with no workspace, or `draft` for the group of a
   * draft whose workspace does not exist yet.
   */
  readonly key: string;
  /**
   * The workspace the group's threads are in. `null` for the threads with no
   * workspace, for the one group that holds every thread with no project, and
   * for the group of a draft whose workspace does not exist yet.
   */
  readonly workspaceId: string | null;
  /**
   * The group's label, such as `hercule/thread-3f1`, `webshop · moss` or `no
   * workspace`, split into the two parts a narrow sidebar truncates
   * separately. `null`:
   *
   * - for the no-workspace group when it is the project's only group, because
   *   the label tells groups apart and there is nothing to tell apart;
   * - for a group that holds only the draft;
   * - for the one group of the threads with no project, which is not split
   *   by workspace.
   */
  readonly label: WorkspaceLabel | null;
  /**
   * Whether a new thread can join the group's workspace, see `isJoinable`.
   * Always `false` for a group with no workspace.
   */
  readonly joinable: boolean;
  /** Whether the draft being written joins this group. */
  readonly draft: boolean;
  readonly rows: readonly ThreadRow[];
}

export interface ProjectGroup {
  readonly projectId: string | null;
  /** `null` for the one group of the threads that belong to no project. */
  readonly name: string | null;
  /**
   * The identity hue of the project's dot, or `null` for the threads that
   * belong to no project, which have no hue.
   */
  readonly tone: ProjectTone | null;
  readonly count: number;
  readonly workspaces: readonly WorkspaceGroup[];
}

/** Where the draft being written will go, from the address it was opened at. */
export interface DraftPlace {
  readonly projectId: string | null;
  /**
   * The workspace the thread opens in, when that workspace exists already.
   * `null` when the thread works with no workspace, or creates its workspace
   * as it starts.
   */
  readonly workspaceId: string | null;
  /**
   * Whether the thread creates its workspace as it starts: a new worktree, or
   * a main workspace its runner has not cloned yet. Until then the draft has
   * a group of its own.
   */
  readonly createsWorkspace: boolean;
}

/**
 * Returns the group the draft being written belongs to.
 *
 * - When the address names a workspace, the draft goes there.
 * - Otherwise the draft will open in the project's default workspace
 *   (`decideDefaultWorkspacePick`), and goes where `decideDraftPlaceForPick`
 *   puts that pick.
 */
export const decideDraftPlace = ({
  projectId,
  workspaceId,
  resources,
  workspaces,
  runnerId,
  preferred = null,
}: {
  readonly projectId: string | null;
  /** The workspace the address names, if any. */
  readonly workspaceId: string | null;
  readonly resources: readonly Resource[];
  readonly workspaces: readonly Workspace[];
  /** The runner the draft would run on. A main workspace exists on one runner. */
  readonly runnerId: string | null;
  readonly preferred?: ThreadWorkspace | null;
}): DraftPlace => {
  if (projectId === null) return { projectId, workspaceId, createsWorkspace: false };
  const pick: WorkspacePick =
    workspaceId === null
      ? decideDefaultWorkspacePick(listProjectRepos(resources, projectId), preferred)
      : { kind: "existing", workspaceId };
  return decideDraftPlaceForPick({ projectId, pick, workspaces, runnerId });
};

/**
 * Returns the group a draft in a project belongs to, once its workspace pick
 * is known:
 *
 * - an existing workspace: that workspace's group;
 * - a main workspace already cloned on the draft's runner: that workspace's
 *   group;
 * - no workspace: the group of the threads with no workspace;
 * - a new worktree, or a main workspace the runner has not cloned yet: a
 *   group of its own, because the workspace does not exist until the thread
 *   starts.
 *
 * An app that lets the user change the pick before the thread starts calls
 * this, so the sidebar follows the pick.
 */
export const decideDraftPlaceForPick = ({
  projectId,
  pick,
  workspaces,
  runnerId,
}: {
  readonly projectId: string;
  readonly pick: WorkspacePick;
  readonly workspaces: readonly Workspace[];
  /** The runner the draft would run on. A main workspace exists on one runner. */
  readonly runnerId: string | null;
}): DraftPlace => {
  switch (pick.kind) {
    case "existing":
      return { projectId, workspaceId: pick.workspaceId, createsWorkspace: false };
    case "primary": {
      const cloned = findReadyPrimary(workspaces, pick.resourceId, runnerId);
      return {
        projectId,
        workspaceId: cloned?.id ?? null,
        createsWorkspace: cloned === undefined,
      };
    }
    case "ephemeral":
      return { projectId, workspaceId: null, createsWorkspace: true };
    case "none":
      return { projectId, workspaceId: null, createsWorkspace: false };
  }
};

/** Checks whether the draft being written joins the group of the threads in `workspaceId`. */
const holdsDraft = (
  draft: DraftPlace | null,
  joins: boolean,
  workspaceId: string | null,
): boolean =>
  draft !== null && joins && !draft.createsWorkspace && draft.workspaceId === workspaceId;

/**
 * Returns the time of a project group's latest thread, in any of its
 * workspace groups, or 0 when it has none. Each workspace group's rows are
 * sorted newest first, so its first row is its latest.
 */
const findLatestActivity = (group: ProjectGroup): number =>
  Math.max(
    0,
    ...group.workspaces.map((lane) =>
      lane.rows.length === 0 ? 0 : Date.parse(lane.rows[0]!.activityAt),
    ),
  );

/**
 * Returns the project a thread or the draft is grouped under: its own
 * project when `listed` holds that project's id, and `null`, the threads
 * with no project, otherwise.
 */
const decideGroupProjectId = (
  projectId: string | null,
  listed: ReadonlySet<string>,
): string | null => (projectId !== null && listed.has(projectId) ? projectId : null);

/**
 * Returns the sort rank of a group of threads inside its project: each
 * worktree in catalog order, then the main workspace, then the threads that
 * work without a checkout.
 */
const rankLane = (lane: WorkspaceGroup, workspaces: readonly Workspace[]): number => {
  if (lane.workspaceId === null) return workspaces.length + 2;
  const workspace = workspaces.find((each) => each.id === lane.workspaceId);
  if (workspace === undefined || workspace.kind === "primary") return workspaces.length + 1;
  return workspaces.findIndex((each) => each.id === lane.workspaceId);
};

/**
 * Returns the sidebar's project groups, each with its workspace groups, sorted
 * as described at the top of this file.
 */
export const buildThreadGroups = ({
  sessions,
  projects,
  workspaces,
  resources,
  runners,
  instances = [],
  mode,
  draft = null,
}: {
  readonly sessions: readonly Session[];
  readonly projects: readonly Project[];
  readonly workspaces: readonly Workspace[];
  readonly resources: readonly Resource[];
  readonly runners: readonly Runner[];
  /** The instances whose catalogs give a `meta` row its model name. */
  readonly instances?: readonly ProviderInstance[];
  readonly mode: ThreadRows;
  readonly draft?: DraftPlace | null;
}): readonly ProjectGroup[] => {
  // The sidebar lists Threads only. A session an Agent runs belongs to that
  // Agent: an assistant's session shows under Assistants, and a workflow
  // step's session under its run.
  const threads = sessions.filter((session) => session.agentId === null);
  const rows = buildThreadRows(threads, mode, instances);
  const sessionsById = new Map(threads.map((session) => [session.id, session]));
  const listedProjectIds = new Set(projects.map((each) => each.id));
  // A draft for a project the list does not hold joins the threads with no
  // project, as that project's threads do.
  const draftPlace =
    draft === null
      ? null
      : { ...draft, projectId: decideGroupProjectId(draft.projectId, listedProjectIds) };

  const byProject = new Map<string | null, ThreadRow[]>();
  for (const row of rows) {
    const projectId = decideGroupProjectId(
      sessionsById.get(row.id)?.projectId ?? null,
      listedProjectIds,
    );
    byProject.set(projectId, [...(byProject.get(projectId) ?? []), row]);
  }
  // The draft's project is shown even when it has no threads yet.
  if (draftPlace !== null && !byProject.has(draftPlace.projectId))
    byProject.set(draftPlace.projectId, []);

  const groups = [...byProject].map(([projectId, held]): ProjectGroup => {
    const joins = draftPlace !== null && draftPlace.projectId === projectId;
    const header = {
      projectId,
      name: projects.find((each) => each.id === projectId)?.name ?? null,
      tone: projectId === null ? null : pickProjectTone(projectId, projects),
      count: held.length,
    };
    if (projectId === null) {
      return {
        ...header,
        workspaces: [
          {
            key: "none",
            workspaceId: null,
            label: null,
            joinable: false,
            draft: joins,
            rows: held,
          },
        ],
      };
    }

    const byWorkspace = new Map<string | null, ThreadRow[]>();
    for (const row of held) {
      const workspaceId = sessionsById.get(row.id)?.workspaceId ?? null;
      byWorkspace.set(workspaceId, [...(byWorkspace.get(workspaceId) ?? []), row]);
    }
    const createsWorkspace = joins && draftPlace.createsWorkspace;
    if (joins && !createsWorkspace && !byWorkspace.has(draftPlace.workspaceId))
      byWorkspace.set(draftPlace.workspaceId, []);

    // A draft whose workspace does not exist yet has a group of its own, with
    // no label, directly under the project's header, because that is where
    // the user just started it.
    const draftLanes: WorkspaceGroup[] = createsWorkspace
      ? [{ key: "draft", workspaceId: null, label: null, joinable: false, draft: true, rows: [] }]
      : [];
    const alone = byWorkspace.size + draftLanes.length === 1;
    const lanes = [...byWorkspace].map(([workspaceId, rowsIn]): WorkspaceGroup => {
      const workspace = workspaces.find((each) => each.id === workspaceId);
      return {
        key: workspaceId ?? "none",
        workspaceId,
        // "no workspace" labels the threads that work without a checkout.
        label:
          workspace === undefined
            ? alone
              ? null
              : { clip: "no workspace", keep: "" }
            : buildWorkspaceLabelParts(workspace, resources, runners),
        joinable: isJoinable(workspace),
        draft: holdsDraft(draftPlace, joins, workspaceId),
        rows: rowsIn,
      };
    });

    return {
      ...header,
      // The prototype's order: the worktrees first, in catalog order, then the
      // repo's main workspace, then the threads that work without a checkout.
      workspaces: [
        ...draftLanes,
        ...lanes.sort((a, b) => rankLane(a, workspaces) - rankLane(b, workspaces)),
      ],
    };
  });

  return groups.sort(
    (a, b) =>
      Number(a.projectId === null) - Number(b.projectId === null) ||
      Number(b.projectId === draftPlace?.projectId) -
        Number(a.projectId === draftPlace?.projectId) ||
      findLatestActivity(b) - findLatestActivity(a),
  );
};
