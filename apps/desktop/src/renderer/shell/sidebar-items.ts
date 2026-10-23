/**
 * Builds what the sidebar draws from the lists it reads: the flat list of
 * items the virtualized list draws (section headers, group rows and their
 * lines, and "more" rows, each with a fixed height and the space the book
 * puts above it), and the session counts in the foot.
 *
 * Which groups of sessions are shown, in which order, and in what pose is
 * decided in client-core. This file only lays the result out in Bureau's
 * geometry.
 */
import {
  buildGroupSidebar,
  buildSessionGroups,
  countThreadsByPose,
  DONE_SHELF_STEP,
  decideThreadPose,
  isThreadSeated,
  listGroupLines,
  type DoneGroupRow,
  type DraftPlace,
  type ExpandedSections,
  type GroupAsk,
  type GroupDoneShelf,
  type GroupRow,
  type GroupSummary,
  type Pose,
  type ProjectGroupSection,
  type SessionDot,
  type ThreadCounts,
  type ThreadRowStatus,
  type Waiting,
  type WaitingRunSession,
  type WaitingSection,
  type WorkspaceLabel,
} from "@hercule/client-core";
import type {
  Project,
  ProviderInstance,
  Resource,
  Runner,
  Session,
  Workspace,
} from "@hercule/contract";
import type { GoMenuItem } from "../../ipc/contract";
import { buildDestinationKey } from "../../ipc/destination";
import { pickProjectTint, type ProjectTint } from "../screens/project-tile";
import type { ThreadHoverDetails } from "./thread-hover-card";

/**
 * Which section an item belongs to: `waiting`, `project:<id>`, with `none`
 * for the threads in no project, or `done`, the Done shelf.
 */
export type SectionKey = "waiting" | `project:${string}` | "done";

/**
 * What an item draws. Its `key` is unique in the list, and stays the same for
 * the same thing across renders.
 */
