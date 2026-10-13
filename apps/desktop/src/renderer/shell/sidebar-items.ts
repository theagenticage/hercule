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
  buildDoneShelf,
  buildSidebarSections,
  buildThreadGroups,
  countThreadsByPose,
  DONE_SHELF_STEP,
  decideThreadPose,
  decideThreadRowStatus,
  holdsDraft,
  isMarkedDone,
  listProjectRows,
  sortProjectsByNewestThread,
  type DoneShelf,
  type DraftPlace,
  type ExpandedSections,
  type Pose,
  type ProjectGroup,
  type ProjectSection,
  type SidebarSections,
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
  | {
      readonly kind: "thread-row";
      readonly key: string;
      readonly sessionId: string;
      readonly title: string;
      readonly pose: Pose;
      readonly status: ThreadRowStatus;
      /**
       * Whether the row steps back, drawn dimmer: a working thread's row does,
       * so the threads that need the user stand out, except the open
       * thread's, which the user is looking at.
       */
      readonly receded: boolean;
      /**
       * When the thread was last active, which an `age` status counts from,
       * or "" for any other status. Only an `age` row reads it, so a working
       * row does not draw again each time its thread does something.
       */
      readonly activityAt: string;
      /**
       * Where the thread works, the row's second line after the provider's
       * mark, in two parts: the part that may be cut short, such as
       * "rogier/fix-" or "webshop", and the part that never is, such as
       * "sidebar-rows" or " · moss", or "" when there is none.
       */
      readonly placeClip: string;
      readonly placeKeep: string;
      /** The provider of the thread's instance, whose mark leads the second line, or `null`. */
      readonly providerId: string | null;
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
  /** A thread marked Done, on the Done shelf. */
  | {
      readonly kind: "done-row";
      readonly key: string;
      readonly sessionId: string;
      readonly title: string;
      readonly pose: Pose;
      /** When the thread was marked Done, which its second line counts from. */
      readonly doneAt: string;
      readonly providerId: string | null;
      readonly unsent: boolean;
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
 * app's thread row is 52, so two lines read apart at a glance (spec 17 §The
 * sidebar): 6px of padding above and below, the 13px title on an 18px line,
 * 6px, then the 12px second line on a 16px line. The draft's row and a done
 * thread's row are drawn the same way. The Done shelf's heading is a section
 * header.
 */
export const ITEM_HEIGHTS: Readonly<Record<SidebarItemKind, number>> = {
  "waiting-header": 24,
  "waiting-thread-row": 38,
  "waiting-assistant-row": 38,
  "waiting-runs-label": 16,
  "waiting-run-row": 38,
  "project-header": 24,
  "thread-row": 52,
  "draft-row": 52,
  "done-header": 24,
  "done-row": 52,
  more: 28,
};

/** The space above a section's first item: the book's `.side-sec { padding-top: 8px }`. */
const SECTION_LEADING = 8;

/** The space between two items of a section: the book's `.side-sec { gap: 1px }`. */
const ITEM_LEADING = 1;

/**
 * The space between two tall rows, each a thread's, a draft's or a done
 * thread's: 2px, where the book has 1px, because two tall rows that touch on
 * hover read as one. Under a header, a row keeps the book's 1px.
 */
const THREAD_ROW_LEADING = 2;

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

/**
 * Returns the text of a section's "more" row, such as "27 more waiting on
 * you", "1 more thread", or "Show 25 more" on the Done shelf, which shows
 * at most `DONE_SHELF_STEP` more on each press.
 */
const formatMoreLabel = (section: "waiting" | "project" | "done", hidden: number): string => {
  switch (section) {
    case "waiting":
      return `${String(hidden)} more waiting on you`;
    case "project":
      return `${String(hidden)} more ${hidden === 1 ? "thread" : "threads"}`;
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

/** Returns the content of a run's session's row in Waiting on you, under "From runs". */
const buildWaitingRunRow = (run: WaitingRunSession): SidebarItemContent => ({
  kind: "waiting-run-row",
  key: `waiting-run:${run.sessionId}`,
  sessionId: run.sessionId,
  title: run.title,
  question: run.question,
});

/** What the items need to know about the threads, beyond the sections. */
interface SidebarItemSources {
  readonly sections: SidebarSections;
  /** The runs' sessions waiting on the user, newest activity first. */
  readonly waitingRunSessions: readonly WaitingRunSession[];
  /** Whether the user expanded Waiting on you, so it shows every run's session too. */
  readonly waitingExpanded: boolean;
  /** The Done shelf, and whether the user opened it. */
  readonly doneShelf: DoneShelf;
  readonly doneShelfOpen: boolean;
  readonly sessions: ReadonlyMap<string, Session>;
  /** Each thread's pose and its row's status, by session id. */
  readonly poses: ReadonlyMap<string, Pose>;
  readonly statuses: ReadonlyMap<string, ThreadRowStatus>;
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
   * The draft's second line, while a Draft Thread is open, or `null`. The
   * draft's row is drawn first in the project the sections mark as holding
   * the draft.
   */
  readonly draftPlaceLabel: WorkspaceLabel | null;
  /** The session id of the open thread, whose row never recedes, or `null`. */
  readonly selectedId: string | null;
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

/** Checks whether an item of `kind` is a tall thread row: a thread's, a draft's or a Done thread's. */
const isTallRow = (kind: SidebarItemKind | undefined): boolean =>
  kind === "thread-row" || kind === "draft-row" || kind === "done-row";

/**
 * Returns the space above an item of `kind` that is not its section's first,
 * when the item above it is of `previous` kind.
 */
const pickLeading = (kind: SidebarItemKind, previous: SidebarItemKind | undefined): number => {
  if (kind === "waiting-runs-label") return RUNS_LABEL_LEADING;
  return isTallRow(kind) && isTallRow(previous) ? THREAD_ROW_LEADING : ITEM_LEADING;
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
 * Returns what a project's section draws: its header, then the draft's row
 * when the project holds the Draft Thread, then its shown threads in one
 * list, the most recently started or reopened first, then its "more" row when it hides some.
 * The threads in no project are headed "No project".
 *
 * The draft's row is first because the draft is the newest thread of its
 * project. Workspaces have no group of their own: each row names its
 * branch, its workspace or its machine on its second line.
 */
const buildProjectContents = (
  project: ProjectSection,
  {
    sessions,
    poses,
    statuses,
    projects,
    workspaces,
    resources,
    runners,
    instances,
    unsentKeys,
    draftPlaceLabel,
    selectedId,
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
      waitingCount: project.waitingCount,
    },
  ];
  if (draftPlaceLabel !== null && holdsDraft(project)) {
    contents.push({
      kind: "draft-row",
      key: "draft",
      placeClip: draftPlaceLabel.clip,
      placeKeep: draftPlaceLabel.keep,
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
    const status = statuses.get(row.id);
    if (pose === undefined || status === undefined) continue;
    contents.push({
      kind: "thread-row",
      key: `thread:${row.id}`,
      sessionId: row.id,
      title: row.title,
      pose,
      status,
      receded: status === "working" && row.id !== selectedId,
      activityAt: status === "age" ? row.activityAt : "",
      placeClip: row.placeLabel.clip,
      placeKeep: row.placeLabel.keep,
      providerId: row.providerId,
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
 * Returns what the Done shelf draws, or nothing when no thread is marked
 * done: its heading with the count, then, while it is open or holds the
 * selected thread, its rows, most recently marked Done first, then its
 * "more" row when the open shelf hides some.
 */
const buildDoneContents = ({
  doneShelf,
  doneShelfOpen,
  poses,
  instances,
  unsentKeys,
}: SidebarItemSources): SidebarItemContent[] => {
  if (doneShelf.count === 0) return [];
  const providers = new Map(instances.map((each) => [each.id, each.providerId]));
  const contents: SidebarItemContent[] = [
    {
      kind: "done-header",
      key: buildHeaderKey("done"),
      count: doneShelf.count,
      open: doneShelfOpen,
    },
  ];
  for (const session of doneShelf.threads) {
    const pose = poses.get(session.id);
    if (pose === undefined || session.done === undefined) continue;
    contents.push({
      kind: "done-row",
      key: `done:${session.id}`,
      sessionId: session.id,
      title: session.title,
      pose,
      doneAt: session.done.at,
      providerId: providers.get(session.instanceId) ?? null,
      unsent: unsentKeys.has(session.id),
    });
  }
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
 * Returns the sidebar's items, top to bottom: Waiting on you when a thread,
 * an assistant or a run's session is waiting, then each project's section in
 * the order of `sections.projects`, then the Done shelf when a thread is
 * marked Done.
 *
 * A thread row whose session is missing from `sessions`, `poses` or
 * `statuses` is left out. All of them are built from one read of the thread list, so
 * this does not happen.
 */
const buildSidebarItems = (sources: SidebarItemSources): readonly SidebarItem[] => {
  const { sections, waitingRunSessions, waitingExpanded } = sources;
  return [
    ...placeInSection(
      "waiting",
      buildWaitingContents(sections.waiting, waitingRunSessions, waitingExpanded),
    ),
    ...sections.projects.flatMap((project) =>
      placeInSection(
        buildProjectSectionKey(project.projectId),
        buildProjectContents(project, sources),
      ),
    ),
    ...placeInSection("done", buildDoneContents(sources)),
  ];
};

/** What the sidebar is built from: the lists it reads, the open draft, and the user's choices. */
export interface SidebarSources {
  readonly threads: readonly Session[];
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
  /** The instances whose catalogs give a row its model name. */
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
   * How many Done threads the Done shelf shows, or `null` while it is
   * closed: `DONE_SHELF_LIMIT` when opened, and `DONE_SHELF_STEP` more for
   * each press of its "more" row.
   */
  readonly doneShelfLimit: number | null;
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
 * Each thread's pose and its row's status are decided once, here. The pose
 * serves the order of the sections, the rows' names and the counts. A thread
 * marked Done leaves its project for the Done shelf, and counts toward no
 * project's cap and in none of the foot's counts, but Waiting on you still
 * lists it while it waits, because `waiting` comes from every thread.
 */
export const buildSidebar = ({
  threads,
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
}: SidebarSources): Sidebar => {
  const runnersById = new Map(runners.map((runner) => [runner.id, runner]));
  const findRunner = (session: Session): Runner | undefined =>
    session.runnerId === null ? undefined : runnersById.get(session.runnerId);
  const poses = new Map(
    threads.map((session) => [session.id, decideThreadPose(session, findRunner(session))]),
  );
  const statuses = new Map(
    threads.map((session) => [session.id, decideThreadRowStatus(session, findRunner(session))]),
  );
  const sessions = new Map(threads.map((session) => [session.id, session]));
  const groupedThreads = buildThreadGroups({
    sessions: threads.filter((session) => !isMarkedDone(session)),
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
    sessions,
    waiting,
    poses,
    expanded: buildExpandedSections(expanded, groups),
    selectedId,
  });
  const items = buildSidebarItems({
    sections,
    waitingRunSessions,
    waitingExpanded: expanded.has("waiting"),
    doneShelf: buildDoneShelf({ threads, limit: doneShelfLimit, selectedId }),
    doneShelfOpen: doneShelfLimit !== null,
    sessions,
    poses,
    statuses,
    projects,
    workspaces,
    resources,
    runners,
    instances,
    unsentKeys,
    draftPlaceLabel: draft?.rowPlaceLabel ?? null,
    selectedId,
  });
  return { items, counts: countThreadsByPose(threads, poses) };
};

/** How many items the Go menu lists: one per shortcut, ⌘1 to ⌘9. */
const GO_MENU_LIMIT = 9;

/**
 * Returns the Go menu item of a sidebar item that opens a thread or an
 * assistant, or `null` for any other item. A run's session's row is not
 * listed: the Go menu stays about the user's own threads and assistants
 * (spec 17, "From runs" in Waiting on you). A Done thread's row is not
 * listed either, because the user put the thread away.
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
    case "waiting-run-row":
    case "waiting-runs-label":
    case "waiting-header":
    case "project-header":
    case "draft-row":
    case "done-header":
    case "done-row":
    case "more":
      return null;
  }
};

/**
 * Returns the first nine threads and assistants the sidebar's list shows,
 * top to bottom, for the Go menu. A waiting thread shows twice, under Waiting
 * on you and in its project, and is listed once, where it shows first. An
 * assistant is listed only while Waiting on you shows it: the Assistants
 * section is not part of the list. A run's session is not listed.
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
 * - when a "more" row leaves, because its section expanded: the first row
 *   of a thread, an assistant or a run's session that the section now shows
 *   and did not show before;
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
            item.kind === "waiting-run-row" ||
            item.kind === "thread-row" ||
            item.kind === "done-row") &&
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
