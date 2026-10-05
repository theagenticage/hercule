/**
 * Builds what the sidebar draws from the lists it reads: the flat list of
 * items the virtualized list draws (section headers, workspace labels, rows
 * and "more" rows, each with a fixed height and the space the book puts above
 * it), and the thread counts in the foot.
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
  formatRequestQuestion,
  type DraftPlace,
  type ExpandedSections,
  type Pose,
  type ProjectGroup,
  type ProjectSection,
  type SidebarSections,
  type ThreadCounts,
  type ThreadRowEnd,
  type WaitingSection,
} from "@hercule/client-core";
import type {
  Project,
  ProviderInstance,
  Resource,
  Runner,
  Session,
  Workspace,
} from "@hercule/contract";
import type { GoMenuThread } from "../../ipc/contract";
import { pickProjectTint, type ProjectTint } from "../screens/project-tile";

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
      readonly kind: "waiting-row";
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
    }
  | {
      readonly kind: "workspace-label";
      readonly key: string;
      /** The project the workspace is in, which a new thread joining it starts in. */
      readonly projectId: string;
      /**
       * The workspace a new thread started from the label joins. `null` for
       * the threads that work without a checkout, and for a workspace that is
       * not ready, which a new thread cannot join.
       */
      readonly joinableWorkspaceId: string | null;
      readonly clip: string;
      readonly keep: string;
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
    }
  | {
      readonly kind: "draft-row";
      readonly key: string;
      /** Where the draft will work and on which machine, such as "New workspace · studio-mac". */
      readonly meta: string;
    }
  | { readonly kind: "more"; readonly key: string; readonly label: string };

/**
 * One entry of the sidebar's list: what it draws, the section it belongs to,
 * and the space above it.
 */
