/**
 * Builds what the sidebar draws from the session presentation and the user's
 * choices: the flat list of items the virtualized list draws (section
 * headers, group rows and their lines, and "more" and "Show fewer" rows, each with a
 * height that follows the Text size and the space the book puts above it).
 *
 * Which groups of sessions are shown, in which order, in what pose, which
 * session a row opens and which lines it unfolds into is decided in
 * client-core (`selectSidebar`). This file only lays the result out in
 * Bureau's geometry.
 */
import {
  DONE_SHELF_STEP,
  selectSidebar,
  type DoneShelf,
  type DoneShelfRow,
  type DraftPlace,
  type GroupMember,
  type GroupRow,
  type ProjectSection,
  type SidebarChoices,
  type SidebarRow,
  type SidebarView,
  type SessionPresentation,
  type Waiting,
  type WaitingRunSession,
  type WaitingSection,
  type ExpandedSections,
  type WorkspaceLabel,
} from "@hercule/client-core";
import type { Project } from "@hercule/contract";
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
      /** How many sessions of the project's groups wait on the user, shown or hidden. */
      readonly waitingCount: number;
    }
  /**
   * A group's row: the Threads and Agent sessions that work in one workspace.
   * A group of one session draws as a lone thread's row, with no dots.
   */
  | {
      readonly kind: "group-row";
      readonly key: string;
      readonly row: GroupRow;
      /** The session a click opens, as `SidebarRow.openId` decides it. */
      readonly openId: string;
      /** Whether the session `openId` has a colleague in the Office, which decides where a click opens it. */
      readonly seated: boolean;
      /**
       * Whether the row steps back, drawn dimmer: a working group's row does,
       * so the groups that need the user stand out, except the group that
       * holds the open session, which the user is looking at.
       */
      readonly receded: boolean;
      /** Whether the composer of any session of the group holds text or images the user has not sent. */
      readonly unsent: boolean;
      /** Whether the group's lines are drawn under the row. */
      readonly unfolded: boolean;
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
      readonly member: GroupMember;
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
      /** How many groups the shelf holds, shown or hidden. */
      readonly count: number;
      readonly open: boolean;
    }
  /**
   * A group on the Done shelf: every Thread of it is marked Done and every
   * Agent session of it has ended. A group of several sessions unfolds into
   * its lines, as a group row does, so an ended Agent session's transcript
   * can still be opened.
   */
  | {
      readonly kind: "done-group-row";
      readonly key: string;
      readonly row: GroupRow;
      /** The session a click opens, chosen as the group row's is. */
      readonly openId: string;
      /** Whether the session `openId` has a colleague in the Office, which decides where a click opens it. */
      readonly seated: boolean;
      /** When the group's last Thread was marked Done, which the second line shows. */
      readonly doneAt: string;
      readonly unsent: boolean;
      /** Whether the group's lines are drawn under the row. */
      readonly unfolded: boolean;
      /** What the card shows while the pointer rests on the row: every session of the group, Agent sessions too. */
      readonly details: ThreadHoverDetails;
    }
  | { readonly kind: "more"; readonly key: string; readonly label: string }
  | {
      /** The row that collapses an expanded section to its capped list again. */
      readonly kind: "fewer";
      readonly key: string;
      readonly label: string;
      /** The row's accessible name, which says which section it collapses, as the label alone repeats. */
      readonly name: string;
    };

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

/** The items of `Kind`: the one kind, or several kinds that share a row's frame. */
export type SidebarItemOf<Kind extends SidebarItemKind> = Extract<SidebarItem, { kind: Kind }>;