export type SidebarItemContent =
  | { readonly kind: "waiting-header"; readonly key: string; readonly count: number }
  | {
      readonly kind: "waiting-thread-row";
      readonly key: string;
      readonly sessionId: string;
      /** The key of the group the asking session is in, `GroupRow.key` of its row. */
      readonly groupKey: string;
      /** The name of the group the asking session is in: its lead's title. */
      readonly title: string;
      /**
       * What the asking session is called in its group, such as "review", or
       * `null` when the lead asks or the group has one session. The row draws
       * it before the question, as "review asks".
       */
      readonly askerLabel: string | null;
      readonly question: string;
    }
  | {
      readonly kind: "waiting-assistant-row";
      readonly key: string;
      readonly assistantId: string;
      readonly name: string;
      readonly question: string;
    }
  /** "From runs", the label over the runs' sessions in Waiting on you. */
  | { readonly kind: "waiting-runs-label"; readonly key: string }
  /**
   * A run's session that waits on the user, under "From runs". Its title is
   * the session's, "<workflow> · <step>" for a run's step.
   */
  | {
      readonly kind: "waiting-run-row";
      readonly key: string;
      readonly sessionId: string;
      readonly title: string;
      readonly question: string;
    }
  | {
      readonly kind: "project-header";
      readonly key: string;
      /** `null` for the threads in no project, whose heading has an outline tile. */
      readonly projectId: string | null;
      readonly name: string;
      /** `null` for the threads in no project. */
      readonly tint: ProjectTint | null;
      /** How many of the project's threads wait on the user, shown or hidden. */
      readonly waitingCount: number;
    }
  /**
   * A group's row: the Threads and Agent sessions that work in one workspace.
   * A group of one session draws as a lone thread's row, with no dots.
   */
  | {
      readonly kind: "group-row";
      readonly key: string;
      readonly groupKey: string;
      /**
       * The session a click opens: the one last open in this group while it
       * is still in the group, else the group's lead.
       */
      readonly openId: string;
      /** The lead's title. */
      readonly title: string;
      /** The pose of the session that decides the status, for the row's accessible name. */
      readonly pose: Pose;
      /** Whether the session `openId` has a colleague in the Office, which decides where a click opens it. */
      readonly seated: boolean;
      readonly status: ThreadRowStatus;
      /**
       * Whether the row steps back, drawn dimmer: a working group's row does,
       * so the groups that need the user stand out, except the group that
       * holds the open session, which the user is looking at.
       */
      readonly receded: boolean;
      /**
       * When the status's session was last active, which an `age` status
       * counts from, or "" for any other status. Only an `age` row reads it,
       * so a working row does not draw again each time its session does
       * something.
       */
      readonly activityAt: string;
      /** What waits on the user, which replaces the second line while something waits, or `null`. */
      readonly ask: GroupAsk | null;
      /**
       * Where the lead works, the row's second line after the provider's
       * mark, in two parts: the part that may be cut short, such as
       * "rogier/fix-" or "webshop", and the part that never is, such as
       * "sidebar-rows" or " · moss", or "" when there is none.
       */
      readonly placeClip: string;
      readonly placeKeep: string;
      /** The provider whose mark leads the second line, or `null`. */
      readonly providerId: string | null;
      /**
       * Where the lead works, in words, for the row's accessible
       * description, such as "in webshop, webshop main workspace, on moss,
       * branch main".
       */
      readonly placeDescription: string;
      /** Whether the composer of any session of the group holds text or images the user has not sent. */
      readonly unsent: boolean;
      /** The dots, or `null` for a group of one session, which has no dots and does not unfold. */
      readonly summary: GroupSummary | null;
      /** Whether the group's lines are drawn under the row. */
      readonly unfolded: boolean;
      /** Whether the open session is in the group. */
      readonly holdsOpen: boolean;
      /** The ids of the group's Threads not yet marked Done: what the row's Done button marks. */
      readonly doneIds: readonly string[];
      /** What the card shows while the pointer rests on the row. */
      readonly details: ThreadHoverDetails;
    }
  /** One session of an unfolded group. */
  | {
      readonly kind: "group-line";
      readonly key: string;
      readonly groupKey: string;
      /** The group's name, which describes the line to assistive technology. */
      readonly groupTitle: string;
      readonly sessionId: string;
      /** What the session is called in its group, such as "review". */
      readonly label: string;
      /** The session's full title, for a tooltip. */
      readonly title: string;
      readonly pose: Pose;
      /** Whether the session has a colleague in the Office, which decides where a click opens it. */
      readonly seated: boolean;
      readonly status: ThreadRowStatus;
      readonly activityAt: string;
      readonly dot: SessionDot;
      /** Whether the session is a Thread marked Done, which the line draws with a check. */
      readonly done: boolean;
      readonly providerId: string | null;
      readonly model: string;
      /** Whether the line is the last of its unfolded group. */
      readonly last: boolean;
    }
  /** The "n quiet" line of an unfolded group, which shows the quiet sessions it folded away. */
  | {
      readonly kind: "quiet-line";
      readonly key: string;
      readonly groupKey: string;
      readonly groupTitle: string;
      /** How many sessions the line stands for. */
      readonly count: number;
      readonly last: boolean;
    }
  | {
      readonly kind: "draft-row";
      readonly key: string;
      /**
       * Where the draft will work, in the two parts of a thread row's second
       * line, such as "" and "main".
       */
      readonly placeClip: string;
      readonly placeKeep: string;
    }
  /** The Done shelf's heading, which opens and closes the shelf. */
  | {
      readonly kind: "done-header";
      readonly key: string;
      /** How many threads are marked Done. */
      readonly count: number;
      readonly open: boolean;
    }
  /**
   * A group on the Done shelf: every Thread of it is marked Done and every
   * Agent session of it has ended.
   */
  | {
      readonly kind: "done-group-row";
      readonly key: string;
      readonly groupKey: string;
      /** The session a click opens, chosen as the group row's is. */
      readonly openId: string;
      /** The lead's title. */
      readonly title: string;
      readonly pose: Pose;
      /** How many Threads the group has, which its second line counts. */
      readonly threadCount: number;
      /** When the group's last Thread was marked Done, which the second line shows. */
      readonly doneAt: string;
      readonly providerId: string | null;
      readonly unsent: boolean;
      /** The ids of every Thread of the group: what the row's Reopen button reopens. */
      readonly reopenIds: readonly string[];
      /** What the card shows while the pointer rests on the row: every session of the group, Agent sessions too. */
      readonly details: ThreadHoverDetails;
    }
  | { readonly kind: "more"; readonly key: string; readonly label: string };

/**
 * One entry of the sidebar's list: what it draws, the section it belongs to,
 * and the space above it.
 */
export type SidebarItem = SidebarItemContent & {
  readonly section: SectionKey;
  /** The space above the item, in CSS pixels: 8 above a section's first item, 1 above the others. */
  readonly leading: number;
};

export type SidebarItemKind = SidebarItem["kind"];

