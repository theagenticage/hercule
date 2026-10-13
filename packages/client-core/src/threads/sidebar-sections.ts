/**
 * Decides which rows the sidebar shows when there are many, and how many more
 * each section hides behind its "more" row:
 *
 * - Waiting on you shows the first 3 entries of `listWaiting`: the most
 *   recently active threads and assistants, mixed.
 * - A project shows at most 5 threads. They are picked by priority: waiting
 *   threads first, then working ones, then the rest. Inside each of those
 *   tiers the most recent comes first: the later of its last activity and
 *   when it last started, so a thread reopened from the Done shelf is never
 *   hidden behind the "more" row by threads that are newer but idle. The threads with no project are capped the same
 *   way.
 * - The selected thread is always shown in its project, even when it is not
 *   among the 5, so a project shows at most 6. Waiting on you makes no such
 *   exception, because the selected thread is always shown in its project.
 * - A section the user expanded shows every thread.
 * - The projects list only the threads not marked Done. The Done shelf at the
 *   bottom lists the rest, closed until the user opens it, then 10 at a time
 *   and 25 more on each press, the most recently marked Done first.
 *
 * Two threads equally recent are ordered by session id, so the
 * pick never depends on the order the server listed them in.
 *
 * A project's shown rows keep the order `buildThreadGroups` gives them, so
 * capping a project only removes rows, it never moves one. The workspace
 * groups keep the labels `buildThreadGroups` gave them too.
 */
import type { Session } from "@hercule/contract";
import type { Waiting } from "../waiting";
import type { ProjectGroup, WorkspaceGroup } from "./groups";
import type { Pose } from "./pose";
import { pickLastStartedAt } from "./project-rows";
import type { ThreadRow } from "./rows";
import { isMarkedDone } from "./status";

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
  /**
   * How many of the project's threads wait on the user, shown or hidden: the
   * number in the header's "2 need you". The rows only say it one at a time,
   * so a capped project would otherwise hide a thread that needs the user.
   */
  readonly waitingCount: number;
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
  sessions: ReadonlyMap<string, Session>,
  poses: ReadonlyMap<string, Pose>,
  selectedId: string | null,
  expanded: boolean,
): ProjectSection => {
  const rows = listRows(group);
  const waitingCount = rows.filter((row) => poses.get(row.id) === "waiting").length;
  if (expanded) return { ...group, hiddenCount: 0, waitingCount };
  const recency = new Map(
    rows.map((row) => {
      const session = sessions.get(row.id);
      const startedAt = session === undefined ? 0 : Date.parse(pickLastStartedAt(session));
      return [row.id, Math.max(Date.parse(row.activityAt), startedAt)];
    }),
  );
  const picked = new Set(
    rows
      .toSorted(
        (a, b) =>
          rankPriorityTier(poses.get(a.id)) - rankPriorityTier(poses.get(b.id)) ||
          (recency.get(b.id) ?? 0) - (recency.get(a.id) ?? 0) ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
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
    .filter((lane) => lane.rows.length > 0 || lane.draft || lane.showWhenEmpty);
  const shownCount = workspaces.reduce((sum, lane) => sum + lane.rows.length, 0);
  return { ...group, workspaces, hiddenCount: rows.length - shownCount, waitingCount };
};

/**
 * Returns the sidebar's sections, capped as described at the top of this
 * file.
 *
 * - `groups` is `buildThreadGroups`'s output.
 * - `sessions` holds each thread's session by id, for when it last started.
 *   A thread missing from it counts only its last activity.
 * - `waiting` is `listWaiting`'s output, already in the order Waiting on you
 *   shows it.
 * - `poses` holds each thread's pose by session id. A thread with no pose in
 *   `poses` is treated as neither working nor waiting.
 * - `selectedId` is the session id of the thread the user has open, or `null`.
 */
export const buildSidebarSections = ({
  groups,
  sessions,
  waiting,
  poses,
  expanded,
  selectedId,
}: {
  readonly groups: readonly ProjectGroup[];
  readonly sessions: ReadonlyMap<string, Session>;
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
      buildProjectSection(
        group,
        sessions,
        poses,
        selectedId,
        expanded.projectIds.has(group.projectId),
      ),
    ),
  };
};

/** How many Done threads the Done shelf shows when the user opens it. */
export const DONE_SHELF_LIMIT = 10;

/** How many more Done threads each press of the shelf's "Show 25 more" row shows. */
export const DONE_SHELF_STEP = 25;

/** The Done shelf at the bottom of the desktop sidebar. */
export interface DoneShelf {
  /** How many threads are marked Done: the number in the shelf's header. */
  readonly count: number;
  /** The Done threads the shelf shows, the most recently marked Done first. */
  readonly threads: readonly Session[];
  /** How many Done threads the open shelf hides behind its "more" row, or 0 for none. */
  readonly hiddenCount: number;
}

/**
 * Returns the Done shelf: every thread in `threads` that is marked Done, the
 * most recently marked first, with ties in session id order.
 *
 * - `limit` is how many the shelf shows, or `null` while it is closed.
 * - The selected thread is always shown, even when the shelf is closed or it
 *   is beyond `limit`, so the thread the user has open always has a row.
 * - `hiddenCount` counts the threads past `limit`. A closed shelf hides
 *   them all behind its header, not behind a "more" row, so it is 0 then.
 */
export const buildDoneShelf = ({
  threads,
  limit,
  selectedId,
}: {
  readonly threads: readonly Session[];
  readonly limit: number | null;
  readonly selectedId: string | null;
}): DoneShelf => {
  const unsorted = threads.filter(isMarkedDone);
  // A closed shelf shows at most the selected thread, so it needs no order.
  if (limit === null) {
    return {
      count: unsorted.length,
      threads: unsorted.filter((session) => session.id === selectedId),
      hiddenCount: 0,
    };
  }
  const done = unsorted
    .map((session) => ({ session, doneAt: Date.parse(session.done?.at ?? "") }))
    .sort(
      (a, b) =>
        b.doneAt - a.doneAt ||
        (a.session.id < b.session.id ? -1 : a.session.id > b.session.id ? 1 : 0),
    )
    .map(({ session }) => session);
  const shown = done.filter((session, index) => index < limit || session.id === selectedId);
  return { count: done.length, threads: shown, hiddenCount: done.length - shown.length };
};