/**
 * The custom property of styles/row-heights.css that holds the height of each
 * kind of item. The list reads the heights from it (`readItemHeights` in
 * sidebar-list.tsx), and each row draws itself at it (`buildItemHeight`), so
 * the two agree whatever the Text size is. The values below are the heights
 * at the default Text size.
 *
 * They were measured with `getBoundingClientRect` in the Bureau book's
 * `desktop/session-active.html`, at 1440 x 900 on a 2x display, in Whitehaven
 * and Orient Express (both give the same numbers):
 *
 * - a section header (`h3.side-h`) is 24;
 * - a Waiting on you row (`.side-row--wait`) is 38, a thread's, an
 *   assistant's and a run's session's alike;
 * - the "From runs" label (`.side-sub`) is 16;
 * - a "more" row (`.side-row--more`, in the book's swarm state) is 28, and
 *   so is the "Show fewer" row, which is drawn as it is.
 *
 * The book's thread row (`.side-row`) is 35, with two tight lines. This
 * app's group row is 52, so two lines read apart at a glance (spec 17 §The
 * sidebar): 6px of padding above and below, the 13px title on an 18px line,
 * 6px, then the 12px second line on a 16px line. The draft's row and a done
 * group's row are drawn the same way. The Done shelf's heading is a section
 * header. A line of an unfolded group, and the "n quiet" line, are 32.
 */
export const ITEM_HEIGHT_PROPERTIES: Readonly<Record<SidebarItemKind, string>> = {
  "waiting-header": "--side-height-header",
  "waiting-thread-row": "--side-height-waiting-row",
  "waiting-assistant-row": "--side-height-waiting-row",
  "waiting-runs-label": "--side-height-runs-label",
  "waiting-run-row": "--side-height-waiting-row",
  "project-header": "--side-height-header",
  "group-row": "--side-height-thread-row",
  "group-line": "--side-height-group-line",
  "quiet-line": "--side-height-group-line",
  "draft-row": "--side-height-thread-row",
  "done-header": "--side-height-header",
  "done-group-row": "--side-height-thread-row",
  more: "--side-height-more-row",
  fewer: "--side-height-more-row",
};

/** Returns the CSS `height` that draws an item of `kind` at its height, which follows the Text size. */
export const buildItemHeight = (kind: SidebarItemKind): string =>
  `var(${ITEM_HEIGHT_PROPERTIES[kind]})`;

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

/** Returns the key of a section's "Show fewer" row. */
const buildFewerRowKey = (section: SectionKey): string => `fewer:${section}`;

/** Returns the key of the row of the group `groupKey` in a project's list. */
const buildGroupRowKey = (groupKey: string): string => `group:${groupKey}`;

/** Returns the key of the row of the group `groupKey` on the Done shelf. */
const buildDoneGroupRowKey = (groupKey: string): string => `done:${groupKey}`;

/**
 * Returns which sections are expanded, in the shape `selectSidebar`
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

/** The text of a "Show fewer" row. */
const FEWER_LABEL = "Show fewer";

