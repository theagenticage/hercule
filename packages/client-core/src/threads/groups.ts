/**
 * The Threads face's shape: threads grouped per project, and inside a project
 * per workspace (spec 14 §App shell, amended by #160 and by #72). Both
 * orderings follow activity, newest group first, with the two "and the rest"
 * groups pinned last - the threads of a project that are in no workspace, and
 * the threads that belong to no project at all.
 *
 * The draft being written joins the group it will belong to once it starts, so
 * the sidebar shows where a thread is going before it exists.
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
} from "@hydra/contract";
import { threadRows, type ThreadRow } from "./rows";
import { projectTone, type ProjectTone } from "./tone";
import {
  defaultWorkspacePick,
  projectRepos,
  readyPrimary,
  workspaceLabelParts,
  type WorkspaceLabel,
} from "./workspaces";

export interface WorkspaceGroup {
  readonly workspaceId: string | null;
  /**
   * `hydra/run-3f1`, `webshop · moss`, or `no workspace` last, in the
   * two parts a narrow sidebar cuts it in. Null on a project whose threads are
   * all in no workspace: the label separates one lane from another, and there
   * is nothing there to separate.
   */
  readonly label: WorkspaceLabel | null;
  /** Whether the draft being written joins this group. */
  readonly draft: boolean;
  readonly rows: readonly ThreadRow[];
}

export interface ProjectGroup {
  readonly projectId: string | null;
  /** Null on the threads that belong to no project: they stand under no header. */
  readonly name: string | null;
  /** The identity hue its dot wears; null where there is no header to wear one. */
  readonly tone: ProjectTone | null;
  readonly count: number;
  readonly workspaces: readonly WorkspaceGroup[];
}

/** Where the draft being written is headed, as the address names it. */
export interface DraftPlace {
  readonly projectId: string | null;
  readonly workspaceId: string | null;
}

/**
 * Which group the draft being written belongs to. The address settles it where
 * it names a workspace; where it names none, the draft will open in whatever
 * the project opens in (`defaultWorkspacePick`), and a main workspace that
 * already stands on the machine it would run on is a group of its own - the
 * draft is filed with the threads it will sit beside, not under "no
 * workspace". A checkout nothing has cloned yet is no group at all: the draft
 * stands under the project itself until the machine has made one.
 */
export const draftPlace = ({
  projectId,
  workspaceId,
  resources,
  workspaces,
  runnerId,
  preferred = null,
}: {
  readonly projectId: string | null;
  /** The workspace the address names, where it names one. */
  readonly workspaceId: string | null;
  readonly resources: readonly Resource[];
  readonly workspaces: readonly Workspace[];
  /** The machine the draft would run on; a primary stands on one machine. */
  readonly runnerId: string | null;
  readonly preferred?: ThreadWorkspace | null;
}): DraftPlace => {
  if (workspaceId !== null || projectId === null) return { projectId, workspaceId };
  const pick = defaultWorkspacePick(projectRepos(resources, projectId), preferred);
  if (pick.kind !== "primary") return { projectId, workspaceId: null };
  return {
    projectId,
    workspaceId: readyPrimary(workspaces, pick.resourceId, runnerId)?.id ?? null,
  };
};

/** Whether this lane is the one the draft being written joins. */
const holdsDraft = (
  draft: DraftPlace | null,
  joins: boolean,
  workspaceId: string | null,
): boolean => draft !== null && joins && draft.workspaceId === workspaceId;

const recency = (rows: readonly ThreadRow[]): number =>
  rows.length === 0 ? 0 : Date.parse(rows[0]!.activityAt);

/**
 * Where a lane stands among its project's: the draft's own place first, then
 * one place per worktree in catalog order, then the main workspace, then the
 * lane of threads that work without a checkout.
 */
const rank = (lane: WorkspaceGroup, workspaces: readonly Workspace[]): number => {
  if (lane.workspaceId === null) return lane.draft ? -1 : workspaces.length + 2;
  const workspace = workspaces.find((each) => each.id === lane.workspaceId);
  if (workspace === undefined || workspace.kind === "primary") return workspaces.length + 1;
  return workspaces.findIndex((each) => each.id === lane.workspaceId);
};

export const threadGroups = ({
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
  /** What a meta row names its model from. */
  readonly instances?: readonly ProviderInstance[];
  readonly mode: ThreadRows;
  readonly draft?: DraftPlace | null;
}): readonly ProjectGroup[] => {
  const rows = threadRows(sessions, mode, instances);
  const placeOf = new Map(sessions.map((session) => [session.id, session]));

  const byProject = new Map<string | null, ThreadRow[]>();
  for (const row of rows) {
    const projectId = placeOf.get(row.id)?.projectId ?? null;
    byProject.set(projectId, [...(byProject.get(projectId) ?? []), row]);
  }
  // A project the draft is headed for stands even while it holds no thread.
  if (draft !== null && !byProject.has(draft.projectId)) byProject.set(draft.projectId, []);

  const groups = [...byProject].map(([projectId, held]): ProjectGroup => {
    const byWorkspace = new Map<string | null, ThreadRow[]>();
    for (const row of held) {
      const workspaceId = placeOf.get(row.id)?.workspaceId ?? null;
      byWorkspace.set(workspaceId, [...(byWorkspace.get(workspaceId) ?? []), row]);
    }
    const joins = draft !== null && draft.projectId === projectId;
    if (joins && !byWorkspace.has(draft.workspaceId)) byWorkspace.set(draft.workspaceId, []);

    const alone = byWorkspace.size === 1;
    const lanes = [...byWorkspace].map(([workspaceId, rowsIn]): WorkspaceGroup => {
      const workspace = workspaces.find((each) => each.id === workspaceId);
      return {
        workspaceId,
        // "no workspace" names a lane of threads that work without a
        // checkout. A lane holding nothing but the draft is not that: it is
        // where the draft stands until it has a workspace, and it stands
        // under the project's own header with nothing said about it.
        label:
          workspace === undefined
            ? alone || (holdsDraft(draft, joins, workspaceId) && rowsIn.length === 0)
              ? null
              : { clip: "no workspace", keep: "" }
            : workspaceLabelParts(workspace, resources, runners),
        draft: holdsDraft(draft, joins, workspaceId),
        rows: rowsIn,
      };
    });

    return {
      projectId,
      name: projects.find((each) => each.id === projectId)?.name ?? null,
      tone: projectId === null ? null : projectTone(projectId, projects),
      count: held.length,
      // The prototype's own order: the worktrees first, in the order the
      // catalog lists them, then the repo's main workspace, then the threads
      // that work without a checkout. A draft that has no workspace at all yet
      // is not that last lane - it stands under the project's own header,
      // before everything, which is where the user just asked for it.
      workspaces: lanes.sort((a, b) => rank(a, workspaces) - rank(b, workspaces)),
    };
  });

  return groups.sort(
    (a, b) =>
      Number(a.projectId === null) - Number(b.projectId === null) ||
      Number(b.projectId === draft?.projectId) - Number(a.projectId === draft?.projectId) ||
      recency(b.workspaces[0]?.rows ?? []) - recency(a.workspaces[0]?.rows ?? []),
  );
};
