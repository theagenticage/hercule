/**
 * Builds what the sidebar draws from the lists it reads: the flat list of
 * items the virtualized list draws (section headers, rows and "more" rows,
 * each with a fixed height and the space the book puts above it), and the
 * thread counts in the foot.
 *
 * Which threads are shown, in which order, and in what pose is decided in
 * client-core. This file only lays the result out in Bureau's geometry.
 */
import {
  buildSidebarSections,
  buildThreadGroups,
  countThreadsByPose,
  decideThreadPose,
  decideThreadRowEnd,
  holdsDraft,
  listProjectRows,
  sortProjectsByNewestThread,
  type DraftPlace,
  type ExpandedSections,
  type Pose,
  type ProjectGroup,
  type ProjectSection,
  type SidebarSections,
  type ThreadCounts,
  type ThreadRowEnd,
  type Waiting,
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
 * The end of a thread row, as one string so a memoized row can compare it:
 *
 * - `working` or `waiting`: that state's mark;
 * - `queued` or `offline`: the word;
 * - `age`: how long ago the thread was last active.
 */
export type RowEnd = "working" | "waiting" | "queued" | "offline" | "age";

/**
 * Which section an item belongs to: `waiting`, or `project:<id>`, with `none`
 * for the threads in no project.
 */
export type SectionKey = "waiting" | `project:${string}`;

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
      readonly title: string;
      readonly question: string;
    }
  | {
      readonly kind: "waiting-assistant-row";
      readonly key: string;
      readonly assistantId: string;
      readonly name: string;
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
    }
  | {
      readonly kind: "thread-row";
      readonly key: string;
      readonly sessionId: string;
      readonly title: string;
      readonly secondLine: string | null;
      readonly pose: Pose;
      readonly end: RowEnd;
      readonly activityAt: string;
      /**
       * The row's third line, the thread's workspace, in two parts: the
       * part that may be cut short, such as "hercule/thread-3f1", "webshop"
       * or "No workspace", and the part that never is, such as " · moss",
       * or "" when there is none.
       */
      readonly workspaceClip: string;
      readonly workspaceKeep: string;
      /**
       * Where the thread works, in words, for the row's accessible
       * description, such as "in webshop, webshop main workspace, on moss,
       * branch main".
       */
      readonly placeDescription: string;
      /** Whether the thread's composer holds text or images the user has not sent. */
      readonly unsent: boolean;
      /** What the card shows while the pointer rests on the row. */
      readonly details: ThreadHoverDetails;
    }
  | {
      readonly kind: "draft-row";
      readonly key: string;
      /** The name of the model the draft will run, or `null` while it has none. */
      readonly model: string | null;
      /**
       * Where the draft will work and on which machine, in the two parts of a
       * thread row's third line, such as "New workspace" and " · studio-mac".
       */
      readonly workspaceClip: string;
      readonly workspaceKeep: string;
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
 * - a Waiting on you row (`.side-row--wait`) is 38, a thread's and an
 *   assistant's alike;
 * - a "more" row (`.side-row--more`, in the book's swarm state) is 28.
 *
 * The book's thread row (`.side-row`) is 35, with two lines. This app's
 * thread row has a third line, the workspace, so its height is its own: the
 * row's 1px padding above and below, plus three lines at `.side-text`'s line
 * height of 1.3: the 13px title (16.9px) and two 12px lines (15.6px each).
 * That is 50.1, and 8px more gives 58.1, rounded up to 59 so every row
 * starts on a whole pixel. The row centres its text, so the 8px is split
 * above and below it: with three lines, rows that sat almost touching were
 * hard to tell apart. The draft's row is drawn as a thread row, with the
 * same three lines.
 */
export const ITEM_HEIGHTS: Readonly<Record<SidebarItemKind, number>> = {
  "waiting-header": 24,
  "waiting-thread-row": 38,
  "waiting-assistant-row": 38,
  "project-header": 24,
  "thread-row": 59,
  "draft-row": 59,
  more: 28,
};

/** The space above a section's first item: the book's `.side-sec { padding-top: 8px }`. */
const SECTION_LEADING = 8;

/** The space between two items of a section: the book's `.side-sec { gap: 1px }`. */
const ITEM_LEADING = 1;

/** Returns the section key of a project's section. */
const buildProjectSectionKey = (projectId: string | null): SectionKey =>
  `project:${projectId ?? "none"}`;

/** Returns the key of a section's header. */
const buildHeaderKey = (section: SectionKey): string => `header:${section}`;

/** Returns the key of a section's "more" row. */
const buildMoreRowKey = (section: SectionKey): string => `more:${section}`;

/**
 * Returns which sections are expanded, in the shape `buildSidebarSections`
 * takes, from the keys of the sections whose "more" row the user pressed.
 */
const buildExpandedSections = (
  expanded: ReadonlySet<SectionKey>,
  groups: readonly ProjectGroup[],
): ExpandedSections => ({
  waiting: expanded.has("waiting"),
  projectIds: new Set(
    groups
      .map((group) => group.projectId)
      .filter((projectId) => expanded.has(buildProjectSectionKey(projectId))),
  ),
});

/** Returns the one string a thread row's end is drawn from. */
const flattenRowEnd = (end: ThreadRowEnd): RowEnd => {
  switch (end.kind) {
    case "mark":
      return end.mark;
    case "word":
      return end.word;
    case "age":
      return "age";
  }
};

/**
 * Returns the text of a section's "more" row, such as "27 more waiting on
 * you" or "1 more thread".
 */
const formatMoreLabel = (section: "waiting" | "project", hidden: number): string =>
  section === "waiting"
    ? `${String(hidden)} more waiting on you`
    : `${String(hidden)} more ${hidden === 1 ? "thread" : "threads"}`;

/** Returns the content of a Waiting on you row: a thread's or an assistant's. */
const buildWaitingRow = (waiting: Waiting): SidebarItemContent => {
  switch (waiting.kind) {
    case "thread":
      return {
        kind: "waiting-thread-row",
        key: `waiting:${buildDestinationKey({ kind: "thread", sessionId: waiting.sessionId })}`,
        sessionId: waiting.sessionId,
        title: waiting.title,
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

/** What the items need to know about the threads, beyond the sections. */
interface SidebarItemSources {
  readonly sections: SidebarSections;
  readonly sessions: ReadonlyMap<string, Session>;
  /** Each thread's pose and its row's end, by session id. */
  readonly poses: ReadonlyMap<string, Pose>;
  readonly ends: ReadonlyMap<string, RowEnd>;
  /** The project list in its own order, which decides each project's tint. */
  readonly projects: readonly Project[];
  /** The lists a row names its workspace, machine, branch and provider from. */
  readonly workspaces: readonly Workspace[];
  readonly resources: readonly Resource[];
  readonly runners: readonly Runner[];
  readonly instances: readonly ProviderInstance[];
  /** The session ids of the threads whose composer holds unsent work. */
  readonly unsentKeys: ReadonlySet<string>;
  /**
   * The draft's row, while a Draft Thread is open, or `null`: its model and
   * its third line. The row is drawn first in the project the sections mark
   * as holding the draft.
   */
  readonly draftRow: {
    readonly model: string | null;
    readonly workspace: WorkspaceLabel;
  } | null;
}

/** Returns a section's items: its contents, each given the section and the space above it. */
const placeInSection = (
  section: SectionKey,
  contents: readonly SidebarItemContent[],
): SidebarItem[] =>
  contents.map((content, index) => ({
    ...content,
    section,
    leading: index === 0 ? SECTION_LEADING : ITEM_LEADING,
  }));

/**
 * Returns what Waiting on you draws: its header, its rows, threads and
 * assistants in the section's order, and its "more" row when it hides some.
 */
const buildWaitingContents = (waiting: WaitingSection): SidebarItemContent[] => {
  const contents: SidebarItemContent[] = [
    {
      kind: "waiting-header",
      key: buildHeaderKey("waiting"),
      count: waiting.rows.length + waiting.hiddenCount,
    },
    ...waiting.rows.map(buildWaitingRow),
  ];
  if (waiting.hiddenCount > 0) {
    contents.push({
      kind: "more",
      key: buildMoreRowKey("waiting"),
      label: formatMoreLabel("waiting", waiting.hiddenCount),
    });
  }
  return contents;
};

/**
 * Returns what a project's section draws: its header, then the draft's row
 * when the project holds the Draft Thread, then its shown threads in one
 * list, newest created first, then its "more" row when it hides some. The
 * threads in no project are headed "No project".
 *
 * The draft's row is first because the draft is the newest thread of its
 * project. Workspaces have no group of their own: each row names its
 * workspace on its third line.
 */
const buildProjectContents = (
  project: ProjectSection,
  {
    sessions,
    poses,
    ends,
    projects,
    workspaces,
    resources,
    runners,
    instances,
    unsentKeys,
    draftRow,
  }: SidebarItemSources,
): SidebarItemContent[] => {
  const section = buildProjectSectionKey(project.projectId);
  // Only the group of the threads in no project has no name.
  const projectName = project.name ?? "No project";
  const tint = project.projectId === null ? null : pickProjectTint(project.projectId, projects);
  const contents: SidebarItemContent[] = [
    {
      kind: "project-header",
      key: buildHeaderKey(section),
      projectId: project.projectId,
      name: projectName,
      tint,
    },
  ];
  if (draftRow !== null && holdsDraft(project)) {
    contents.push({
      kind: "draft-row",
      key: "draft",
      model: draftRow.model,
      workspaceClip: draftRow.workspace.clip,
      workspaceKeep: draftRow.workspace.keep,
    });
  }
  const rows = listProjectRows({
    group: project,
    sessions,
    workspaces,
    resources,
    runners,
    instances,
  });
  for (const row of rows) {
    const pose = poses.get(row.id);
    const end = ends.get(row.id);
    if (pose === undefined || end === undefined) continue;
    contents.push({
      kind: "thread-row",
      key: `thread:${row.id}`,
      sessionId: row.id,
      title: row.title,
      secondLine: row.secondLine,
      pose,
      end,
      activityAt: row.activityAt,
      workspaceClip: row.workspace.clip,
      workspaceKeep: row.workspace.keep,
      placeDescription: row.placeDescription,
      unsent: unsentKeys.has(row.id),
      details: {
        title: row.title,
        projectName,
        tint,
        machine: row.machine,
        branch: row.branch,
        model: row.secondLine,
        providerId: row.providerId,
      },
    });
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

/**
 * Returns `groups` without the workspace groups that hold no thread and not
 * the draft, and without the projects left with no workspace group. The
 * desktop sidebar lists threads, so a workspace no thread uses, kept or
 * failed, is not shown in it (spec 17 §The sidebar).
 */
const dropEmptyWorkspaceGroups = (groups: readonly ProjectGroup[]): readonly ProjectGroup[] =>
  groups.flatMap((group) => {
    const workspaces = group.workspaces.filter((lane) => lane.rows.length > 0 || lane.draft);
    return workspaces.length === 0 ? [] : [{ ...group, workspaces }];
  });

/**
 * Returns the sidebar's items, top to bottom: Waiting on you when a thread or
 * an assistant is waiting, then each project's section in the order of
 * `sections.projects`.
 *
 * A thread row whose session is missing from `sessions`, `poses` or `ends`
 * is left out. All of them are built from one read of the thread list, so
 * this does not happen.
 */
const buildSidebarItems = (sources: SidebarItemSources): readonly SidebarItem[] => {
  const { sections } = sources;
  return [
    ...(sections.waiting === null
      ? []
      : placeInSection("waiting", buildWaitingContents(sections.waiting))),
    ...sections.projects.flatMap((project) =>
      placeInSection(
        buildProjectSectionKey(project.projectId),
        buildProjectContents(project, sources),
      ),
    ),
  ];
};

/** What the sidebar is built from: the lists it reads, the open draft, and the user's choices. */
export interface SidebarSources {
  readonly threads: readonly Session[];
  /** The threads and the assistants waiting on the user, as `listWaiting` returns them. */
  readonly waiting: readonly Waiting[];
  /** The project list in its own order, which decides each project's tint. */
  readonly projects: readonly Project[];
  readonly workspaces: readonly Workspace[];
  readonly resources: readonly Resource[];
  readonly runners: readonly Runner[];
  /** The instances whose catalogs give a row its model name. */
  readonly instances: readonly ProviderInstance[];
  /**
   * The open Draft Thread, or `null`: the group it will join, and its row's
   * model name and third line, such as "New workspace" and " · studio-mac".
   */
  readonly draft: {
    readonly place: DraftPlace;
    readonly rowModel: string | null;
    readonly rowWorkspace: WorkspaceLabel;
  } | null;
  /** The keys of the composers that hold unsent work: a thread's key is its session id. */
  readonly unsentKeys: ReadonlySet<string>;
  /** The keys of the sections whose "more" row the user pressed. */
  readonly expanded: ReadonlySet<SectionKey>;
  /** The session id of the open thread, which its section always shows, or `null`. */
  readonly selectedId: string | null;
}

/** What the sidebar draws: the items of its list, and the thread counts in its foot. */
export interface Sidebar {
  readonly items: readonly SidebarItem[];
  readonly counts: ThreadCounts;
}

/**
 * Returns what the sidebar draws from `sources`: its items, top to bottom,
 * and how many threads are working, waiting and idle.
 *
 * Each thread's pose and its row's end are decided once, here. The pose
 * serves the order of the sections, the rows' names and the counts.
 */
export const buildSidebar = ({
  threads,
  waiting,
  projects,
  workspaces,
  resources,
  runners,
  instances,
  draft,
  unsentKeys,
  expanded,
  selectedId,
}: SidebarSources): Sidebar => {
  const runnersById = new Map(runners.map((runner) => [runner.id, runner]));
  const findRunner = (session: Session): Runner | undefined =>
    session.runnerId === null ? undefined : runnersById.get(session.runnerId);
  const poses = new Map(
    threads.map((session) => [session.id, decideThreadPose(session, findRunner(session))]),
  );
  const ends = new Map(
    threads.map((session) => [
      session.id,
      flattenRowEnd(decideThreadRowEnd(session, findRunner(session))),
    ]),
  );
  const sessions = new Map(threads.map((session) => [session.id, session]));
  const groupedThreads = buildThreadGroups({
    sessions: threads,
    projects,
    workspaces,
    resources,
    runners,
    instances,
    mode: "meta",
    draft: draft?.place ?? null,
  });
  const groups = sortProjectsByNewestThread(dropEmptyWorkspaceGroups(groupedThreads), sessions);
  const sections = buildSidebarSections({
    groups,
    waiting,
    poses,
    expanded: buildExpandedSections(expanded, groups),
    selectedId,
  });
  const items = buildSidebarItems({
    sections,
    sessions,
    poses,
    ends,
    projects,
    workspaces,
    resources,
    runners,
    instances,
    unsentKeys,
    draftRow: draft === null ? null : { model: draft.rowModel, workspace: draft.rowWorkspace },
  });
  return { items, counts: countThreadsByPose(poses.values()) };
};

/** How many items the Go menu lists: one per shortcut, ⌘1 to ⌘9. */
const GO_MENU_LIMIT = 9;

/**
 * Returns the Go menu item of a sidebar item that opens a thread or an
 * assistant, or `null` for any other item.
 */
const buildGoMenuItem = (item: SidebarItem): GoMenuItem | null => {
  switch (item.kind) {
    case "waiting-thread-row":
    case "thread-row":
      return { destination: { kind: "thread", sessionId: item.sessionId }, title: item.title };
    case "waiting-assistant-row":
      return {
        destination: { kind: "assistant", assistantId: item.assistantId },
        title: item.name,
      };
    case "waiting-header":
    case "project-header":
    case "draft-row":
    case "more":
      return null;
  }
};

/**
 * Returns the first nine threads and assistants the sidebar's list shows,
 * top to bottom, for the Go menu. A waiting thread shows twice, under Waiting
 * on you and in its project, and is listed once, where it shows first. An
 * assistant is listed only while Waiting on you shows it: the Assistants
 * section is not part of the list.
 */
export const listGoMenuItems = (items: readonly SidebarItem[]): GoMenuItem[] => {
  const listed = new Map<string, GoMenuItem>();
  for (const item of items) {
    if (listed.size === GO_MENU_LIMIT) break;
    const goMenuItem = buildGoMenuItem(item);
    if (goMenuItem === null) continue;
    const key = buildDestinationKey(goMenuItem.destination);
    if (!listed.has(key)) listed.set(key, goMenuItem);
  }
  return [...listed.values()];
};

/**
 * Returns the key of the item that should take focus when the focused item,
 * `goneKey`, leaves the list, or `null` when the list is now empty. `before`
 * is the list that held the item and `after` the list without it. The first
 * of these that exists wins:
 *
 * - when a "more" row leaves, because its section expanded: the first thread
 *   row the section now shows that it did not show before;
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
    if (gone.kind === "more") {
      const shownBefore = new Set(before.map((item) => item.key));
      const shown = after.find(
        (item) =>
          item.section === gone.section &&
          (item.kind === "waiting-thread-row" ||
            item.kind === "waiting-assistant-row" ||
            item.kind === "thread-row") &&
          !shownBefore.has(item.key),
      );
      if (shown !== undefined) return shown.key;
    }
    for (const key of [buildMoreRowKey(gone.section), buildHeaderKey(gone.section)]) {
      if (after.some((item) => item.key === key)) return key;
    }
  }
  return after[Math.min(Math.max(index, 0), after.length - 1)]?.key ?? null;
};