/** Returns the content of a Waiting on you row: a thread's or an assistant's. */
const buildWaitingRow = (waiting: Waiting): SidebarItemContent => {
  switch (waiting.kind) {
    case "session":
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
 * - its "more" row when it hides some threads, assistants or runs' sessions,
 *   or, once expanded and the caps would hide some, its "Show fewer" row.
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
  // The runs' cap is kept here, so only the threads' and assistants' part is decided in client-core.
  if (
    expanded &&
    ((waiting?.canCollapse ?? false) || waitingRunSessions.length > WAITING_RUN_SESSION_LIMIT)
  ) {
    contents.push({
      kind: "fewer",
      key: buildFewerRowKey("waiting"),
      label: FEWER_LABEL,
      name: `${FEWER_LABEL} waiting on you`,
    });
  }
  return contents;
};

/** Returns the member of `row` that is the session `sessionId`, which the row holds. */
const findMember = (row: GroupRow, sessionId: string): GroupMember =>
  row.members.find((member) => member.sessionId === sessionId)!;

/**
 * Returns what the card shows for the group of `row`. A group of one session
 * lists no members: its card shows the lead's model instead.
 */
const buildHoverDetails = (
  row: GroupRow,
  place: { readonly projectName: string; readonly tint: ProjectTint | null },
): ThreadHoverDetails => {
  const lead = findMember(row, row.leadId);
  return {
    title: row.title,
    projectName: place.projectName,
    tint: place.tint,
    machine: row.machine,
    branch: row.branch,
    model: lead.model,
    providerId: lead.providerId,
    members: row.summary === null ? [] : row.summary.membersByUrgency,
  };
};

/**
 * Returns the project's name and tint as the card shows them: "No project"
 * and no tint for a group in no project.
 */
const buildProjectPlace = (
  projectId: string | null,
  projects: readonly Project[],
): { readonly projectName: string; readonly tint: ProjectTint | null } => ({
  projectName: projects.find((project) => project.id === projectId)?.name ?? "No project",
  tint: projectId === null ? null : pickProjectTint(projectId, projects),
});

/**
 * Returns the lines of the unfolded group of `shown`: a line for each session
 * it shows, then the "n quiet" line when quiet sessions are folded away.
 */
const buildLineContents = ({ row, lines }: SidebarRow): SidebarItemContent[] =>
  lines.map((line, index): SidebarItemContent => {
    const last = index === lines.length - 1;
    return line.kind === "member"
      ? {
          kind: "group-line",
          key: `line:${line.member.sessionId}`,
          groupKey: row.key,
          groupTitle: row.title,
          member: line.member,
          last,
        }
      : {
          kind: "quiet-line",
          key: `quiet:${row.key}`,
          groupKey: row.key,
          groupTitle: row.title,
          count: line.count,
          last,
        };
  });

/**
 * Returns the items of one group of the project list: its row, then, while
 * the group is unfolded, its lines.
 */
const buildGroupContents = (
  shown: SidebarRow,
  { openGroupKey }: SidebarView,
  { unsentKeys }: SidebarSources,
  place: { readonly projectName: string; readonly tint: ProjectTint | null },
): SidebarItemContent[] => {
  const { row, openId, seated, unfolded } = shown;
  return [
    {
      kind: "group-row",
      key: buildGroupRowKey(row.key),
      row,
      openId,
      seated,
      receded: row.status === "working" && row.key !== openGroupKey,
      unsent: row.members.some((member) => unsentKeys.has(member.sessionId)),
      unfolded,
      details: buildHoverDetails(row, place),
    },
    ...buildLineContents(shown),
  ];
};

/**
 * Returns what a project's section draws: its header, then the draft's row
 * when the project holds the Draft Thread, then its shown groups, the most
 * recently started or reopened first, each followed by its lines while
 * unfolded, then its "more" row when it hides some groups, or its "Show
 * fewer" row when the user expanded it and the cap would hide some. The
 * groups in no project are headed "No project".
 *
 * The draft's row is first because the draft is the newest thread of its
 * project. Groups have no heading of their own: each row names its branch,
 * its workspace or its machine on its second line.
 */
const buildProjectContents = (
  project: ProjectSection,
  view: SidebarView,
  sources: SidebarSources,
): SidebarItemContent[] => {
  const section = buildProjectSectionKey(project.projectId);
  const place = buildProjectPlace(project.projectId, sources.projects);
  const contents: SidebarItemContent[] = [
    {
      kind: "project-header",
      key: buildHeaderKey(section),
      projectId: project.projectId,
      name: place.projectName,
      tint: place.tint,
      waitingCount: project.waitingCount,
    },
  ];
  if (sources.draft !== null && project.holdsDraft) {
    contents.push({
      kind: "draft-row",
      key: "draft",
      placeClip: sources.draft.rowPlaceLabel.clip,
      placeKeep: sources.draft.rowPlaceLabel.keep,
    });
  }
  for (const shown of project.rows) {
    contents.push(...buildGroupContents(shown, view, sources, place));
  }
  if (project.hiddenCount > 0) {
    contents.push({
      kind: "more",
      key: buildMoreRowKey(section),
      label: formatMoreLabel("project", project.hiddenCount),
    });
  }
  if (project.canCollapse) {
    contents.push({
      kind: "fewer",
      key: buildFewerRowKey(section),
      label: FEWER_LABEL,
      name: `${FEWER_LABEL} in ${place.projectName}`,
    });
  }
  return contents;
};

/**
 * Returns the items of a group on the Done shelf: its row, then, while the
 * group is unfolded, its lines, which are the lines of a group in a project's
 * list.
 */
const buildDoneGroupContents = (
  shown: DoneShelfRow,
  { unsentKeys, projects }: SidebarSources,
): SidebarItemContent[] => {
  const { row, openId, seated, unfolded, doneAt } = shown;
  return [
    {
      kind: "done-group-row",
      key: buildDoneGroupRowKey(row.key),
      row,
      openId,
      seated,
      doneAt,
      unsent: row.members.some((member) => unsentKeys.has(member.sessionId)),
      unfolded,
      details: buildHoverDetails(row, buildProjectPlace(row.projectId, projects)),
    },
    ...buildLineContents(shown),
  ];
};

/**
 * Returns what the Done shelf draws, or nothing when no group is done: its
 * heading with the count, then, while it is open or holds the open session,
 * its rows, most recently done first, each followed by its lines while
 * unfolded, then its "more" row when the open shelf hides some.
 */
const buildDoneContents = (doneShelf: DoneShelf, sources: SidebarSources): SidebarItemContent[] => {
  if (doneShelf.count === 0) return [];
  const contents: SidebarItemContent[] = [
    {
      kind: "done-header",
      key: buildHeaderKey("done"),
      count: doneShelf.count,
      open: sources.doneShelfLimit !== null,
    },
    ...doneShelf.rows.flatMap((shown) => buildDoneGroupContents(shown, sources)),
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
 * the order of `view.projects`, then the Done shelf when a group is done.
 */
const buildSidebarItems = (view: SidebarView, sources: SidebarSources): readonly SidebarItem[] => [
  ...placeInSection(
    "waiting",
    buildWaitingContents(view.waiting, sources.waitingRunSessions, sources.expanded.has("waiting")),
  ),
  ...view.projects.flatMap((project) =>
    placeInSection(
      buildProjectSectionKey(project.projectId),
      buildProjectContents(project, view, sources),
    ),
  ),
  ...placeInSection("done", buildDoneContents(view.doneShelf, sources)),
];

/**
 * What the sidebar is built from: the session presentation, the lists the
 * items are laid out with, and the user's choices. The choices `SidebarChoices`
 * names are applied by client-core, apart from the draft and the expanded
 * sections, which the sidebar holds in a shape of its own.
 */
export interface SidebarSources extends Omit<SidebarChoices, "draft" | "expanded"> {
  readonly presentation: SessionPresentation;
  /**
   * The runs' sessions waiting on the user, newest activity first, as
   * `listWaitingRunSessions` returns them.
   */
  readonly waitingRunSessions: readonly WaitingRunSession[];
  /** The project list in its own order, which decides each project's tint. */
  readonly projects: readonly Project[];
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
}

/** What the sidebar draws: the items of its list. */
export interface Sidebar {
  readonly items: readonly SidebarItem[];
  /** The key of the group that holds the open session, shown or not, or `null` when it is in none. */
  readonly openGroupKey: string | null;
}

/** Returns what the sidebar draws from `sources`: its items, top to bottom. */
export const buildSidebar = (sources: SidebarSources): Sidebar => {
  const view = selectSidebar(sources.presentation, {
    ...sources,
    draft: sources.draft?.place ?? null,
    expanded: buildExpandedSections(sources.expanded),
  });
  return { items: buildSidebarItems(view, sources), openGroupKey: view.openGroupKey };
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
        identity: item.row.key,
        item: { destination: { kind: "thread", sessionId: item.openId }, title: item.row.title },
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
    case "fewer":
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
      const rowKey =
        gone.section === "done"
          ? buildDoneGroupRowKey(gone.groupKey)
          : buildGroupRowKey(gone.groupKey);
      if (after.some((item) => item.key === rowKey)) return rowKey;
    }
    for (const key of [buildMoreRowKey(gone.section), buildHeaderKey(gone.section)]) {
      if (after.some((item) => item.key === key)) return key;
    }
  }
  return after[Math.min(Math.max(index, 0), after.length - 1)]?.key ?? null;
};
