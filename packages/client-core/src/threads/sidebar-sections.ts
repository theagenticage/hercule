/**
 * Decides which rows the sidebar shows when there are many, and how many more
 * each section hides behind its "more" row:
 *
 * - Waiting on you shows the first 3 entries of `listWaiting`: the most
 *   recently active threads and assistants, mixed.
 * - A project shows at most 5 threads. They are picked by priority: waiting
 *   threads first, then working ones, then the rest, and inside each of those
 *   tiers the newest first. The threads with no project are capped the same
 *   way.
 * - The selected thread is always shown in its project, even when it is not
 *   among the 5, so a project shows at most 6. Waiting on you makes no such
 *   exception, because the selected thread is always shown in its project.
 * - A section the user expanded shows every thread.
 *
 * Two threads with the same activity time are ordered by session id, so the
 * pick never depends on the order the server listed them in.
 *
 * A project's shown rows keep the order `buildThreadGroups` gives them, so
 * capping a project only removes rows, it never moves one. The workspace
 * groups keep the labels `buildThreadGroups` gave them too.
 */
import type { Waiting } from "../waiting";
import type { ProjectGroup, WorkspaceGroup } from "./groups";
import type { Pose } from "./pose";
import { compareNewestFirst, type ThreadRow } from "./rows";

/** How many entries Waiting on you shows before it is expanded. */
const WAITING_LIMIT = 3;

/** How many threads a project picks by priority before it is expanded. */
const PROJECT_LIMIT = 5;

/** Which sections the user has expanded to show every thread. */
export interface ExpandedSections {
  /** Whether Waiting on you shows every entry. */
  readonly waiting: boolean;
  /** The expanded projects, by id. `null` stands for the threads that belong to no project. */
  readonly projectIds: ReadonlySet<string | null>;
}

/** The Waiting on you section. */
export interface WaitingSection {
  /** The threads and assistants it shows, newest activity first. */
  readonly rows: readonly Waiting[];
  /** How many entries it hides: the number on its "more" row, or 0 for none. */
  readonly hiddenCount: number;
}

/**
 * A project's section: the project's group from `buildThreadGroups`, holding
 * only the rows it shows. A workspace group with no row shown is left out, so
 * its label is not drawn either. `count` is still every thread in the project.
 */
export interface ProjectSection extends ProjectGroup {
  /** How many threads it hides: the number on its "more" row, or 0 for none. */
  readonly hiddenCount: number;
}

/**
 * What the sidebar draws, top to bottom: Waiting on you, then one section per
 * project, each holding only the rows it shows and counting the rows it hides.
 */
export interface SidebarSections {
  /** `null` when nothing is waiting, because the section is then not drawn. */
  readonly waiting: WaitingSection | null;
  /** One section per project group, in the groups' order. */
  readonly projects: readonly ProjectSection[];
}

/**
 * Returns a thread's priority tier in its project: 0 for waiting, 1 for
 * working, 2 for everything else. A lower tier is picked first.
 */
const rankPriorityTier = (pose: Pose | undefined): number => {
  if (pose === "waiting") return 0;
  if (pose === "working") return 1;
  return 2;
};

/** Returns every row of a project group, in the group's order. */
const listRows = (group: ProjectGroup): readonly ThreadRow[] =>
  group.workspaces.flatMap((lane) => lane.rows);

/**
 * Returns a project's section: the 5 threads it picks by priority, plus the
 * selected thread when that is in the project and not already picked.
 */
const buildProjectSection = (
  group: ProjectGroup,
  poses: ReadonlyMap<string, Pose>,
  selectedId: string | null,
  expanded: boolean,
): ProjectSection => {
  if (expanded) return { ...group, hiddenCount: 0 };
  const rows = listRows(group);
  const picked = new Set(
    rows
      .toSorted(
        (a, b) =>
          rankPriorityTier(poses.get(a.id)) - rankPriorityTier(poses.get(b.id)) ||
          compareNewestFirst(a, b),
      )
      .slice(0, PROJECT_LIMIT)
      .map((row) => row.id),
  );
  const workspaces = group.workspaces
    .map((lane): WorkspaceGroup => ({
      ...lane,
      rows: lane.rows.filter((row) => picked.has(row.id) || row.id === selectedId),
    }))
    // A group that holds the draft being written stays, because the draft is
    // drawn in it even though it is not a thread yet.
    .filter((lane) => lane.rows.length > 0 || lane.draft);
  const shownCount = workspaces.reduce((sum, lane) => sum + lane.rows.length, 0);
  return { ...group, workspaces, hiddenCount: rows.length - shownCount };
};

/**
 * Returns the sidebar's sections, capped as described at the top of this
 * file.
 *
 * - `groups` is `buildThreadGroups`'s output.
 * - `waiting` is `listWaiting`'s output, already in the order Waiting on you
 *   shows it.
 * - `poses` holds each thread's pose by session id. A thread with no pose in
 *   `poses` is treated as neither working nor waiting.
 * - `selectedId` is the session id of the thread the user has open, or `null`.
 */
export const buildSidebarSections = ({
  groups,
  waiting,
  poses,
  expanded,
  selectedId,
}: {
  readonly groups: readonly ProjectGroup[];
  readonly waiting: readonly Waiting[];
  readonly poses: ReadonlyMap<string, Pose>;
  readonly expanded: ExpandedSections;
  readonly selectedId: string | null;
}): SidebarSections => {
  const shownWaiting = expanded.waiting ? waiting : waiting.slice(0, WAITING_LIMIT);
  return {
    waiting:
      waiting.length === 0
        ? null
        : { rows: shownWaiting, hiddenCount: waiting.length - shownWaiting.length },
    projects: groups.map((group) =>
      buildProjectSection(group, poses, selectedId, expanded.projectIds.has(group.projectId)),
    ),
  };
};
