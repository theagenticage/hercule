/**
 * Tests `buildGroupSidebar`, which decides the rows the sidebar shows for its
 * groups of sessions, and how many each section hides. The tests check that:
 *
 * - Waiting on you shows its first 3 entries and counts the rest;
 * - a group sits under its lead's project, a deleted project's groups sit
 *   under no project, and the projects are ordered by their newest group,
 *   the draft's project first and no project last;
 * - a project picks 5 groups, waiting first, then working, then the rest,
 *   and shows the group that holds the open session as a sixth, in the
 *   groups' order;
 * - a reopened partner moves its group up, and a new partner does not;
 * - a project counts every counted session that waits, shown or hidden;
 * - a group is on the Done shelf only once every Thread is Done and every
 *   Agent session has ended, and the shelf shows the most recently done
 *   first, up to its limit, plus the open one.
 */
import type { OpenRequest, Session } from "@hercule/contract";
import { describe, expect, it } from "vitest";
import type { Waiting } from "../waiting";
import { buildGroupSidebar, type GroupSidebar } from "./group-sidebar";
import type { DraftPlace } from "./groups";
import { buildSessionGroups } from "./session-groups";
import { DONE_SHELF_LIMIT, type ExpandedSections } from "./sidebar-sections";
import {
  MOSS,
  OPS_PROJECT,
  PRIMARY,
  WEBSHOP,
  WEBSHOP_PROJECT,
  buildSession,
} from "./workspaces.testing";

const COLLAPSED: ExpandedSections = { waiting: false, projectIds: new Set() };

/** Returns a timestamp `minute` minutes after 09:00. */
const at = (minute: number): string =>
  new Date(Date.parse("2026-09-10T09:00:00.000Z") + minute * 60_000).toISOString();

const ask = (requestId: string): OpenRequest => ({
  requestId,
  itemId: "tool-1",
  decisions: ["allow", "deny"],
  kind: "command_approval",
  detail: { command: "git push" },
});

/** Returns a Thread in no workspace, so it is a group of its own, started at minute `minute`. */
const thread = (id: string, minute: number, over: Partial<Session> = {}): Session =>
  buildSession({
    id,
    projectId: WEBSHOP_PROJECT.id,
    createdAt: at(minute),
    lastActivityAt: at(minute),
    ...over,
  });

const done = (minute: number): Pick<Session, "done"> => ({ done: { at: at(minute), by: "user" } });

const buildWaitingThread = (sessionId: string): Waiting => ({
  kind: "thread",
  sessionId,
  requestId: `r-${sessionId}`,
  title: "A thread",
  groupName: "A thread",
  askerLabel: null,
  question: "Run git push?",
  newestRequestId: `r-${sessionId}`,
  openRequestIds: [`r-${sessionId}`],
  notificationBody: "Run git push?",
  activityAt: at(0),
});

/** Returns the sidebar of `sessions`, the way the desktop calls `buildGroupSidebar`. */
const build = (
  sessions: readonly Session[],
  over: {
    waiting?: readonly Waiting[];
    draft?: DraftPlace | null;
    expanded?: ExpandedSections;
    doneShelfLimit?: number | null;
    selectedId?: string | null;
  } = {},
): GroupSidebar =>
  buildGroupSidebar({
    groups: buildSessionGroups(sessions),
    projects: [WEBSHOP_PROJECT, OPS_PROJECT],
    workspaces: [PRIMARY],
    resources: [WEBSHOP],
    runners: [MOSS],
    instances: [],
    waiting: [],
    draft: null,
    expanded: COLLAPSED,
    doneShelfLimit: null,
    selectedId: null,
    ...over,
  });

/** Returns the leads of the rows each project shows, by project id (`none` for no project). */
const listShown = (sidebar: GroupSidebar): Record<string, string[]> =>
  Object.fromEntries(
    sidebar.projects.map((project) => [
      project.projectId ?? "none",
      project.rows.map((row) => row.leadId),
    ]),
  );

