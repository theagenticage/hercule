/**
 * Applies the user's choices to a `SessionPresentation`: which rows the
 * desktop sidebar shows, in which order, how many more each section hides
 * behind its "more" row, and which lines an unfolded row draws.
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
 * - An unfolded row draws a line for each session, with the quiet ones
 *   folded into one "n quiet" line.
 *
 * A project's shown rows keep the order of the group rows, so capping a
 * project only removes rows, it never moves one.
 */
import type { Waiting } from "../waiting";
import type { GroupMember, GroupRow } from "./group-row";
import { decideGroupProjectId, type DraftPlace } from "./groups";
import type { SessionPresentation } from "./session-presentation";

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

/** What the user chose, which `selectSidebar` applies to the presentation. */
export interface SidebarChoices {
  /** The entries of Waiting on you, as `listWaiting` returns them. */
  readonly waiting: readonly Waiting[];
  /**
   * The session id of the session the user has open, or `null`. It may belong
   * to a Done Thread, which is why its group's shelf row always shows.
   */
  readonly selectedId: string | null;
  /** Where the draft being written will go, or `null`. */
  readonly draft: DraftPlace | null;
  /** The sections whose "more" row the user pressed. */
  readonly expanded: ExpandedSections;
  /** How many done groups the Done shelf shows, or `null` while it is closed. */
  readonly doneShelfLimit: number | null;
  /** The keys of the groups the user unfolded. */
  readonly unfolded: ReadonlySet<string>;
  /** The keys of the groups whose "n quiet" line the user pressed. */
  readonly quietShown: ReadonlySet<string>;
  /** The session last open in each group, by the group's key. */
  readonly lastOpen: ReadonlyMap<string, string>;
}

/** One line of an unfolded row: a session, or the "n quiet" line that stands for several. */
export type SidebarLine =
  | { readonly kind: "member"; readonly member: GroupMember }
  | { readonly kind: "quiet"; readonly count: number };

