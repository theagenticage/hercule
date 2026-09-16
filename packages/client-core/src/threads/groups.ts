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
import type { Project, Resource, Runner, Session, ThreadRows, Workspace } from "@hydra/contract";
import { threadRows, type ThreadRow } from "./rows";
import { workspaceLabel } from "./workspaces";

export interface WorkspaceGroup {
  readonly workspaceId: string | null;
  /**
   * `hydra/run-3f1`, `webshop checkout · moss`, or `no workspace` last. Null
   * on a project whose threads are all in no workspace: the label separates
   * one lane from another, and there is nothing there to separate.
   */
  readonly label: string | null;
  /** Whether the draft being written joins this group. */
  readonly draft: boolean;
  readonly rows: readonly ThreadRow[];
}

export interface ProjectGroup {
  readonly projectId: string | null;
  /** Null on the threads that belong to no project: they stand under no header. */
  readonly name: string | null;
  readonly count: number;
  readonly workspaces: readonly WorkspaceGroup[];
}

/** Where the draft being written is headed, as the address names it. */
export interface DraftPlace {
  readonly projectId: string | null;
  readonly workspaceId: string | null;
}

const recency = (rows: readonly ThreadRow[]): number =>
  rows.length === 0 ? 0 : Date.parse(rows[0]!.activityAt);

export const threadGroups = ({
  sessions,
  projects,
  workspaces,
  resources,
  runners,
  mode,
  draft = null,
}: {
  readonly sessions: readonly Session[];
  readonly projects: readonly Project[];
  readonly workspaces: readonly Workspace[];
  readonly resources: readonly Resource[];
  readonly runners: readonly Runner[];
  readonly mode: ThreadRows;
  readonly draft?: DraftPlace | null;
}): readonly ProjectGroup[] => {
  const rows = threadRows(sessions, mode);
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
        label:
          workspace === undefined
            ? alone
              ? null
              : "no workspace"
            : workspaceLabel(workspace, resources, runners),
        draft: draft !== null && joins && draft.workspaceId === workspaceId,
        rows: rowsIn,
      };
    });

    return {
      projectId,
      name: projects.find((each) => each.id === projectId)?.name ?? null,
      count: held.length,
      // The group the draft joins leads: it is where the user is working
      // right now, and it holds a row no clock has an activity stamp for.
      workspaces: lanes.sort(
        (a, b) =>
          Number(a.workspaceId === null) - Number(b.workspaceId === null) ||
          Number(b.draft) - Number(a.draft) ||
          recency(b.rows) - recency(a.rows),
      ),
    };
  });

  return groups.sort(
    (a, b) =>
      Number(a.projectId === null) - Number(b.projectId === null) ||
      Number(b.projectId === draft?.projectId) - Number(a.projectId === draft?.projectId) ||
      recency(b.workspaces[0]?.rows ?? []) - recency(a.workspaces[0]?.rows ?? []),
  );
};