describe("buildGroupSidebar: Waiting on you", () => {
  it("is null when nothing waits", () => {
    expect(build([thread("s-1", 0)]).waiting).toBeNull();
  });

  it("shows the first 3 entries and counts the rest, or all of them when expanded", () => {
    const waiting = ["a", "b", "c", "d", "e"].map(buildWaitingThread);

    const collapsed = build([], { waiting }).waiting;
    const expanded = build([], { waiting, expanded: { ...COLLAPSED, waiting: true } }).waiting;

    expect(collapsed?.rows.map((row) => row.sessionId)).toEqual(["a", "b", "c"]);
    expect(collapsed?.hiddenCount).toBe(2);
    expect(expanded?.rows).toHaveLength(5);
    expect(expanded?.hiddenCount).toBe(0);
  });
});

describe("buildGroupSidebar: the projects", () => {
  it("puts a group under its lead's project, even when a partner works in another", () => {
    const sidebar = build([
      thread("s-lead", 0, { workspaceId: "w-1" }),
      thread("s-partner", 1, { workspaceId: "w-1", projectId: OPS_PROJECT.id }),
    ]);

    expect(listShown(sidebar)).toEqual({ [WEBSHOP_PROJECT.id]: ["s-lead"] });
  });

  it("puts the groups of a deleted project, and of no project, under no project, last", () => {
    const sidebar = build([
      thread("s-gone", 5, { projectId: "p-deleted" }),
      thread("s-none", 4, { projectId: null }),
      thread("s-ops", 1, { projectId: OPS_PROJECT.id }),
    ]);

    expect(listShown(sidebar)).toEqual({ [OPS_PROJECT.id]: ["s-ops"], none: ["s-gone", "s-none"] });
    expect(sidebar.projects.map((project) => project.name)).toEqual(["ops", null]);
  });

  it("orders the projects by their newest group, and ties by project id", () => {
    const newestOps = build([thread("s-w", 1), thread("s-o", 2, { projectId: OPS_PROJECT.id })]);
    const tied = build([thread("s-w", 1), thread("s-o", 1, { projectId: OPS_PROJECT.id })]);

    expect(newestOps.projects.map((project) => project.projectId)).toEqual([
      OPS_PROJECT.id,
      WEBSHOP_PROJECT.id,
    ]);
    expect(tied.projects.map((project) => project.projectId)).toEqual(
      [OPS_PROJECT.id, WEBSHOP_PROJECT.id].toSorted(),
    );
  });

  it("lists the project that holds the draft first, even when it has no group, and no project last", () => {
    const sessions = [thread("s-w", 5), thread("s-o", 1, { projectId: OPS_PROJECT.id })];
    const place = (projectId: string | null): DraftPlace => ({
      projectId,
      workspaceId: null,
      createsWorkspace: false,
    });

    const inOps = build(sessions, { draft: place(OPS_PROJECT.id) });
    const inNone = build(sessions, { draft: place(null) });
    const inGone = build(sessions, { draft: place("p-deleted") });
    const empty = build([], { draft: place(OPS_PROJECT.id) });

    expect(inOps.projects.map((project) => [project.projectId, project.holdsDraft])).toEqual([
      [OPS_PROJECT.id, true],
      [WEBSHOP_PROJECT.id, false],
    ]);
    expect(inNone.projects.map((project) => [project.projectId, project.holdsDraft])).toEqual([
      [WEBSHOP_PROJECT.id, false],
      [OPS_PROJECT.id, false],
      [null, true],
    ]);
    expect(inGone.projects.at(-1)).toMatchObject({ projectId: null, holdsDraft: true });
    expect(empty.projects).toMatchObject([
      { projectId: OPS_PROJECT.id, rows: [], holdsDraft: true },
    ]);
  });

  it("lists no project that holds only done groups", () => {
    const sidebar = build([thread("s-1", 0, { ...done(9) })]);

    expect(sidebar.projects).toEqual([]);
  });

  it("sorts a project's rows by when the group last started, so a new partner does not move a group and a reopened one does", () => {
    const sessions = [
      thread("s-old", 0, { workspaceId: "w-old" }),
      thread("s-new", 5),
      // Spawned later than s-new started, but it is a partner of s-old, so s-old keeps its place.
      thread("s-partner", 9, { workspaceId: "w-old" }),
    ];
    expect(listShown(build(sessions))[WEBSHOP_PROJECT.id]).toEqual(["s-new", "s-old"]);

    const reopened = sessions.map((session) =>
      session.id === "s-partner" ? { ...session, reopenedAt: at(12) } : session,
    );
    expect(listShown(build(reopened))[WEBSHOP_PROJECT.id]).toEqual(["s-old", "s-new"]);
  });

  it("shows one row for a session read twice", () => {
    const first = thread("s-1", 0, { workspaceId: "w-1" });
    const sidebar = build([first, { ...first, title: "newer read" }]);

    expect(sidebar.projects[0]?.rows.map((row) => row.title)).toEqual(["newer read"]);
  });
});