/**
 * The height of each kind of item, in CSS pixels. Measured with
 * `getBoundingClientRect` in the Bureau book's `desktop/session-active.html`,
 * at 1440 x 900 on a 2x display, in Whitehaven and Orient Express (both give
 * the same numbers):
 *
 * - a section header (`h3.side-h`) is 24;
 * - a Waiting on you row (`.side-row--wait`) is 38, a thread's, an
 *   assistant's and a run's session's alike;
 * - the "From runs" label (`.side-sub`) is 16;
 * - a "more" row (`.side-row--more`, in the book's swarm state) is 28.
 *
 * The book's thread row (`.side-row`) is 35, with two tight lines. This
 * app's group row is 52, so two lines read apart at a glance (spec 17 §The
 * sidebar): 6px of padding above and below, the 13px title on an 18px line,
 * 6px, then the 12px second line on a 16px line. The draft's row and a done
 * group's row are drawn the same way. The Done shelf's heading is a section
 * header. A line of an unfolded group, and the "n quiet" line, are 32.
 */
export const ITEM_HEIGHTS: Readonly<Record<SidebarItemKind, number>> = {
  "waiting-header": 24,
  "waiting-thread-row": 38,
  "waiting-assistant-row": 38,
  "waiting-runs-label": 16,
  "waiting-run-row": 38,
  "project-header": 24,
  "group-row": 52,
  "group-line": 32,
  "quiet-line": 32,
  "draft-row": 52,
  "done-header": 24,
  "done-group-row": 52,
  more: 28,
};

/** The space above a section's first item: the book's `.side-sec { padding-top: 8px }`. */
const SECTION_LEADING = 8;

/** The space between two items of a section: the book's `.side-sec { gap: 1px }`. */
const ITEM_LEADING = 1;

/**
 * The space between two tall rows, each a group's, a draft's or a done
 * group's: 2px, where the book has 1px, because two tall rows that touch on
 * hover read as one. Under a header, a row keeps the book's 1px.
 */
const THREAD_ROW_LEADING = 2;

/**
 * The space an unfolded group adds below its last line, on top of the usual
 * space above the next item: the 4px bottom padding of the list of lines. The
 * lines sit 1px apart, and the first one 1px under its row.
 */
const AFTER_LINES_LEADING = 4;

/**
 * The space above "From runs": the section's 1px gap plus the book's
 * `.side-sub { margin-top: 6px }`, which sets the runs apart from the
 * threads and assistants above them.
 */
const RUNS_LABEL_LEADING = ITEM_LEADING + 6;

/**
 * How many runs' sessions Waiting on you shows until the user expands it.
 * The runs have a cap of their own, apart from the threads', so one busy
 * workflow never hides a waiting thread.
 */
const WAITING_RUN_SESSION_LIMIT = 3;

/** Returns the section key of a project's section. */
const buildProjectSectionKey = (projectId: string | null): SectionKey =>
  `project:${projectId ?? "none"}`;

/** Returns the key of a section's header. */
const buildHeaderKey = (section: SectionKey): string => `header:${section}`;

/** Returns the key of a section's "more" row. */
const buildMoreRowKey = (section: SectionKey): string => `more:${section}`;

/** Returns the key of the row of the group `groupKey`. */
const buildGroupRowKey = (groupKey: string): string => `group:${groupKey}`;

/**
 * Returns which sections are expanded, in the shape `buildGroupSidebar`
 * takes, from the keys of the sections whose "more" row the user pressed.
 */
const buildExpandedSections = (expanded: ReadonlySet<SectionKey>): ExpandedSections => ({
  waiting: expanded.has("waiting"),
  projectIds: new Set(
    [...expanded].flatMap((key) => {
      if (!key.startsWith("project:")) return [];
      const projectId = key.slice("project:".length);
      return [projectId === "none" ? null : projectId];
    }),
  ),
});

/**
 * Returns the text of a section's "more" row, such as "27 more waiting on
 * you", "3 more" (groups, which have no noun of their own), or "Show 25 more"
 * on the Done shelf, which shows at most `DONE_SHELF_STEP` more on each press.
 */
const formatMoreLabel = (section: "waiting" | "project" | "done", hidden: number): string => {
  switch (section) {
    case "waiting":
      return `${String(hidden)} more waiting on you`;
    case "project":
      return `${String(hidden)} more`;
    case "done":
      return `Show ${String(Math.min(hidden, DONE_SHELF_STEP))} more`;
  }
};

/** Returns the content of a Waiting on you row: a thread's or an assistant's. */
const buildWaitingRow = (waiting: Waiting): SidebarItemContent => {
  switch (waiting.kind) {
    case "thread":
      return {
        kind: "waiting-thread-row",
        key: `waiting:${buildDestinationKey({ kind: "thread", sessionId: waiting.sessionId })}`,
        sessionId: waiting.sessionId,
        groupKey: waiting.groupKey,
        title: waiting.groupName,
        askerLabel: waiting.askerLabel,
        question: waiting.question,
      };
    case "assistant":
      return {
        kind: "waiting-assistant-row",
        key: `waiting:${buildDestinationKey({ kind: "assistant", assistantId: waiting.assistantId })}`,
        assistantId: waiting.assistantId,
        name: waiting.name,
        question: waiting.question,
      };
  }
};

