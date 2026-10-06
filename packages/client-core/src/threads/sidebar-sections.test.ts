/**
 * Tests `buildSidebarSections`, which caps the sidebar's sections when there
 * are many threads. The tests check that:
 *
 * - Waiting on you shows its first 3 entries, threads and assistants alike,
 *   and counts the rest;
 * - a project picks 5 threads, waiting first, then working, then the rest,
 *   newest first inside each tier, and shows them in the groups' order;
 * - the selected thread is shown in its project even when it is not picked,
 *   but gets no place in Waiting on you;
 * - two threads active at the same time are picked in session id order;
 * - a workspace group with no shown row is left out, label and all;
 * - an expanded section shows every thread.
 */
import { describe, expect, it } from "vitest";
import type { Session } from "@hercule/contract";
import type { Waiting } from "../waiting";
import { buildThreadGroups, type DraftPlace, type ProjectGroup } from "./groups";
import type { Pose } from "./pose";
import { buildSidebarSections, type ExpandedSections } from "./sidebar-sections";
import {
  MOSS,
  OPS_PROJECT,
  PRIMARY,
  THREAD_3F1,
  WEBSHOP,
  WEBSHOP_PROJECT,
  buildSession,
} from "./workspaces.testing";

const COLLAPSED: ExpandedSections = { waiting: false, projectIds: new Set() };

/** Returns a timestamp `minutes` after 09:00, so a larger number is newer. */
const buildTimestamp = (minutes: number): string =>
  new Date(Date.parse("2026-09-10T09:00:00.000Z") + minutes * 60_000).toISOString();

const buildThread = (id: string, minutes: number, over: Partial<Session> = {}): Session =>
  buildSession({ id, lastActivityAt: buildTimestamp(minutes), ...over });

const buildGroups = (
  sessions: readonly Session[],
  draft: DraftPlace | null = null,
): readonly ProjectGroup[] =>
  buildThreadGroups({
    sessions,
    projects: [WEBSHOP_PROJECT, OPS_PROJECT],
    workspaces: [PRIMARY, THREAD_3F1],
    resources: [WEBSHOP],
    runners: [MOSS],
    mode: "meta",
    draft,
  });

/** Returns a pose for every thread: the ones named in `poses`, and `idle` for the rest. */
const buildPoses = (
  sessions: readonly Session[],
  poses: Readonly<Record<string, Pose>> = {},
): ReadonlyMap<string, Pose> =>
  new Map(sessions.map((session) => [session.id, poses[session.id] ?? "idle"]));

/** Returns each workspace group of a section as its label's text and its rows' ids. */
const listLanes = (section: ProjectGroup | undefined) =>
  section?.workspaces.map((lane) => ({
    label: lane.label === null ? null : `${lane.label.clip}${lane.label.keep}`,
    rows: lane.rows.map((row) => row.id),
  }));