describe("buildGroupSidebar: the cap", () => {
  /** Returns `count` idle groups, the lead `s-<n>` started at minute `n`, so `s-0` is the oldest. */
  const buildIdle = (count: number): Session[] =>
    Array.from({ length: count }, (_, index) => thread(`s-${String(index)}`, index));

  const shownIn = (sidebar: GroupSidebar): string[] =>
    sidebar.projects[0]?.rows.map((row) => row.leadId) ?? [];

  it("shows 5 groups and counts the rest behind its more row", () => {
    const sidebar = build(buildIdle(8));

    expect(shownIn(sidebar)).toEqual(["s-7", "s-6", "s-5", "s-4", "s-3"]);
    expect(sidebar.projects[0]?.hiddenCount).toBe(3);
  });

  it("picks waiting groups first, then working, then the rest, and keeps the sorted order", () => {
    const sessions = buildIdle(8).map((session) => {
      if (session.id === "s-0") return { ...session, openRequests: [ask("r-0")] };
      if (session.id === "s-1") return { ...session, status: "busy" as const };
      return session;
    });

    // s-0 waits and s-1 works, so they come before the idle s-7, s-6 and s-5.
    expect(shownIn(build(sessions))).toEqual(["s-7", "s-6", "s-5", "s-1", "s-0"]);
  });

  it("counts a working Agent session as working for its group", () => {
    const sessions = [
      ...buildIdle(7),
      buildSession({
        id: "s-agent",
        agentId: "a-1",
        workspaceId: "w-1",
        status: "busy",
        createdAt: at(0),
      }),
    ].map((session) => (session.id === "s-0" ? { ...session, workspaceId: "w-1" } : session));

    expect(shownIn(build(sessions))).toContain("s-0");
  });

  it("adds the group that holds the open session as a sixth", () => {
    const sidebar = build(buildIdle(8), { selectedId: "s-0" });

    expect(shownIn(sidebar)).toEqual(["s-7", "s-6", "s-5", "s-4", "s-3", "s-0"]);
    expect(sidebar.projects[0]?.hiddenCount).toBe(2);
  });

  it("finds the open session in a partner, not only in the lead", () => {
    const sessions = [
      ...buildIdle(8).filter((session) => session.id !== "s-0"),
      thread("s-0", 0, { workspaceId: "w-1" }),
      thread("s-partner", 1, { workspaceId: "w-1" }),
    ];

    expect(shownIn(build(sessions, { selectedId: "s-partner" }))).toContain("s-0");
  });

  it("shows every group in a section the user expanded", () => {
    const sidebar = build(buildIdle(8), {
      expanded: { waiting: false, projectIds: new Set([WEBSHOP_PROJECT.id]) },
    });

    expect(shownIn(sidebar)).toHaveLength(8);
    expect(sidebar.projects[0]?.hiddenCount).toBe(0);
  });

  it("caps the groups of no project too", () => {
    const sidebar = build(buildIdle(7).map((session) => ({ ...session, projectId: null })));

    expect(sidebar.projects[0]).toMatchObject({ projectId: null });
    expect(shownIn(sidebar)).toHaveLength(5);
    expect(sidebar.projects[0]?.hiddenCount).toBe(2);
  });

  it("counts every counted session that waits in a project, shown or hidden", () => {
    const sessions = buildIdle(8).map((session) =>
      session.id === "s-0" || session.id === "s-1"
        ? { ...session, openRequests: [ask(`r-${session.id}`)] }
        : session,
    );
    const withAgent = [
      ...sessions,
      buildSession({
        id: "s-agent",
        agentId: "a-1",
        workspaceId: "w-1",
        openRequests: [ask("r-agent")],
        createdAt: at(20),
      }),
    ].map((session) => (session.id === "s-3" ? { ...session, workspaceId: "w-1" } : session));
    // A Done Thread that waits is no longer counted.
    const withDoneWaiting = [
      ...sessions,
      thread("s-done", 30, { ...done(31), workspaceId: "w-9", openRequests: [ask("r-done")] }),
      thread("s-partner", 31, { workspaceId: "w-9" }),
    ];

    expect(build(sessions).projects[0]?.waitingCount).toBe(2);
    expect(build(withAgent).projects[0]?.waitingCount).toBe(3);
    expect(build(withDoneWaiting).projects[0]?.waitingCount).toBe(2);
  });
});