/** Returns the content of a run's session's row in Waiting on you, under "From runs". */
const buildWaitingRunRow = (run: WaitingRunSession): SidebarItemContent => ({
  kind: "waiting-run-row",
  key: `waiting-run:${run.sessionId}`,
  sessionId: run.sessionId,
  title: run.title,
  question: run.question,
});

/** What the items need to know beyond the sidebar `buildGroupSidebar` decided. */
interface SidebarItemSources {
  readonly groupSidebar: ReturnType<typeof buildGroupSidebar>;
  /** The runs' sessions waiting on the user, newest activity first. */
  readonly waitingRunSessions: readonly WaitingRunSession[];
  /** Whether the user expanded Waiting on you, so it shows every run's session too. */
  readonly waitingExpanded: boolean;
  readonly doneShelfOpen: boolean;
  /** The project list in its own order, which decides each project's tint. */
  readonly projects: readonly Project[];
  /** The session ids of the sessions whose composer holds unsent work. */
  readonly unsentKeys: ReadonlySet<string>;
  /**
   * The draft's second line, while a Draft Thread is open, or `null`. The
   * draft's row is drawn first in the project the sidebar marks as holding
   * the draft.
   */
  readonly draftPlaceLabel: WorkspaceLabel | null;
  /** The session id of the open session, which no group row recedes for, or `null`. */
  readonly selectedId: string | null;
  /** The keys of the groups the user unfolded. */
  readonly unfoldedGroups: ReadonlySet<string>;
  /** The keys of the groups whose quiet sessions the user showed. */
  readonly quietShownGroups: ReadonlySet<string>;
  /** The session last open in each group, by the group's key. */
  readonly lastOpen: ReadonlyMap<string, string>;
}

/** Returns a section's items: its contents, each given the section and the space above it. */
const placeInSection = (
  section: SectionKey,
  contents: readonly SidebarItemContent[],
): SidebarItem[] =>
  contents.map((content, index) => ({
    ...content,
    section,
    leading: index === 0 ? SECTION_LEADING : pickLeading(content.kind, contents[index - 1]?.kind),
  }));

/** Checks whether an item of `kind` is a tall row: a group's, a draft's or a done group's. */
const isTallRow = (kind: SidebarItemKind | undefined): boolean =>
  kind === "group-row" || kind === "draft-row" || kind === "done-group-row";

/** Checks whether an item of `kind` is a line of an unfolded group. */
const isLine = (kind: SidebarItemKind | undefined): boolean =>
  kind === "group-line" || kind === "quiet-line";

/**
 * Returns the space above an item of `kind` that is not its section's first,
 * when the item above it is of `previous` kind. The lines of a group sit 1px
 * apart, and what follows the last line is spaced as if it followed the
 * group's row, plus the room below the lines.
 */
const pickLeading = (kind: SidebarItemKind, previous: SidebarItemKind | undefined): number => {
  if (kind === "waiting-runs-label") return RUNS_LABEL_LEADING;
  if (isLine(kind)) return ITEM_LEADING;
  const followsTallRow = isTallRow(previous) || isLine(previous);
  const leading = isTallRow(kind) && followsTallRow ? THREAD_ROW_LEADING : ITEM_LEADING;
  return isLine(previous) ? leading + AFTER_LINES_LEADING : leading;
};

/**
 * Returns what Waiting on you draws, or nothing when nothing waits:
 *
 * - its header, with the count of everything that waits, shown or hidden;
 * - its threads and assistants, in `waiting`'s order;
 * - "From runs" and the runs' sessions in `waitingRunSessions`, at most
 *   `WAITING_RUN_SESSION_LIMIT` of them unless `expanded` is true;
 * - its "more" row when it hides some threads, assistants or runs' sessions.
 *
 * `waiting` is `null` when no thread or assistant waits.
 */