export type SidebarItem = SidebarItemContent & {
  readonly section: SectionKey;
  /**
   * The space above the item, in CSS pixels: 8 above a section's first item,
   * 9 above a workspace label that follows a thread row, 1 above the others.
   */
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
 * - a Waiting on you row (`.side-row--wait`) is 38;
 * - a thread row (`.side-row`) is 35, and so is the draft's row, which is
 *   drawn as one;
 * - a "more" row (`.side-row--more`, in the book's swarm state) is 28.
 *
 * The book has no workspace label, so its 22 is this app's own design.
 */
export const ITEM_HEIGHTS: Readonly<Record<SidebarItemKind, number>> = {
  "waiting-header": 24,
  "waiting-row": 38,
  "project-header": 24,
  "workspace-label": 22,
  "thread-row": 35,
  "draft-row": 35,
  more: 28,
};

/** The space above a section's first item: the book's `.side-sec { padding-top: 8px }`. */
const SECTION_LEADING = 8;

/** The space between two items of a section: the book's `.side-sec { gap: 1px }`. */
const ITEM_LEADING = 1;

/**
 * The space above a workspace label that follows a thread row, or the draft's
 * row: the usual gap plus 8 px, so the label starts a new group of rows
 * instead of reading as the row's third line. A label right after its
 * project's header keeps the usual gap. The book draws no workspace label, so
 * this spacing is the design's own.
 */
const WORKSPACE_LABEL_LEADING = ITEM_LEADING + 8;

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

/** What the items need to know about the threads, beyond the sections. */
interface SidebarItemSources {
  readonly sections: SidebarSections;
  readonly sessions: ReadonlyMap<string, Session>;
  readonly poses: ReadonlyMap<string, Pose>;
  readonly runners: ReadonlyMap<string, Runner>;
  /** The project list in its own order, which decides each project's tint. */
  readonly projects: readonly Project[];
  /**
   * The second line of the draft's row, while a Draft Thread is open, or
   * `null`. The row is drawn in the workspace group the sections mark as
   * holding the draft.
   */
  readonly draftMeta: string | null;
}

/**
 * Returns the space above `content`, which follows `previous` in its
 * section, or starts it when `previous` is undefined.
 */
const decideLeading = (
  content: SidebarItemContent,
  previous: SidebarItemContent | undefined,
): number => {
  if (previous === undefined) return SECTION_LEADING;
  if (
    content.kind === "workspace-label" &&
    (previous.kind === "thread-row" || previous.kind === "draft-row")
  ) {
    return WORKSPACE_LABEL_LEADING;
  }
  return ITEM_LEADING;
};

/** Returns a section's items: its contents, each given the section and the space above it. */
const placeInSection = (
  section: SectionKey,
  contents: readonly SidebarItemContent[],
): SidebarItem[] =>
  contents.map((content, index) => ({
    ...content,
    section,
    leading: decideLeading(content, contents[index - 1]),
  }));

/**
 * Returns what Waiting on you draws: its header, its rows, and its "more" row
 * when it hides some.
 */
const buildWaitingContents = (
  waiting: WaitingSection,
  sessions: ReadonlyMap<string, Session>,
): SidebarItemContent[] => {
  const contents: SidebarItemContent[] = [
    {
      kind: "waiting-header",
      key: buildHeaderKey("waiting"),
      count: waiting.rows.length + waiting.hiddenCount,
    },
  ];
  for (const row of waiting.rows) {
    // A thread with several open Requests shows the oldest.
    const request = sessions.get(row.id)?.openRequests[0];
    if (request === undefined) continue;
    contents.push({
      kind: "waiting-row",
      key: `waiting:${row.id}`,
      sessionId: row.id,
      title: row.title,
      question: formatRequestQuestion(request),
    });
  }
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
 * Returns what a project's section draws: its header, then per workspace
 * group its label (when the group has one), its rows and, in the group that
 * holds the draft, the draft's row, then its "more" row when it hides some.
 * The threads in no project are headed "No project".
 *
 * The draft's row is its group's last, as its tab is the last of the
 * header's tabs. A draft that starts a new workspace has a group of its own,
 * right under the project's header.
 */
const buildProjectContents = (
  project: ProjectSection,
  { sessions, poses, runners, projects, draftMeta }: SidebarItemSources,
): SidebarItemContent[] => {
  const section = buildProjectSectionKey(project.projectId);
  const contents: SidebarItemContent[] = [
    {
      kind: "project-header",
      key: buildHeaderKey(section),
      projectId: project.projectId,
      // Only the group of the threads in no project has no name.
      name: project.name ?? "No project",
      tint: project.projectId === null ? null : pickProjectTint(project.projectId, projects),
    },
  ];
  for (const lane of project.workspaces) {
    // Only the threads in no project have no project id, and they are one
    // group with no label.
    if (lane.label !== null && project.projectId !== null) {
      contents.push({
        kind: "workspace-label",
        key: `workspace:${section}:${lane.key}`,
        projectId: project.projectId,
        joinableWorkspaceId: lane.joinable ? lane.workspaceId : null,
        clip: lane.label.clip,
        keep: lane.label.keep,
      });
    }
    for (const row of lane.rows) {
      const session = sessions.get(row.id);
      const pose = poses.get(row.id);
      if (session === undefined || pose === undefined) continue;
      const runner = session.runnerId === null ? undefined : runners.get(session.runnerId);
      contents.push({
        kind: "thread-row",
        key: `thread:${row.id}`,
        sessionId: row.id,
        title: row.title,
        secondLine: row.secondLine,
        pose,
        end: flattenRowEnd(decideThreadRowEnd(session, runner)),
        activityAt: row.activityAt,
      });
    }
    if (lane.draft && draftMeta !== null) {
      contents.push({ kind: "draft-row", key: "draft", meta: draftMeta });
    }
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
 * Returns the sidebar's items, top to bottom: Waiting on you when a thread is
 * waiting, then each project's section in the order of `sections.projects`.
 *
 * A row whose session is missing from `sessions` or `poses` is left out. All
 * three are built from one read of the thread list, so this does not happen.
 */
const buildSidebarItems = (sources: SidebarItemSources): readonly SidebarItem[] => {
  const { sections, sessions } = sources;
  return [
    ...(sections.waiting === null
      ? []
      : placeInSection("waiting", buildWaitingContents(sections.waiting, sessions))),
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
  /** The project list in its own order, which decides each project's tint. */
  readonly projects: readonly Project[];
  readonly workspaces: readonly Workspace[];
  readonly resources: readonly Resource[];
  readonly runners: readonly Runner[];
  /** The instances whose catalogs give a row its model name. */
  readonly instances: readonly ProviderInstance[];
  /**
   * The open Draft Thread, or `null`: the group it will join, and the second
   * line of its row, such as "New workspace · studio-mac".
   */
  readonly draft: { readonly place: DraftPlace; readonly rowMeta: string } | null;
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
 * Each thread's pose is decided once, here, and serves the order of the
 * sections, the rows' marks and the counts.
 */
export const buildSidebar = ({
  threads,
  projects,
  workspaces,
  resources,
  runners,
  instances,
  draft,
  expanded,
  selectedId,
}: SidebarSources): Sidebar => {
  const runnersById = new Map(runners.map((runner) => [runner.id, runner]));
  const poses = new Map(
    threads.map((session) => [
      session.id,
      decideThreadPose(
        session,
        session.runnerId === null ? undefined : runnersById.get(session.runnerId),
      ),
    ]),
  );
  const groups = buildThreadGroups({
    sessions: threads,
    projects,
    workspaces,
    resources,
    runners,
    instances,
    mode: "meta",
    draft: draft?.place ?? null,
  });
  const sections = buildSidebarSections({
    groups,
    poses,
    expanded: buildExpandedSections(expanded, groups),
    selectedId,
  });
  const items = buildSidebarItems({
    sections,
    sessions: new Map(threads.map((session) => [session.id, session])),
    poses,
    runners: runnersById,
    projects,
    draftMeta: draft?.rowMeta ?? null,
  });
  return { items, counts: countThreadsByPose(poses.values()) };
};

/** How many threads the Go menu lists: one per shortcut, ⌘1 to ⌘9. */
const GO_MENU_THREAD_LIMIT = 9;

/**
 * Returns the first nine threads the sidebar shows, top to bottom, for the Go
 * menu. A waiting thread shows twice, under Waiting on you and in its project,
 * and is listed once, where it shows first.
 */
export const listGoMenuThreads = (items: readonly SidebarItem[]): GoMenuThread[] => {
  const threads = new Map<string, GoMenuThread>();
  for (const item of items) {
    if (threads.size === GO_MENU_THREAD_LIMIT) break;
    if (
      (item.kind === "waiting-row" || item.kind === "thread-row") &&
      !threads.has(item.sessionId)
    ) {
      threads.set(item.sessionId, { sessionId: item.sessionId, title: item.title });
    }
  }
  return [...threads.values()];
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
          (item.kind === "waiting-row" || item.kind === "thread-row") &&
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