describe("buildGroupSidebar: the Done shelf", () => {
  it("holds a group once every Thread is Done and every Agent session has ended, and counts groups", () => {
    const lead = (id: string, minute: number, over: Partial<Session> = {}) =>
      thread(id, minute, { workspaceId: `w-${id}`, ...over });
    const sessions = [
      // Done with its ended Agent session: on the shelf as one group of 3 sessions.
      lead("s-a", 0, done(20)),
      thread("s-a2", 1, { workspaceId: "w-s-a", ...done(21) }),
      buildSession({
        id: "s-agent",
        agentId: "a-1",
        workspaceId: "w-s-a",
        status: "exited",
        createdAt: at(2),
      }),
      // A partner is still live: the group stays in its project.
      lead("s-b", 3, done(22)),
      thread("s-b2", 4, { workspaceId: "w-s-b" }),
      // A live Agent session keeps the group in its project too.
      lead("s-c", 5, done(23)),
      buildSession({
        id: "s-c-agent",
        agentId: "a-1",
        workspaceId: "w-s-c",
        status: "busy",
        createdAt: at(6),
      }),
      // A lone Done Thread.
      thread("s-d", 7, done(24)),
    ];

    const sidebar = build(sessions, { doneShelfLimit: DONE_SHELF_LIMIT });

    expect(sidebar.doneShelf.count).toBe(2);
    expect(sidebar.doneShelf.rows.map((row) => row.leadId)).toEqual(["s-d", "s-a"]);
    expect(sidebar.doneShelf.rows[1]).toMatchObject({
      title: "A thread",
      doneAt: at(21),
      threadIds: ["s-a", "s-a2"],
    });
    expect(sidebar.doneShelf.rows[1]?.members.map((member) => member.sessionId)).toEqual([
      "s-a",
      "s-a2",
      "s-agent",
    ]);
    expect(listShown(sidebar)[WEBSHOP_PROJECT.id]).toEqual(["s-c", "s-b"]);
  });

  it("orders the groups by when they were done, newest first, ties by key", () => {
    const sessions = [
      thread("s-1", 0, done(10)),
      thread("s-2", 1, done(30)),
      thread("s-3", 2, done(30)),
    ];

    const rows = build(sessions, { doneShelfLimit: DONE_SHELF_LIMIT }).doneShelf.rows;

    expect(rows.map((row) => row.leadId)).toEqual(["s-2", "s-3", "s-1"]);
  });

  it("shows nothing while closed, counts every group, and hides none behind a more row", () => {
    const shelf = build([thread("s-1", 0, done(10)), thread("s-2", 1, done(11))]).doneShelf;

    expect(shelf).toEqual({ count: 2, rows: [], hiddenCount: 0 });
  });

  it("shows `limit` groups and counts the rest when open", () => {
    const sessions = Array.from({ length: 5 }, (_, index) =>
      thread(`s-${String(index)}`, index, done(10 + index)),
    );

    const shelf = build(sessions, { doneShelfLimit: 2 }).doneShelf;

    expect(shelf.rows.map((row) => row.leadId)).toEqual(["s-4", "s-3"]);
    expect(shelf.hiddenCount).toBe(3);
  });

  it("always shows the group that holds the open session, closed or beyond the limit", () => {
    const sessions = [
      thread("s-old", 0, { workspaceId: "w-old", ...done(10) }),
      thread("s-old-partner", 1, { workspaceId: "w-old", ...done(11) }),
      thread("s-new", 2, done(30)),
    ];

    const closed = build(sessions, { selectedId: "s-old-partner" }).doneShelf;
    const open = build(sessions, { doneShelfLimit: 1, selectedId: "s-old-partner" }).doneShelf;

    expect(closed.rows.map((row) => row.leadId)).toEqual(["s-old"]);
    expect(open.rows.map((row) => row.leadId)).toEqual(["s-new", "s-old"]);
    expect(open.hiddenCount).toBe(0);
  });
});