const buildWaitingContents = (
  waiting: WaitingSection | null,
  waitingRunSessions: readonly WaitingRunSession[],
  expanded: boolean,
): SidebarItemContent[] => {
  const rows = waiting?.rows ?? [];
  const shownRuns = expanded
    ? waitingRunSessions
    : waitingRunSessions.slice(0, WAITING_RUN_SESSION_LIMIT);
  const hiddenCount = (waiting?.hiddenCount ?? 0) + waitingRunSessions.length - shownRuns.length;
  if (rows.length === 0 && shownRuns.length === 0) return [];
  const contents: SidebarItemContent[] = [
    {
      kind: "waiting-header",
      key: buildHeaderKey("waiting"),
      count: rows.length + shownRuns.length + hiddenCount,
    },
    ...rows.map(buildWaitingRow),
  ];
  if (shownRuns.length > 0) {
    contents.push(
      { kind: "waiting-runs-label", key: "label:waiting-runs" },
      ...shownRuns.map(buildWaitingRunRow),
    );
  }
  if (hiddenCount > 0) {
    contents.push({
      kind: "more",
      key: buildMoreRowKey("waiting"),
      label: formatMoreLabel("waiting", hiddenCount),
    });
  }
  return contents;
};

/**
 * Returns the id of the session a click on the row of `row` opens: the open
 * session when the group holds it, else the session last open in the group
 * while the group still holds it, else the group's lead.
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
 * Returns what the card shows for the group of `row`. A group of one session
 * lists no members: its card shows the lead's model instead.
 */
const buildHoverDetails = (
  row: GroupRow,
  place: { readonly projectName: string; readonly tint: ProjectTint | null },
): ThreadHoverDetails => {
  const lead = row.members.find((member) => member.sessionId === row.leadId);
  return {
    title: row.title,
    projectName: place.projectName,
    tint: place.tint,
    machine: row.machine,
    branch: row.branch,
    model: lead?.model ?? null,
    providerId: lead?.providerId ?? null,
    members: row.summary === null ? [] : row.members,
  };
};

/**
 * Returns the items of one group of the project list: its row, then, while
 * the group is unfolded, a line for each session it shows, then the "n
 * quiet" line when quiet sessions are folded away.
 */
const buildGroupContents = (
  row: GroupRow,
  { unsentKeys, selectedId, unfoldedGroups, quietShownGroups, lastOpen }: SidebarItemSources,
  place: { readonly projectName: string; readonly tint: ProjectTint | null },
): SidebarItemContent[] => {
  const openId = pickOpenId(row, selectedId, lastOpen);
  const opened = row.members.find((member) => member.sessionId === openId);
  const holdsOpen = row.members.some((member) => member.sessionId === selectedId);
  const unfolded = row.summary !== null && unfoldedGroups.has(row.key);
  const contents: SidebarItemContent[] = [
    {
      kind: "group-row",
      key: buildGroupRowKey(row.key),
      groupKey: row.key,
      openId,
      title: row.title,
      pose: row.pose,
      seated: opened !== undefined && isThreadSeated(opened.pose, opened.done),
      status: row.status,
      receded: row.status === "working" && !holdsOpen,
      activityAt: row.status === "age" ? row.activityAt : "",
      ask: row.ask,
      placeClip: row.placeLabel.clip,
      placeKeep: row.placeLabel.keep,
      providerId: row.providerId,
      placeDescription: row.placeDescription,
      unsent: row.members.some((member) => unsentKeys.has(member.sessionId)),
      summary: row.summary,
      unfolded,
      holdsOpen,
      doneIds: row.members
        .filter((member) => member.kind === "thread" && !member.done)
        .map((member) => member.sessionId),
      details: buildHoverDetails(row, place),
    },
  ];
  if (!unfolded) return contents;
  const { lines, foldedQuietCount } = listGroupLines(row, {
    selectedId,
    quietShown: quietShownGroups.has(row.key),
  });
  contents.push(
    ...lines.map((member, index): SidebarItemContent => ({
      kind: "group-line",
      key: `line:${member.sessionId}`,
      groupKey: row.key,
      groupTitle: row.title,
      sessionId: member.sessionId,
      label: member.label,
      title: member.title,
      pose: member.pose,
      seated: isThreadSeated(member.pose, member.done),
      status: member.status,
      activityAt: member.status === "age" ? member.activityAt : "",
      dot: member.dot,
      done: member.done,
      providerId: member.providerId,
      model: member.model,
      last: foldedQuietCount === 0 && index === lines.length - 1,
    })),
  );
  if (foldedQuietCount > 0) {
    contents.push({
      kind: "quiet-line",
      key: `quiet:${row.key}`,
      groupKey: row.key,
      groupTitle: row.title,
      count: foldedQuietCount,
      last: true,
    });
  }
  return contents;
};

/**
 * Returns what a project's section draws: its header, then the draft's row
 * when the project holds the Draft Thread, then its shown groups, the most
 * recently started or reopened first, each followed by its lines while
 * unfolded, then its "more" row when it hides some groups. The groups in no
 * project are headed "No project".
 *
 * The draft's row is first because the draft is the newest thread of its
 * project. Groups have no heading of their own: each row names its branch,
 * its workspace or its machine on its second line.
 */
