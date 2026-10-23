/**
 * Decides which rows the desktop sidebar shows, as groups of sessions, and
 * how many more each section hides behind its "more" row:
 *
 * - Waiting on you shows the first 3 entries of `listWaiting`.
 * - A project shows at most 5 groups, picked by priority: a group with a
 *   waiting session first, then one with a working session, then the rest.
 *   Inside a tier the most recent comes first: the later of the group's last
 *   activity and when it last started, so a group reopened from the Done
 *   shelf is never hidden behind the "more" row by newer idle ones. The
 *   groups in no project are capped the same way.
 * - The group that holds the selected session is always shown in its
 *   project, so a project shows at most 6. Unfolded lines never count toward
 *   the cap.
 * - A section the user expanded shows every group.
 * - A group is in its project's list until it is done: every Thread marked
 *   Done and every Agent session ended. The Done shelf at the bottom lists
 *   the done groups, closed until the user opens it, then 10 at a time and 25
 *   more on each press, the most recently done first.
 *
 * A project's shown rows keep the order of `groups`, so capping a project
 * only removes rows, it never moves one.
 */
import type { Project } from "@hercule/contract";
import type { Waiting } from "../waiting";
import { describeGroupRows, type GroupRow, type GroupRowSources } from "./group-row";
import { decideGroupProjectId, type DraftPlace } from "./groups";

/** How many entries Waiting on you shows before it is expanded. */
const WAITING_LIMIT = 3;

/** How many done groups the Done shelf shows when the user opens it. */
export const DONE_SHELF_LIMIT = 10;

/** How many more done groups each press of the shelf's "Show 25 more" row shows. */
export const DONE_SHELF_STEP = 25;

/** How many groups a project picks by priority before it is expanded. */
const PROJECT_LIMIT = 5;

/** Which sections the user has expanded to show every group. */
export interface ExpandedSections {
  /** Whether Waiting on you shows every entry. */
  readonly waiting: boolean;
  /** The expanded projects, by id. `null` stands for the groups that belong to no project. */
  readonly projectIds: ReadonlySet<string | null>;
}

/** The Waiting on you section. */
export interface WaitingSection {
  /** The sessions and assistants it shows, newest activity first. */
  readonly rows: readonly Waiting[];
  /** How many entries it hides: the number on its "more" row, or 0 for none. */
  readonly hiddenCount: number;
}

/** A project's section: the rows it shows, and what it hides. */
export interface ProjectSection {
  /** `null` for the groups that belong to no project. */
  readonly projectId: string | null;
  /** `null` for the groups that belong to no project. */
  readonly name: string | null;
  /** Whether the draft being written sits in this project, so its row is drawn first. */
  readonly holdsDraft: boolean;
  /** The groups it shows, in the order of the groups it was built from. */
  readonly rows: readonly GroupRow[];
  /** How many groups it hides: the number on its "more" row, or 0 for none. */
  readonly hiddenCount: number;
  /**
   * How many counted sessions of the project wait on the user, shown or
   * hidden: the number in the header's "2 need you". The rows only say it one
   * at a time, so a capped project would otherwise hide a session that needs
   * the user.
   */
  readonly waitingCount: number;
}

/** A row of the Done shelf: a group that is done, with the time it was. */
export type DoneShelfRow = GroupRow & { readonly doneAt: string };

/** The Done shelf at the bottom of the desktop sidebar. */
export interface DoneShelf {
  /** How many groups are done: the number in the shelf's header. */
  readonly count: number;
  /** The groups the shelf shows, the most recently done first. */
  readonly rows: readonly DoneShelfRow[];
  /** How many done groups the open shelf hides behind its "more" row, or 0 for none. */
  readonly hiddenCount: number;
}