describe("buildSidebarSections: Waiting on you", () => {
  /** Returns a waiting thread's entry, active `minutes` after 09:00. */
  const buildWaitingThread = (sessionId: string, minutes: number): Waiting => ({
    kind: "thread",
    sessionId,
    requestId: `r-${sessionId}`,
    title: "A thread",
    question: "Run git push?",
    activityAt: buildTimestamp(minutes),
  });

  /** Returns a waiting assistant's entry, active `minutes` after 09:00. */
  const buildWaitingAssistant = (assistantId: string, minutes: number): Waiting => ({
    kind: "assistant",
    assistantId,
    name: "Ada",
    sessionId: `s-${assistantId}`,
    requestId: `r-${assistantId}`,
    question: "Run git push?",
    activityAt: buildTimestamp(minutes),
  });

  // 30 waiting threads, the newest first, as `listWaiting` orders them.
  const WAITING = Array.from({ length: 30 }, (_, index) =>
    buildWaitingThread(`s-wait-${String(29 - index)}`, 29 - index),
  );
  const THREADS = [buildThread("s-idle", 1)];

  it("shows the 3 newest entries, and counts the other 27", () => {
    const sections = buildSidebarSections({
      groups: buildGroups(THREADS),
      waiting: WAITING,
      poses: buildPoses(THREADS),
      expanded: COLLAPSED,
      selectedId: null,
    });

    expect(sections.waiting?.rows.map((row) => row.sessionId)).toEqual([
      "s-wait-29",
      "s-wait-28",
      "s-wait-27",
    ]);
    expect(sections.waiting?.hiddenCount).toBe(27);
  });

  it("shows waiting assistants among the threads, and counts both in what it hides", () => {
    const waiting = [
      buildWaitingThread("s-wait-3", 3),
      buildWaitingAssistant("a-ada", 2),
      buildWaitingThread("s-wait-1", 1),
      buildWaitingAssistant("a-bob", 0),
    ];
    const sections = buildSidebarSections({
      groups: buildGroups(THREADS),
      waiting,
      poses: buildPoses(THREADS),
      expanded: COLLAPSED,
      selectedId: null,
    });

    expect(sections.waiting?.rows).toEqual(waiting.slice(0, 3));
    expect(sections.waiting?.hiddenCount).toBe(1);
  });

  it("shows every entry, in the order given, once expanded", () => {
    const sections = buildSidebarSections({
      groups: buildGroups(THREADS),
      waiting: WAITING,
      poses: buildPoses(THREADS),
      expanded: { ...COLLAPSED, waiting: true },
      selectedId: null,
    });

    expect(sections.waiting?.rows).toEqual(WAITING);
    expect(sections.waiting?.hiddenCount).toBe(0);
  });

  it("gives the selected thread no place of its own", () => {
    const sections = buildSidebarSections({
      groups: buildGroups(THREADS),
      waiting: WAITING,
      poses: buildPoses(THREADS),
      expanded: COLLAPSED,
      selectedId: "s-wait-0",
    });

    expect(sections.waiting?.rows.map((row) => row.sessionId)).toEqual([
      "s-wait-29",
      "s-wait-28",
      "s-wait-27",
    ]);
    expect(sections.waiting?.hiddenCount).toBe(27);
  });

  it("has no Waiting on you section when nothing waits", () => {
    const sections = buildSidebarSections({
      groups: buildGroups(THREADS),
      waiting: [],
      poses: buildPoses(THREADS),
      expanded: COLLAPSED,
      selectedId: null,
    });

    expect(sections.waiting).toBeNull();
  });
});