const buildProjectContents = (
  project: ProjectGroupSection,
  sources: SidebarItemSources,
): SidebarItemContent[] => {
  const section = buildProjectSectionKey(project.projectId);
  // Only the group of the threads in no project has no name.
  const projectName = project.name ?? "No project";
  const tint =
    project.projectId === null ? null : pickProjectTint(project.projectId, sources.projects);
  const contents: SidebarItemContent[] = [
    {
      kind: "project-header",
      key: buildHeaderKey(section),
      projectId: project.projectId,
      name: projectName,
      tint,
      waitingCount: project.waitingCount,
    },
  ];
  if (sources.draftPlaceLabel !== null && project.holdsDraft) {
    contents.push({
      kind: "draft-row",
      key: "draft",
      placeClip: sources.draftPlaceLabel.clip,
      placeKeep: sources.draftPlaceLabel.keep,
    });
  }
  for (const row of project.rows) {
    contents.push(...buildGroupContents(row, sources, { projectName, tint }));
  }
  if (project.hiddenCount > 0) {
    contents.push({
      kind: "more",
      key: buildMoreRowKey(section),
      label: formatMoreLabel("project", project.hiddenCount),
    });
  }
  return contents;
};

/** Returns the content of a group's row on the Done shelf. */
const buildDoneGroupRow = (
  row: DoneGroupRow,
  { selectedId, lastOpen, unsentKeys, projects }: SidebarItemSources,
): SidebarItemContent => ({
  kind: "done-group-row",
  key: `done:${row.key}`,
  groupKey: row.key,
  openId: pickOpenId(row, selectedId, lastOpen),
  title: row.title,
  pose: row.pose,
  threadCount: row.threadIds.length,
  doneAt: row.doneAt,
  providerId: row.providerId,
  unsent: row.members.some((member) => unsentKeys.has(member.sessionId)),
  reopenIds: row.threadIds,
  details: buildHoverDetails(row, {
    projectName: projects.find((project) => project.id === row.projectId)?.name ?? "No project",
    tint: row.projectId === null ? null : pickProjectTint(row.projectId, projects),
  }),
});

/**
 * Returns what the Done shelf draws, or nothing when no group is done: its
 * heading with the count, then, while it is open or holds the open session,
 * its rows, most recently done first, then its "more" row when the open
 * shelf hides some.
 */
const buildDoneContents = (
  doneShelf: GroupDoneShelf,
  sources: SidebarItemSources,
): SidebarItemContent[] => {
  if (doneShelf.count === 0) return [];
  const contents: SidebarItemContent[] = [
    {
      kind: "done-header",
      key: buildHeaderKey("done"),
      count: doneShelf.count,
      open: sources.doneShelfOpen,
    },
    ...doneShelf.rows.map((row) => buildDoneGroupRow(row, sources)),
  ];
  if (doneShelf.hiddenCount > 0) {
    contents.push({
      kind: "more",
      key: buildMoreRowKey("done"),
      label: formatMoreLabel("done", doneShelf.hiddenCount),
    });
  }
  return contents;
};

/**
 * Returns the sidebar's items, top to bottom: Waiting on you when a thread,
 * an assistant or a run's session is waiting, then each project's section in
 * the order of `groupSidebar.projects`, then the Done shelf when a group is
 * done.
 */
const buildSidebarItems = (sources: SidebarItemSources): readonly SidebarItem[] => {
  const { groupSidebar, waitingRunSessions, waitingExpanded } = sources;
  return [
    ...placeInSection(
      "waiting",
      buildWaitingContents(groupSidebar.waiting, waitingRunSessions, waitingExpanded),
    ),
    ...groupSidebar.projects.flatMap((project) =>
      placeInSection(
        buildProjectSectionKey(project.projectId),
        buildProjectContents(project, sources),
      ),
    ),
    ...placeInSection("done", buildDoneContents(groupSidebar.doneShelf, sources)),
  ];
};