/** What the sidebar draws, top to bottom: Waiting on you, one section per project, the Done shelf. */
export interface SidebarSections {
  /** `null` when nothing is waiting, because the section is then not drawn. */
  readonly waiting: WaitingSection | null;
  /** One section per project, in the order described at `buildProjectSections`. */
  readonly projects: readonly ProjectSection[];
  readonly doneShelf: DoneShelf;
}

/** Compares two strings by code unit, returning a negative, zero or positive number as `sort` expects. */
const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Checks whether the row's group holds `sessionId`. */
const holdsSession = (row: GroupRow, sessionId: string | null): boolean =>
  sessionId !== null && row.members.some((member) => member.sessionId === sessionId);

/**
 * Returns a row's priority tier in its project: 0 when a counted session
 * waits, 1 when one works, 2 otherwise. A lower tier is picked first.
 */
const rankPriorityTier = (row: GroupRow): number => {
  if (row.members.some((member) => member.dot === "waiting")) return 0;
  if (row.members.some((member) => member.dot === "working")) return 1;
  return 2;
};

/**
 * Returns the time, in milliseconds, a row counts as recent for the pick: the
 * later of when its group last started and when its counted sessions were
 * last active.
 */
const findRecency = (row: GroupRow): number =>
  Math.max(
    Date.parse(row.lastStartedAt),
    ...row.members.filter((member) => member.counted).map((m) => Date.parse(m.activityAt)),
  );

/** Returns a project's section: the groups it picks by priority, plus the one that holds the selected session. */
const buildProjectSection = (
  project: { readonly projectId: string | null; readonly name: string | null },
  rows: readonly GroupRow[],
  holdsDraft: boolean,
  expanded: boolean,
  selectedId: string | null,
): ProjectSection => {
  const waitingCount = rows.reduce(
    (sum, row) => sum + row.members.filter((member) => member.dot === "waiting").length,
    0,
  );
  if (expanded) return { ...project, holdsDraft, rows, hiddenCount: 0, waitingCount };
  const picked = new Set(
    rows
      .map((row) => ({ row, recency: findRecency(row) }))
      .sort(
        (a, b) =>
          rankPriorityTier(a.row) - rankPriorityTier(b.row) ||
          b.recency - a.recency ||
          compareText(a.row.key, b.row.key),
      )
      .slice(0, PROJECT_LIMIT)
      .map(({ row }) => row.key),
  );
  const shown = rows.filter((row) => picked.has(row.key) || holdsSession(row, selectedId));
  return {
    ...project,
    holdsDraft,
    rows: shown,
    hiddenCount: rows.length - shown.length,
    waitingCount,
  };
};

/**
 * Returns the project sections, in the order the sidebar lists them:
 *
 * - the groups with no project last, even when they hold the draft;
 * - otherwise the project that holds the draft being written first;
 * - otherwise by when the project's newest group started, newest first, and
 *   projects that tie by project id.
 *
 * The draft's project is listed even when it holds no group yet. A draft for
 * a project the list does not hold sits with the groups of no project, as
 * that project's groups do.
 */
const buildProjectSections = (
  rows: readonly GroupRow[],
  projects: readonly Project[],
  draft: DraftPlace | null,
  expanded: ExpandedSections,
  selectedId: string | null,
): readonly ProjectSection[] => {
  const listedProjectIds = new Set(projects.map((each) => each.id));
  const draftProjectId =
    draft === null ? undefined : decideGroupProjectId(draft.projectId, listedProjectIds);
  const rowsByProject = new Map<string | null, GroupRow[]>();
  for (const row of rows) {
    const held = rowsByProject.get(row.projectId);
    if (held === undefined) rowsByProject.set(row.projectId, [row]);
    else held.push(row);
  }
  if (draftProjectId !== undefined && !rowsByProject.has(draftProjectId))
    rowsByProject.set(draftProjectId, []);

  return [...rowsByProject]
    .map(([projectId, held]) => ({
      projectId,
      held,
      holdsDraft: projectId === draftProjectId,
      newest: Math.max(0, ...held.map((row) => Date.parse(row.lastStartedAt))),
    }))
    .sort(
      (a, b) =>
        Number(a.projectId === null) - Number(b.projectId === null) ||
        Number(b.holdsDraft) - Number(a.holdsDraft) ||
        b.newest - a.newest ||
        compareText(a.projectId ?? "", b.projectId ?? ""),
    )
    .map(({ projectId, held, holdsDraft }) =>
      buildProjectSection(
        { projectId, name: projects.find((each) => each.id === projectId)?.name ?? null },
        held,
        holdsDraft,
        expanded.projectIds.has(projectId),
        selectedId,
      ),
    );
};