describe("buildSidebarSections: a project", () => {
  const inWebshop = (id: string, minutes: number, workspaceId: string | null) =>
    buildThread(id, minutes, { projectId: WEBSHOP_PROJECT.id, workspaceId });

  // webshop's worktree holds only old threads, its main workspace the newest,
  // and one busy thread that is the oldest of all.
  const THREADS = [
    inWebshop("s-tree-1", 1, THREAD_3F1.id),
    inWebshop("s-tree-2", 2, THREAD_3F1.id),
    inWebshop("s-busy", 0, PRIMARY.id),
    ...[10, 11, 12, 13, 14, 15].map((minutes) =>
      inWebshop(`s-main-${String(minutes)}`, minutes, PRIMARY.id),
    ),
    inWebshop("s-loose", 3, null),
  ];
  const POSES = buildPoses(THREADS, { "s-busy": "working" });

  it("picks the working thread, then the 4 newest others, and keeps the groups' order", () => {
    const [webshop] = buildSidebarSections({
      groups: buildGroups(THREADS),
      waiting: [],
      poses: POSES,
      expanded: COLLAPSED,
      selectedId: null,
    }).projects;

    // The worktree and "no workspace" groups have no shown row, so neither
    // is drawn, and their labels go with them.
    expect(listLanes(webshop)).toEqual([
      {
        label: "webshop · moss",
        rows: ["s-main-15", "s-main-14", "s-main-13", "s-main-12", "s-busy"],
      },
    ]);
    expect(webshop?.hiddenCount).toBe(5);
    expect(webshop?.count).toBe(10);
  });

  it("picks waiting threads first, then working ones, then the rest, and never more than 5", () => {
    const poses = buildPoses(THREADS, {
      "s-busy": "working",
      "s-tree-1": "waiting",
      "s-main-10": "working",
      "s-main-11": "waiting",
      "s-main-12": "working",
      "s-main-13": "working",
      "s-loose": "waiting",
    });
    const [webshop] = buildSidebarSections({
      groups: buildGroups(THREADS),
      waiting: [],
      poses,
      expanded: COLLAPSED,
      selectedId: null,
    }).projects;

    // All 3 waiting threads, then the 2 newest of the 4 working ones. The
    // idle s-main-15 and s-main-14 are newer than all of them but not picked.
    expect(listLanes(webshop)).toEqual([
      { label: "hercule/thread-3f1", rows: ["s-tree-1"] },
      { label: "webshop · moss", rows: ["s-main-13", "s-main-12", "s-main-11"] },
      { label: "no workspace", rows: ["s-loose"] },
    ]);
    expect(webshop?.hiddenCount).toBe(5);
  });

  it("shows the selected thread beyond the 5, in its own group with its label", () => {
    const [webshop] = buildSidebarSections({
      groups: buildGroups(THREADS),
      waiting: [],
      poses: POSES,
      expanded: COLLAPSED,
      selectedId: "s-tree-2",
    }).projects;

    expect(listLanes(webshop)).toEqual([
      { label: "hercule/thread-3f1", rows: ["s-tree-2"] },
      {
        label: "webshop · moss",
        rows: ["s-main-15", "s-main-14", "s-main-13", "s-main-12", "s-busy"],
      },
    ]);
    expect(webshop?.hiddenCount).toBe(4);
  });

  it("shows 5 when the selected thread is already picked, or is in another project", () => {
    for (const selectedId of ["s-main-15", "s-ops"]) {
      const [webshop] = buildSidebarSections({
        groups: buildGroups(THREADS),
        waiting: [],
        poses: POSES,
        expanded: COLLAPSED,
        selectedId,
      }).projects;

      expect(listLanes(webshop)).toEqual([
        {
          label: "webshop · moss",
          rows: ["s-main-15", "s-main-14", "s-main-13", "s-main-12", "s-busy"],
        },
      ]);
      expect(webshop?.hiddenCount).toBe(5);
    }
  });

  it("breaks a tie in activity time by session id, whatever order the threads come in", () => {
    const tied = ["s-g", "s-c", "s-f", "s-a", "s-e", "s-b", "s-d"].map((id) =>
      inWebshop(id, 5, PRIMARY.id),
    );
    const [webshop] = buildSidebarSections({
      groups: buildGroups(tied),
      waiting: [],
      poses: buildPoses(tied),
      expanded: COLLAPSED,
      selectedId: null,
    }).projects;

    expect(webshop?.workspaces.flatMap((lane) => lane.rows.map((row) => row.id)).sort()).toEqual([
      "s-a",
      "s-b",
      "s-c",
      "s-d",
      "s-e",
    ]);
    expect(webshop?.hiddenCount).toBe(2);
  });

  it("shows every thread once expanded", () => {
    const groups = buildGroups(THREADS);
    const [webshop] = buildSidebarSections({
      groups,
      waiting: [],
      poses: POSES,
      expanded: { ...COLLAPSED, projectIds: new Set([WEBSHOP_PROJECT.id]) },
      selectedId: null,
    }).projects;

    expect(webshop).toEqual({ ...groups[0], hiddenCount: 0 });
  });

  it("shows a project of 5 threads or fewer whole", () => {
    const few = THREADS.slice(0, 5);
    const groups = buildGroups(few);
    const [webshop] = buildSidebarSections({
      groups,
      waiting: [],
      poses: buildPoses(few),
      expanded: COLLAPSED,
      selectedId: null,
    }).projects;

    expect(webshop).toEqual({ ...groups[0], hiddenCount: 0 });
  });

  it("caps each project on its own, and the threads with no project too", () => {
    const loose = Array.from({ length: 7 }, (_, index) =>
      buildThread(`s-none-${String(index)}`, index),
    );
    const ops = [buildThread("s-ops", 20, { projectId: OPS_PROJECT.id })];
    const all = [...THREADS, ...ops, ...loose];

    const collapsed = buildSidebarSections({
      groups: buildGroups(all),
      waiting: [],
      poses: buildPoses(all),
      expanded: COLLAPSED,
      selectedId: null,
    }).projects;
    expect(collapsed.map((section) => [section.projectId, section.hiddenCount])).toEqual([
      [OPS_PROJECT.id, 0],
      [WEBSHOP_PROJECT.id, 5],
      [null, 2],
    ]);

    const expanded = buildSidebarSections({
      groups: buildGroups(all),
      waiting: [],
      poses: buildPoses(all),
      expanded: { ...COLLAPSED, projectIds: new Set([null]) },
      selectedId: null,
    }).projects;
    expect(expanded.map((section) => [section.projectId, section.hiddenCount])).toEqual([
      [OPS_PROJECT.id, 0],
      [WEBSHOP_PROJECT.id, 5],
      [null, 0],
    ]);
  });

  it("keeps the group the draft being written joins, though it has no thread yet", () => {
    const [webshop] = buildSidebarSections({
      groups: buildGroups(THREADS, {
        projectId: WEBSHOP_PROJECT.id,
        workspaceId: null,
        createsWorkspace: true,
      }),
      waiting: [],
      poses: POSES,
      expanded: COLLAPSED,
      selectedId: null,
    }).projects;

    expect(webshop?.workspaces.map((lane) => [lane.draft, lane.rows.length])).toEqual([
      [true, 0],
      [false, 5],
    ]);
  });
});