/** What the sidebar is built from: the lists it reads, the open draft, and the user's choices. */
export interface SidebarSources {
  /** The Threads and Agent sessions the sidebar's read holds. */
  readonly sessions: readonly Session[];
  /**
   * The open session's own record, or `null`. The read leaves out a Thread
   * marked Done more than 14 days ago, so an open one is added from here, and
   * its group keeps a row on the Done shelf. A record the read holds wins.
   */
  readonly openSession: Session | null;
  /** The threads and the assistants waiting on the user, as `listWaiting` returns them. */
  readonly waiting: readonly Waiting[];
  /**
   * The runs' sessions waiting on the user, newest activity first, as
   * `listWaitingRunSessions` returns them.
   */
  readonly waitingRunSessions: readonly WaitingRunSession[];
  /** The project list in its own order, which decides each project's tint. */
  readonly projects: readonly Project[];
  readonly workspaces: readonly Workspace[];
  readonly resources: readonly Resource[];
  readonly runners: readonly Runner[];
  /** The instances whose catalogs give a session its model name. */
  readonly instances: readonly ProviderInstance[];
  /**
   * The open Draft Thread, or `null`: the group it will join, and its row's
   * second line, as `buildDraftView` returns them.
   */
  readonly draft: {
    readonly place: DraftPlace;
    readonly rowPlaceLabel: WorkspaceLabel;
  } | null;
  /** The keys of the composers that hold unsent work: a thread's key is its session id. */
  readonly unsentKeys: ReadonlySet<string>;
  /** The keys of the project sections, and Waiting on you, whose "more" row the user pressed. */
  readonly expanded: ReadonlySet<SectionKey>;
  /**
   * How many done groups the Done shelf shows, or `null` while it is closed:
   * `DONE_SHELF_LIMIT` when opened, and `DONE_SHELF_STEP` more for each press
   * of its "more" row.
   */
  readonly doneShelfLimit: number | null;
  /** The session id of the open session, whose group its section always shows, or `null`. */
  readonly selectedId: string | null;
  /** The keys of the groups the user unfolded. */
  readonly unfoldedGroups: ReadonlySet<string>;
  /** The keys of the groups whose quiet sessions the user showed. */
  readonly quietShownGroups: ReadonlySet<string>;
  /** The session last open in each group, by the group's key. */
  readonly lastOpen: ReadonlyMap<string, string>;
}

/** What the sidebar draws: the items of its list, and the session counts in its foot. */
export interface Sidebar {
  readonly items: readonly SidebarItem[];
  readonly counts: ThreadCounts;
  /** The key of the group that holds the open session, shown or not, or `null` when it is in none. */
  readonly openGroupKey: string | null;
}

/**
 * Returns what the sidebar draws from `sources`: its items, top to bottom,
 * and how many sessions are working, waiting and idle.
 *
 * Each session's pose is decided here for the counts. A Thread marked Done
 * counts in none of the foot's counts, but Waiting on you still lists it
 * while it waits, because `waiting` comes from every session.
 */
export const buildSidebar = ({
  sessions: listed,
  openSession,
  waiting,
  waitingRunSessions,
  projects,
  workspaces,
  resources,
  runners,
  instances,
  draft,
  unsentKeys,
  expanded,
  doneShelfLimit,
  selectedId,
  unfoldedGroups,
  quietShownGroups,
  lastOpen,
}: SidebarSources): Sidebar => {
  const mergeOpenSession =
    openSession !== null &&
    (openSession.kind === "thread" || openSession.kind === "agent") &&
    !listed.some((session) => session.id === openSession.id);
  const sessions = mergeOpenSession ? [...listed, openSession] : listed;
  const groups = buildSessionGroups(sessions);
  const groupSidebar = buildGroupSidebar({
    groups,
    projects,
    workspaces,
    resources,
    runners,
    instances,
    waiting,
    draft: draft?.place ?? null,
    expanded: buildExpandedSections(expanded),
    doneShelfLimit,
    selectedId,
  });
  const items = buildSidebarItems({
    groupSidebar,
    waitingRunSessions,
    waitingExpanded: expanded.has("waiting"),
    doneShelfOpen: doneShelfLimit !== null,
    projects,
    unsentKeys,
    draftPlaceLabel: draft?.rowPlaceLabel ?? null,
    selectedId,
    unfoldedGroups,
    quietShownGroups,
    lastOpen,
  });
  const runnersById = new Map(runners.map((runner) => [runner.id, runner]));
  const poses = new Map(
    sessions.map((session) => [
      session.id,
      decideThreadPose(session, runnersById.get(session.runnerId)),
    ]),
  );
  return {
    items,
    counts: countThreadsByPose(sessions, poses),
    openGroupKey:
      groups.find((group) => group.sessions.some((session) => session.id === selectedId))?.key ??
      null,
  };
};

/** How many items the Go menu lists: one per shortcut, ⌘1 to ⌘9. */
const GO_MENU_LIMIT = 9;

/** A Go menu item, and what it stands for: the Go menu lists each identity once. */
interface GoMenuEntry {
  /** The group's key for a thread, the destination's key for an assistant. */
  readonly identity: string;
  readonly item: GoMenuItem;
}