/**
 * Returns the Done shelf: every done group, the most recently done first,
 * with ties in key order.
 *
 * - `limit` is how many the shelf shows, or `null` while it is closed.
 * - The group that holds the selected session is always shown, even when the
 *   shelf is closed or the group is beyond `limit`, so the open session
 *   always has a row.
 * - `hiddenCount` counts the groups past `limit`. A closed shelf hides them
 *   all behind its header, not behind a "more" row, so it is 0 then.
 */
const buildDoneShelf = (
  rows: readonly GroupRow[],
  limit: number | null,
  selectedId: string | null,
): DoneShelf => {
  const done = rows.flatMap((row): DoneShelfRow[] =>
    row.doneAt === null ? [] : [{ ...row, doneAt: row.doneAt }],
  );
  // A closed shelf shows at most the selected group, so it needs no order.
  if (limit === null) {
    return {
      count: done.length,
      rows: done.filter((row) => holdsSession(row, selectedId)),
      hiddenCount: 0,
    };
  }
  const sorted = done.toSorted(
    (a, b) => Date.parse(b.doneAt) - Date.parse(a.doneAt) || compareText(a.key, b.key),
  );
  const shown = sorted.filter((row, index) => index < limit || holdsSession(row, selectedId));
  return { count: sorted.length, rows: shown, hiddenCount: sorted.length - shown.length };
};

/**
 * Returns what the desktop sidebar draws, from the groups of sessions it
 * holds (`buildSessionGroups`, newest `lastStartedAt` first):
 *
 * - `waiting` is `listWaiting`'s output, already in the order Waiting on you
 *   shows it. It lists every waiting session, a Done Thread's too, because a
 *   question never hides.
 * - `draft` is where the draft being written will go, or `null`.
 * - `expanded` holds the sections whose "more" row the user pressed. Its
 *   `projectIds` hold the project of a group as `GroupRow.projectId` says it.
 * - `doneShelfLimit` is how many done groups the Done shelf shows, or `null`
 *   while it is closed.
 * - `selectedId` is the session id of the session the user has open, or
 *   `null`. It may belong to a Done Thread, which is why its group's shelf
 *   row always shows.
 *
 * Each row's status, dots and second line are decided here, so the desktop
 * only lays the result out.
 */
export const buildSidebarSections = ({
  waiting,
  draft,
  expanded,
  doneShelfLimit,
  selectedId,
  ...sources
}: GroupRowSources & {
  readonly waiting: readonly Waiting[];
  readonly draft: DraftPlace | null;
  readonly expanded: ExpandedSections;
  readonly doneShelfLimit: number | null;
  readonly selectedId: string | null;
}): SidebarSections => {
  const rows = describeGroupRows(sources);
  const shownWaiting = expanded.waiting ? waiting : waiting.slice(0, WAITING_LIMIT);
  return {
    waiting:
      waiting.length === 0
        ? null
        : { rows: shownWaiting, hiddenCount: waiting.length - shownWaiting.length },
    projects: buildProjectSections(
      rows.filter((row) => row.doneAt === null),
      sources.projects,
      draft,
      expanded,
      selectedId,
    ),
    doneShelf: buildDoneShelf(rows, doneShelfLimit, selectedId),
  };
};