/** A group's row as the sidebar shows it, with the choices applied. */
export interface SidebarRow {
  readonly row: GroupRow;
  /**
   * The session a click opens: the open session while the group holds it,
   * else the session last open in the group while the group still holds it,
   * else the group's lead.
   */
  readonly openId: string;
  /** Whether the session `openId` has a colleague in the Office, which decides where a click opens it. */
  readonly seated: boolean;
  /** Whether the row is unfolded: the user unfolded it, and it has more than one session. */
  readonly unfolded: boolean;
  /** The lines under the row, or none while it is folded. */
  readonly lines: readonly SidebarLine[];
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
  /** Whether the draft being written sits in this project, so its row is drawn first. */
  readonly holdsDraft: boolean;
  /** The groups it shows, in the order of the group rows. */
  readonly rows: readonly SidebarRow[];
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
export type DoneShelfRow = SidebarRow & { readonly doneAt: string };

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
export interface SidebarView {
  /** `null` when nothing is waiting, because the section is then not drawn. */
  readonly waiting: WaitingSection | null;
  /** One section per project, in the order described at `buildProjectSections`. */
  readonly projects: readonly ProjectSection[];
  readonly doneShelf: DoneShelf;
  /** The key of the group that holds the open session, shown or not, or `null` when it is in none. */
  readonly openGroupKey: string | null;
}

/** Compares two strings by code unit, returning a negative, zero or positive number as `sort` expects. */
const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

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

/**
 * Returns a project's rows: the groups it picks by priority, plus the open
 * row, which is `undefined` when the open session is in none.
 */
const pickProjectRows = (
  rows: readonly GroupRow[],
  expanded: boolean,
  openRow: GroupRow | undefined,
): readonly GroupRow[] => {
  if (expanded) return rows;
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
  return rows.filter((row) => picked.has(row.key) || row === openRow);
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
  { listedProjectIds }: SessionPresentation,
  { draft, expanded }: SidebarChoices,
  openRow: GroupRow | undefined,
  showRow: (row: GroupRow) => SidebarRow,
): readonly ProjectSection[] => {
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
    .map(({ projectId, held, holdsDraft }) => {
      const shown = pickProjectRows(held, expanded.projectIds.has(projectId), openRow);
      return {
        projectId,
        holdsDraft,
        rows: shown.map(showRow),
        hiddenCount: held.length - shown.length,
        waitingCount: held.reduce(
          (sum, row) => sum + row.members.filter((member) => member.dot === "waiting").length,
          0,
        ),
      };
    });
};

/**
 * Returns the Done shelf: every done group, the most recently done first,
 * with ties in key order.
 *
 * - `limit` is how many the shelf shows, or `null` while it is closed.
 * - The open row is always shown, even when the shelf is closed or the group
 *   is beyond `limit`, so the open session always has a row.
 * - `hiddenCount` counts the groups past `limit`. A closed shelf hides them
 *   all behind its header, not behind a "more" row, so it is 0 then.
 */
const buildDoneShelf = (
  rows: readonly GroupRow[],
  limit: number | null,
  openRow: GroupRow | undefined,
  showRow: (row: GroupRow) => SidebarRow,
): DoneShelf => {
  const done = rows.flatMap((row) => (row.doneAt === null ? [] : [{ row, doneAt: row.doneAt }]));
  const toShelfRow = ({ row, doneAt }: (typeof done)[number]): DoneShelfRow => ({
    ...showRow(row),
    doneAt,
  });
  // A closed shelf shows at most the open row, so it needs no order.
  if (limit === null) {
    return {
      count: done.length,
      rows: done.filter((each) => each.row === openRow).map(toShelfRow),
      hiddenCount: 0,
    };
  }
  const sorted = done.toSorted(
    (a, b) => Date.parse(b.doneAt) - Date.parse(a.doneAt) || compareText(a.row.key, b.row.key),
  );
  const shown = sorted.filter((each, index) => index < limit || each.row === openRow);
  return {
    count: sorted.length,
    rows: shown.map(toShelfRow),
    hiddenCount: sorted.length - shown.length,
  };
};

/**
 * Returns the lines an unfolded row draws, one per session in the group's
 * order, with the quiet ones folded into one "n quiet" line when more than
 * two are quiet and at least one other line would still show. A session is
 * quiet when it neither waits nor works; a Done Thread and an ended Agent
 * session are quiet. A group whose sessions are all quiet shows every line,
 * because a lone "n quiet" line would only make the user press again.
 *
 * The open session always has a line of its own and is not counted among the
 * quiet ones. `quietShown` is true when the user pressed the "n quiet" line,
 * which shows every session.
 */
const listLines = (
  row: GroupRow,
  selectedId: string | null,
  quietShown: boolean,
): readonly SidebarLine[] => {
  const quiet = new Set(
    row.members
      .filter((member) => member.dot === "quiet" && member.sessionId !== selectedId)
      .map((member) => member.sessionId),
  );
  const folds = quiet.size > 2 && !quietShown && quiet.size < row.members.length;
  const lines = (
    folds ? row.members.filter((member) => !quiet.has(member.sessionId)) : row.members
  ).map((member): SidebarLine => ({ kind: "member", member }));
  return folds ? [...lines, { kind: "quiet", count: quiet.size }] : lines;
};

/**
 * Returns the id of the session a click on `row` opens: the open session
 * when the group holds it, else the session last open in the group while the
 * group still holds it, else the group's lead.
 */
const pickOpenId = (
  row: GroupRow,
  selectedId: string | null,
  lastOpen: ReadonlyMap<string, string>,
): string =>
  [selectedId, lastOpen.get(row.key)].find(
    (id): id is string => id != null && row.members.some((member) => member.sessionId === id),
  ) ?? row.leadId;

/**
 * Returns what the desktop sidebar draws for `presentation` under the user's
 * `choices`, top to bottom: Waiting on you (`waiting` is `listWaiting`'s
 * output, a Done Thread's entry included, because a question never hides),
 * one section per project, and the Done shelf.
 *
 * Every decision is made here: which rows show, their order, the session a
 * row opens and whether the Office seats it, which lines an unfolded row
 * draws. The desktop only lays the result out.
 */
export const selectSidebar = (
  presentation: SessionPresentation,
  choices: SidebarChoices,
): SidebarView => {
  const { waiting, selectedId, doneShelfLimit, unfolded, quietShown, lastOpen } = choices;
  const { groupRows, seatedIds } = presentation;
  const openRow =
    selectedId === null
      ? undefined
      : groupRows.find((row) => row.members.some((member) => member.sessionId === selectedId));
  const showRow = (row: GroupRow): SidebarRow => {
    const openId = pickOpenId(row, selectedId, lastOpen);
    const isUnfolded = row.summary !== null && unfolded.has(row.key);
    return {
      row,
      openId,
      seated: seatedIds.has(openId),
      unfolded: isUnfolded,
      lines: isUnfolded ? listLines(row, selectedId, quietShown.has(row.key)) : [],
    };
  };
  const shownWaiting = choices.expanded.waiting ? waiting : waiting.slice(0, WAITING_LIMIT);
  return {
    waiting:
      waiting.length === 0
        ? null
        : { rows: shownWaiting, hiddenCount: waiting.length - shownWaiting.length },
    projects: buildProjectSections(
      groupRows.filter((row) => row.doneAt === null),
      presentation,
      choices,
      openRow,
      showRow,
    ),
    doneShelf: buildDoneShelf(groupRows, doneShelfLimit, openRow, showRow),
    openGroupKey: openRow?.key ?? null,
  };
};
