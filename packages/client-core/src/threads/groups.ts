/**
 * Groups the sidebar's threads by project, and inside a project by workspace
 * (spec 14 §App shell, amended by #160 and #72).
 *
 * - Projects are sorted newest first by the latest thread in their first
 *   workspace group. The draft's project comes first, and the threads with
 *   no project come last.
 * - Inside a project, worktrees come first in catalog order, then the main
 *   workspace, then the threads with no workspace (see `rankLane`).
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
  type WorkspaceLabel,
} from "./workspaces";

export interface WorkspaceGroup {
  readonly workspaceId: string | null;
  /**
   * The group's label, such as `hercule/thread-3f1`, `webshop · moss` or `no
   * workspace`, split into the two parts a narrow sidebar truncates
   * separately. `null` for the no-workspace group when it is the project's
   * only group (the label tells groups apart, and there is nothing to tell
   * apart), or when it holds only the draft.
   */
  readonly label: WorkspaceLabel | null;
  /** Whether the draft being written joins this group. */
  readonly draft: boolean;
  readonly rows: readonly ThreadRow[];
}

export interface ProjectGroup {
  readonly projectId: string | null;
  /** `null` for the threads that belong to no project: they have no header. */
  readonly name: string | null;
  /** The identity hue of the project's dot, or `null` when there is no header. */
  readonly tone: ProjectTone | null;
  readonly count: number;
  readonly workspaces: readonly WorkspaceGroup[];
}

/** Where the draft being written will go, from the address it was opened at. */
export interface DraftPlace {
  readonly projectId: string | null;
  readonly workspaceId: string | null;
}

/**
 * Returns the group the draft being written belongs to.
 *
 * - When the address names a workspace, the draft goes there.
 * - Otherwise the draft will open in the project's default workspace
 *   (`decideDefaultWorkspacePick`). If that is a main workspace already
 *   cloned on the draft's runner, the draft joins that workspace's group,
 *   next to the threads it will sit beside, not under "no workspace".
 * - If the main workspace is not cloned yet, it has no group, so the draft
 *   sits directly under the project until the runner has cloned it.
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
  if (workspaceId !== null || projectId === null) return { projectId, workspaceId };
  const pick = decideDefaultWorkspacePick(listProjectRepos(resources, projectId), preferred);
  if (pick.kind !== "primary") return { projectId, workspaceId: null };
  return {
    projectId,
    workspaceId: findReadyPrimary(workspaces, pick.resourceId, runnerId)?.id ?? null,
  };
};

/** Checks whether the draft being written joins this group. */
const holdsDraft = (
  draft: DraftPlace | null,
  joins: boolean,
  workspaceId: string | null,
): boolean => draft !== null && joins && draft.workspaceId === workspaceId;

const readRecency = (rows: readonly ThreadRow[]): number =>
  rows.length === 0 ? 0 : Date.parse(rows[0]!.activityAt);

/**
 * Returns a group's sort rank inside its project: the draft's own group with no
 * workspace first, then each worktree in catalog order, then the main
 * workspace, then the threads that work without a checkout.
 */
const rankLane = (lane: WorkspaceGroup, workspaces: readonly Workspace[]): number => {
  if (lane.workspaceId === null) return lane.draft ? -1 : workspaces.length + 2;
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

  const byProject = new Map<string | null, ThreadRow[]>();
  for (const row of rows) {
    const projectId = sessionsById.get(row.id)?.projectId ?? null;
    byProject.set(projectId, [...(byProject.get(projectId) ?? []), row]);
  }
  // The draft's project is shown even when it has no threads yet.
  if (draft !== null && !byProject.has(draft.projectId)) byProject.set(draft.projectId, []);

  const groups = [...byProject].map(([projectId, held]): ProjectGroup => {
    const byWorkspace = new Map<string | null, ThreadRow[]>();
    for (const row of held) {
      const workspaceId = sessionsById.get(row.id)?.workspaceId ?? null;
      byWorkspace.set(workspaceId, [...(byWorkspace.get(workspaceId) ?? []), row]);
    }
    const joins = draft !== null && draft.projectId === projectId;
    if (joins && !byWorkspace.has(draft.workspaceId)) byWorkspace.set(draft.workspaceId, []);

    const alone = byWorkspace.size === 1;
    const lanes = [...byWorkspace].map(([workspaceId, rowsIn]): WorkspaceGroup => {
      const workspace = workspaces.find((each) => each.id === workspaceId);
      return {
        workspaceId,
        // "no workspace" labels the threads that work without a checkout. A
        // group that holds only the draft is different: the draft sits there
        // until it has a workspace, directly under the project's header, with
        // no label.
        label:
          workspace === undefined
            ? alone || (holdsDraft(draft, joins, workspaceId) && rowsIn.length === 0)
              ? null
              : { clip: "no workspace", keep: "" }
            : buildWorkspaceLabelParts(workspace, resources, runners),
        draft: holdsDraft(draft, joins, workspaceId),
        rows: rowsIn,
      };
    });

    return {
      projectId,
      name: projects.find((each) => each.id === projectId)?.name ?? null,
      tone: projectId === null ? null : pickProjectTone(projectId, projects),
      count: held.length,
      // The prototype's order: the worktrees first, in catalog order, then the
      // repo's main workspace, then the threads that work without a checkout.
      // A draft with no workspace yet is not in that last group: it sits
      // directly under the project's header, before everything, because that
      // is where the user just started it.
      workspaces: lanes.sort((a, b) => rankLane(a, workspaces) - rankLane(b, workspaces)),
    };
  });

  return groups.sort(
    (a, b) =>
      Number(a.projectId === null) - Number(b.projectId === null) ||
      Number(b.projectId === draft?.projectId) - Number(a.projectId === draft?.projectId) ||
      readRecency(b.workspaces[0]?.rows ?? []) - readRecency(a.workspaces[0]?.rows ?? []),
  );
};