/**
 * Returns the Go menu entry of a sidebar item that opens a thread or an
 * assistant, or `null` for any other item. A group's row opens the session
 * its click opens, and a waiting row opens the session that asks. A line of
 * an unfolded group is not listed, nor a run's session's row: the Go menu
 * stays about the user's own work and assistants (spec 17, "From runs" in
 * Waiting on you). A group on the Done shelf is not listed either, because
 * the user put it away.
 */
const buildGoMenuEntry = (item: SidebarItem): GoMenuEntry | null => {
  switch (item.kind) {
    case "waiting-thread-row":
      return {
        identity: item.groupKey,
        item: { destination: { kind: "thread", sessionId: item.sessionId }, title: item.title },
      };
    case "group-row":
      return {
        identity: item.groupKey,
        item: { destination: { kind: "thread", sessionId: item.openId }, title: item.title },
      };
    case "waiting-assistant-row": {
      const destination = { kind: "assistant", assistantId: item.assistantId } as const;
      return {
        identity: buildDestinationKey(destination),
        item: { destination, title: item.name },
      };
    }
    case "waiting-run-row":
    case "waiting-runs-label":
    case "waiting-header":
    case "project-header":
    case "group-line":
    case "quiet-line":
    case "draft-row":
    case "done-header":
    case "done-group-row":
    case "more":
      return null;
  }
};

/**
 * Returns the first nine threads and assistants the sidebar's list shows,
 * top to bottom, for the Go menu. A group is listed once, where the list
 * shows it first: a group with a session waiting on the user shows under
 * Waiting on you, then again as its row in the project, and the Go menu keeps
 * the first, so it opens the session that asks. An assistant is listed only
 * while Waiting on you shows it: the Assistants section is not part of the
 * list. A run's session is not listed.
 */
export const listGoMenuItems = (items: readonly SidebarItem[]): GoMenuItem[] => {
  const listed = new Map<string, GoMenuItem>();
  for (const item of items) {
    if (listed.size === GO_MENU_LIMIT) break;
    const entry = buildGoMenuEntry(item);
    if (entry !== null && !listed.has(entry.identity)) listed.set(entry.identity, entry.item);
  }
  return [...listed.values()];
};

/**
 * Returns the key of the item that should take focus when the focused item,
 * `goneKey`, leaves the list, or `null` when the list is now empty. `before`
 * is the list that held the item and `after` the list without it. The first
 * of these that exists wins:
 *
 * - when a "more" row leaves, because its section expanded: the first row
 *   of a group, an assistant or a run's session that the section now shows
 *   and did not show before;
 * - when a "n quiet" line leaves, because its sessions are now shown: the
 *   first line of its group that is new;
 * - when a line leaves, because its group folded or its quiet sessions are
 *   shown: the group's row;
 * - the section's "more" row;
 * - the section's header;
 * - the item that now sits where the gone item sat, or the last item when the
 *   list is now shorter than that.
 *
 * Focus stays in the list, so a keyboard user never lands back at the top of
 * the page because the thread they were on was answered or finished.
 */
export const pickFocusFallback = (
  goneKey: string,
  before: readonly SidebarItem[],
  after: readonly SidebarItem[],
): string | null => {
  const index = before.findIndex((item) => item.key === goneKey);
  const gone = before[index];
  if (gone !== undefined) {
    const shownBefore = new Set(before.map((item) => item.key));
    if (gone.kind === "more") {
      const shown = after.find(
        (item) =>
          item.section === gone.section &&
          (item.kind === "waiting-thread-row" ||
            item.kind === "waiting-assistant-row" ||
            item.kind === "waiting-run-row" ||
            item.kind === "group-row" ||
            item.kind === "done-group-row") &&
          !shownBefore.has(item.key),
      );
      if (shown !== undefined) return shown.key;
    }
    if (gone.kind === "quiet-line") {
      const shown = after.find(
        (item) =>
          item.kind === "group-line" &&
          item.groupKey === gone.groupKey &&
          !shownBefore.has(item.key),
      );
      if (shown !== undefined) return shown.key;
    }
    if (gone.kind === "group-line" || gone.kind === "quiet-line") {
      const rowKey = buildGroupRowKey(gone.groupKey);
      if (after.some((item) => item.key === rowKey)) return rowKey;
    }
    for (const key of [buildMoreRowKey(gone.section), buildHeaderKey(gone.section)]) {
      if (after.some((item) => item.key === key)) return key;
    }
  }
  return after[Math.min(Math.max(index, 0), after.length - 1)]?.key ?? null;
};
