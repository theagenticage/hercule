/**
 * Tests `prepareSessionPresentation` and `selectSidebar`, which decide
 * everything the desktop shows about the user's Threads and Agent sessions.
 * The tests check that:
 *
 * - the sessions of one workspace form one group, led by its first Thread,
 *   which starts and ends by rules the list order and the Done shelf rely on;
 * - a group's row has the status of its most urgent counted session, the
 *   second line of the session that asked first, and dots and words for
 *   every session, a Done Thread and an ended Agent session included;
 * - Waiting on you, the foot's counts and the Office's seats cover every
 *   Thread and Agent session, grouped or not;
 * - the choices (the cap, the open session, the draft, the Done shelf, the
 *   unfolded rows) pick and order the rows and their lines.
 */
import type { OpenRequest, Project, Session } from "@hercule/contract";
import { describe, expect, it } from "vitest";
import type { Waiting } from "../waiting";
import type { DraftPlace } from "./groups";
import { prepareSessionPresentation } from "./session-presentation";
import {
  DONE_SHELF_LIMIT,
  selectSidebar,
  type ExpandedSections,
  type SidebarChoices,
  type SidebarView,
} from "./sidebar-sections";
import {
  MOSS,
  OPS_PROJECT,
  PRIMARY,
  THREAD_3F1,
  WEBSHOP,
  WEBSHOP_PROJECT,
  buildProject,
  buildSession,
} from "./workspaces.testing";

/** Returns a timestamp `minute` minutes after 09:00. */
const at = (minute: number): string =>
  new Date(Date.parse("2026-09-10T09:00:00.000Z") + minute * 60_000).toISOString();

const ask = (requestId: string, command = "git push"): OpenRequest => ({
  requestId,
  itemId: "tool-1",
  decisions: ["allow", "deny"],
  kind: "command_approval",
  detail: { command },
});

/** Returns a Thread of workspace `w-1`, created at minute 0 unless `over` says otherwise. */
const thread = (id: string, over: Partial<Session> = {}): Session =>
  buildSession({ id, workspaceId: "w-1", title: `Thread ${id}`, createdAt: at(0), ...over });

/** Returns an Agent's session of workspace `w-1`, created at minute 1 unless `over` says otherwise. */
const agent = (id: string, over: Partial<Session> = {}): Session =>
  buildSession({
    id,
    agentId: "a-1",
    workspaceId: "w-1",
    title: `Agent ${id}`,
    createdAt: at(1),
    ...over,
  });

/** Returns a Thread in no workspace, so a group of its own, in webshop, started at minute `minute`. */
const lone = (id: string, minute: number, over: Partial<Session> = {}): Session =>
  buildSession({
    id,
    projectId: WEBSHOP_PROJECT.id,
    createdAt: at(minute),
    lastActivityAt: at(minute),
    ...over,
  });

const done = (minute: number): Pick<Session, "done"> => ({ done: { at: at(minute), by: "user" } });

const INSTANCES = [
  { id: "i-claude", providerId: "claude-code", snapshots: [] },
  { id: "i-codex", providerId: "codex", snapshots: [] },
] as unknown as Parameters<typeof prepareSessionPresentation>[0]["instances"];

/** Returns the presentation of `sessions`, with the fixture's projects, workspaces and machine. */
const prepare = (
  sessions: readonly Session[],
  over: Partial<Parameters<typeof prepareSessionPresentation>[0]> = {},
) =>
  prepareSessionPresentation({
    listedSessions: sessions,
    openSession: null,
    projects: [WEBSHOP_PROJECT, OPS_PROJECT],
    workspaces: [PRIMARY, THREAD_3F1],
    resources: [WEBSHOP],
    runners: [MOSS],
    instances: INSTANCES,
    ...over,
  });

/** Returns the row of the one group `sessions` form. */
const describeOnly = (
  sessions: readonly Session[],
  over: Partial<Parameters<typeof prepareSessionPresentation>[0]> = {},
) => {
  const { groupRows } = prepare(sessions, over);
  expect(groupRows).toHaveLength(1);
  return groupRows[0]!;
};

const COLLAPSED: ExpandedSections = { waiting: false, projectIds: new Set() };

/** Returns the sidebar view of `sessions` under `choices`. */
const select = (
  sessions: readonly Session[],
  choices: Partial<SidebarChoices> = {},
  reads: Partial<Parameters<typeof prepareSessionPresentation>[0]> = {},
): SidebarView =>
  selectSidebar(prepare(sessions, reads), {
    waiting: [],
    selectedId: null,
    draft: null,
    expanded: COLLAPSED,
    doneShelfLimit: null,
    unfolded: new Set(),
    quietShown: new Set(),
    lastOpen: new Map(),
    ...choices,
  });

/** Returns the leads of the rows each project shows, by project id (`none` for no project). */
const listShown = (view: SidebarView): Record<string, string[]> =>
  Object.fromEntries(
    view.projects.map((project) => [
      project.projectId ?? "none",
      project.rows.map(({ row }) => row.leadId),
    ]),
  );

describe("the groups", () => {
  it("makes a lone Thread with no workspace a group of its own", () => {
    const row = describeOnly([thread("s-1", { workspaceId: null })]);

    expect([row.key, row.leadId, row.members.map((member) => member.sessionId)]).toEqual([
      "session:s-1",
      "s-1",
      ["s-1"],
    ]);
  });

  it("holds the Threads and Agent sessions of a workspace, oldest first and ties by id, led by the oldest Thread even when it is Done", () => {
    const row = describeOnly([
      agent("s-agent"),
      thread("s-partner", { createdAt: at(2) }),
      thread("s-also", { createdAt: at(2) }),
      thread("s-lead", done(9)),
    ]);

    expect(row).toMatchObject({ key: "workspace:w-1", leadId: "s-lead", title: "Thread s-lead" });
    expect(row.members.map((member) => member.sessionId)).toEqual([
      "s-lead",
      "s-agent",
      "s-also",
      "s-partner",
    ]);
  });

  it("makes no group of an Agent session with no workspace, or of a workspace that holds only Agent sessions", () => {
    expect(prepare([agent("s-1"), agent("s-2", { workspaceId: null })]).groupRows).toEqual([]);
  });

  it("lists the group that started last first, and groups that started together by key", () => {
    const { groupRows } = prepare([
      thread("s-old", { workspaceId: "w-old" }),
      thread("s-b", { workspaceId: "w-b", createdAt: at(5) }),
      thread("s-a", { workspaceId: "w-a", createdAt: at(5) }),
    ]);

    expect(groupRows.map((row) => row.key)).toEqual([
      "workspace:w-a",
      "workspace:w-b",
      "workspace:w-old",
    ]);
  });

  it.each([
    ["the lead's creation, whatever a partner's", [{}, { createdAt: at(7) }], at(0)],
    [
      "the latest reopen of any Thread, a partner's included",
      [{ reopenedAt: at(3) }, { createdAt: at(2), reopenedAt: at(6) }],
      at(6),
    ],
  ])("starts at %s", (_name, [lead, partner], lastStartedAt) => {
    const row = describeOnly([thread("s-lead", lead), thread("s-partner", partner)]);

    expect(row.lastStartedAt).toBe(lastStartedAt);
  });

  it.each<[string, readonly Session[], string | null]>([
    ["is not set while one Thread is not Done", [thread("s-1", done(4)), thread("s-2")], null],
    [
      "is not set while an Agent session is live",
      [thread("s-1", done(4)), agent("s-agent", { status: "busy" })],
      null,
    ],
    [
      "is the latest Done time once every Thread is Done and every Agent session has ended",
      [
        thread("s-1", done(8)),
        thread("s-2", { createdAt: at(2), ...done(4) }),
        agent("s-agent", { status: "exited" }),
      ],
      at(8),
    ],
  ])("goes to the Done shelf: it %s", (_name, sessions, doneAt) => {
    expect(describeOnly(sessions).doneAt).toBe(doneAt);
  });
});

describe("a group's row", () => {
  it("is a lone Thread's own: its title, status and place, with no dots", () => {
    const row = describeOnly([
      thread("s-1", { workspaceId: PRIMARY.id, status: "busy", lastActivityAt: at(5) }),
    ]);

    expect(row).toMatchObject({
      leadId: "s-1",
      title: "Thread s-1",
      pose: "working",
      status: "working",
      activityAt: at(5),
      ask: null,
      providerId: "claude-code",
      branch: "main",
      machine: "moss",
      summary: null,
      threadIds: ["s-1"],
    });
  });

  it("asks the question alone when a lone Thread waits, and shows the lead's status when the group is done", () => {
    expect(describeOnly([thread("s-1", { openRequests: [ask("r-1")] })])).toMatchObject({
      status: "approval",
      ask: { askerLabel: null, question: "Run git push?" },
    });
    expect(describeOnly([thread("s-1", { ...done(30), status: "idle" })])).toMatchObject({
      status: "age",
      doneAt: at(30),
    });
  });

  describe("the status", () => {
    it("is the most urgent counted session's: waiting, then working, then queued, then the rest", () => {
      const statusOf = (...partners: Partial<Session>[]) =>
        describeOnly([
          thread("s-1", { status: "idle" }),
          ...partners.map((over, index) =>
            thread(`s-p${String(index)}`, { createdAt: at(index + 1), ...over }),
          ),
        ]).status;

      expect(statusOf({ status: "queued" })).toBe("queued");
      expect(statusOf({ status: "queued" }, { status: "busy" })).toBe("working");
      expect(statusOf({ status: "busy" }, { openRequests: [ask("r-1")] })).toBe("approval");
    });

    it("is the asker's, with the asker's second line, when several sessions wait", () => {
      const question = {
        requestId: "r-q",
        itemId: "tool-2",
        kind: "question",
        detail: {
          questions: [
            { question: "Which storage?", header: "Storage", options: [], multiSelect: false },
          ],
        },
      } as unknown as OpenRequest;
      const partnerFirst = describeOnly([
        thread("s-lead", { lastActivityAt: at(9), openRequests: [question] }),
        thread("s-partner", {
          createdAt: at(2),
          lastActivityAt: at(0),
          openRequests: [ask("r-1")],
        }),
      ]);
      const leadFirst = describeOnly([
        thread("s-lead", { lastActivityAt: at(0), openRequests: [question] }),
        thread("s-partner", {
          createdAt: at(2),
          lastActivityAt: at(9),
          openRequests: [ask("r-1")],
        }),
      ]);

      expect(partnerFirst).toMatchObject({
        status: "approval",
        activityAt: at(0),
        ask: { askerLabel: "Thread s-partner", question: "Run git push?" },
      });
      expect(leadFirst).toMatchObject({
        status: "question",
        activityAt: at(0),
        ask: { askerLabel: null, question: "Which storage?" },
      });
    });

    it("takes the most recently active session among equals, then the group's order", () => {
      const sessions = (partnerActivity: number) => [
        thread("s-1", { status: "idle", lastActivityAt: at(2) }),
        thread("s-2", { status: "idle", lastActivityAt: at(partnerActivity), createdAt: at(1) }),
      ];

      expect(describeOnly(sessions(9)).activityAt).toBe(at(9));
      expect(describeOnly(sessions(2)).activityAt).toBe(at(2));
    });

    it("ignores a Done lead and an ended Agent session, which stay among the members as quiet", () => {
      const row = describeOnly([
        thread("s-lead", { ...done(30), status: "idle", openRequests: [ask("r-1")] }),
        thread("s-partner", { createdAt: at(2), status: "busy" }),
        agent("s-gone", { status: "exited", exitedAt: at(5) }),
      ]);

      expect(row).toMatchObject({ title: "Thread s-lead", status: "working", ask: null });
      expect(row.members.map((member) => [member.sessionId, member.counted, member.dot])).toEqual([
        ["s-lead", false, "quiet"],
        ["s-gone", false, "quiet"],
        ["s-partner", true, "working"],
      ]);
    });

    it("makes the row wait when an Agent session waits", () => {
      const row = describeOnly([
        thread("s-1", { status: "idle" }),
        agent("s-agent", { openRequests: [ask("r-1")] }),
      ]);

      expect(row).toMatchObject({ pose: "waiting", status: "approval" });
      expect(row.summary?.dots).toEqual(["waiting", "quiet"]);
    });
  });

  it("lists the Threads a Done press marks: those not yet Done, never an Agent session", () => {
    const row = describeOnly([
      thread("s-lead", done(30)),
      thread("s-partner", { createdAt: at(2), status: "idle" }),
      agent("s-agent", { status: "busy" }),
    ]);

    expect(row.doneIds).toEqual(["s-partner"]);
    expect(row.threadIds).toEqual(["s-lead", "s-partner"]);
  });

  describe("the second line", () => {
    const reviewer = (over: Partial<Session> = {}): Session =>
      agent("s-review", { role: "review", instanceId: "i-codex", ...over });

    it("names the asking session by its role, and leads with its provider", () => {
      const row = describeOnly([thread("s-1"), reviewer({ openRequests: [ask("r-1")] })]);

      expect(row.ask).toEqual({ askerLabel: "review", question: "Run git push?" });
      expect(row.providerId).toBe("codex");
    });

    it("asks the question alone, with the lead's provider, when the lead asks", () => {
      const row = describeOnly([
        thread("s-1", { openRequests: [ask("r-1")] }),
        reviewer({ openRequests: [ask("r-2", "ls")], lastActivityAt: at(9) }),
      ]);

      expect(row.ask).toEqual({ askerLabel: null, question: "Run git push?" });
      expect(row.providerId).toBe("claude-code");
    });
  });

  describe("the project", () => {
    it.each<[string, Partial<Session>, Project[], string | null]>([
      ["the lead's", { projectId: WEBSHOP_PROJECT.id }, [WEBSHOP_PROJECT], WEBSHOP_PROJECT.id],
      ["none when the lead has none", {}, [WEBSHOP_PROJECT], null],
      [
        "none when the lead's project is not listed any more",
        { projectId: "p-deleted" },
        [buildProject("p-other", "other")],
        null,
      ],
    ])("is %s", (_name, lead, projects, projectId) => {
      expect(describeOnly([thread("s-1", lead)], { projects }).projectId).toBe(projectId);
    });

    it("is the lead's even when a partner works in another project", () => {
      const row = describeOnly([
        thread("s-1", { projectId: WEBSHOP_PROJECT.id }),
        thread("s-2", { projectId: "p-ops", createdAt: at(2) }),
      ]);

      expect(row.projectId).toBe(WEBSHOP_PROJECT.id);
    });
  });

  describe("the dots", () => {
    /** Returns `count` Threads of one group: the first idle, then `busy` working and `waiting` waiting ones. */
    const buildCrew = (count: number, busy: number, waiting: number): Session[] =>
      Array.from({ length: count }, (_, index) =>
        thread(`s-${String(index)}`, {
          createdAt: at(index),
          status: index >= 1 && index <= busy ? "busy" : "idle",
          openRequests: index > busy && index <= busy + waiting ? [ask(`r-${String(index)}`)] : [],
        }),
      );

    it.each<[string, Session[], object]>([
      [
        "one dot per session for 2 sessions",
        buildCrew(2, 1, 0),
        { dots: ["working", "quiet"], hiddenCount: 0, label: "2 threads: 1 working, 1 quiet" },
      ],
      [
        "one dot per session for 3, the most urgent first",
        buildCrew(3, 1, 1),
        { dots: ["waiting", "working", "quiet"], hiddenCount: 0 },
      ],
      [
        "the three most urgent and the rest as +n for more than 3 sessions",
        buildCrew(10, 3, 1),
        {
          dots: ["waiting", "working", "working"],
          hiddenCount: 7,
          label: "10 threads: 1 waiting on you, 3 working, 6 quiet",
        },
      ],
      [
        "queued as working, and no dot for a Done Thread or an ended Agent session",
        [
          thread("s-1", { status: "queued" }),
          thread("s-2", { ...done(30), createdAt: at(2) }),
          agent("s-agent", { status: "exited", exitedAt: at(5) }),
        ],
        {
          dots: ["working"],
          hiddenCount: 0,
          label: "3 sessions: 1 working, 1 done, 1 ended",
        },
      ],
      [
        "one quiet dot for a Done lead that waits and an idle partner",
        [
          thread("s-lead", { ...done(30), openRequests: [ask("r-1")] }),
          thread("s-partner", { createdAt: at(2), status: "idle" }),
        ],
        { dots: ["quiet"], hiddenCount: 0, label: "2 threads: 1 quiet, 1 done" },
      ],
      [
        "no Done Thread in the +n",
        [
          ...buildCrew(4, 3, 0),
          ...[5, 6, 7].map((index) =>
            thread(`s-${String(index)}`, { ...done(30), createdAt: at(index) }),
          ),
        ],
        {
          dots: ["working", "working", "working"],
          hiddenCount: 1,
          label: "7 threads: 3 working, 1 quiet, 3 done",
        },
      ],
      [
        "no dot, yet a summary, when nothing is counted, so the row still unfolds",
        [thread("s-1", done(30)), thread("s-2", { ...done(31), createdAt: at(2) })],
        { dots: [], hiddenCount: 0, label: "2 threads: 2 done" },
      ],
    ])("shows %s", (_name, sessions, summary) => {
      expect(describeOnly(sessions).summary).toMatchObject(summary);
    });

    it("lists every session, the most urgent first, for the hover card", () => {
      const summary = describeOnly([
        thread("s-lead", { status: "idle" }),
        thread("s-done", { ...done(30), createdAt: at(2) }),
        thread("s-working", { createdAt: at(3), status: "busy" }),
        thread("s-quiet", { createdAt: at(4), status: "idle" }),
        thread("s-waiting", { createdAt: at(5), openRequests: [ask("r-1")] }),
      ]).summary;

      expect(summary?.membersByUrgency.map((member) => member.sessionId)).toEqual([
        "s-waiting",
        "s-working",
        "s-lead",
        "s-done",
        "s-quiet",
      ]);
    });
  });
});

describe("the sessions that wait on the user", () => {
  const lead = (over: Partial<Session> = {}): Session =>
    thread("s-lead", { title: "Fix checkout", ...over });
  const reviewer = (over: Partial<Session> = {}): Session =>
    agent("s-review", {
      title: "Adversarial review of the 3-D Secure fix",
      role: "review",
      createdAt: at(5),
      ...over,
    });

  it("lists a Thread with its Requests: the oldest in the row, the newest in the notification, and a subagent's name", () => {
    const { waitingSessions } = prepare([
      lone("s-idle", 0),
      lone("s-1", 1, {
        title: "Fix the login bug",
        lastActivityAt: at(7),
        openRequests: [
          { ...ask("r-1", "git push"), subagentId: "agent-1" },
          ask("r-2", "pnpm test"),
          { ...ask("r-3", "make deploy"), subagentId: "agent-2", subagentName: "Review the diff" },
        ],
      }),
    ]);

    expect(waitingSessions).toEqual([
      {
        kind: "session",
        sessionId: "s-1",
        title: "Fix the login bug",
        groupKey: "session:s-1",
        groupName: "Fix the login bug",
        askerLabel: null,
        requestId: "r-1",
        question: "Run git push?",
        newestRequestId: "r-3",
        openRequestIds: ["r-1", "r-2", "r-3"],
        notificationBody: "Review the diff asks: Run make deploy?\n+2 more waiting",
        activityAt: at(7),
      },
    ]);
  });

  it('starts the notification with "A subagent asks: " when the subagent has no name yet', () => {
    const [entry] = prepare([
      thread("s-1", { openRequests: [{ ...ask("r-1", "pnpm test"), subagentId: "agent-1" }] }),
    ]).waitingSessions;

    expect(entry?.notificationBody).toBe("A subagent asks: Run pnpm test?");
  });

  it("names the group by its lead, and the asker by its role, numbered when the role repeats, unless the lead asks", () => {
    const secondReviewer = reviewer({
      id: "s-review-2",
      role: "Review",
      createdAt: at(6),
      openRequests: [ask("r-2")],
    });
    const numbered = prepare([lead(), reviewer(), secondReviewer]);
    const byReviewer = prepare([lead(), reviewer({ openRequests: [ask("r-1")] })]);
    const byLead = prepare([lead({ openRequests: [ask("r-1")] }), reviewer()]);

    expect(byReviewer.waitingSessions).toMatchObject([
      {
        sessionId: "s-review",
        groupKey: "workspace:w-1",
        groupName: "Fix checkout",
        askerLabel: "review",
      },
    ]);
    expect(byLead.waitingSessions).toMatchObject([
      { sessionId: "s-lead", groupName: "Fix checkout", askerLabel: null },
    ]);
    expect(numbered.waitingSessions).toMatchObject([
      { sessionId: "s-review-2", askerLabel: "Review 2" },
    ]);
  });

  it("lists a Thread marked Done while it waits, and an Agent session no group holds by its own title", () => {
    const { waitingSessions } = prepare([
      lead({ ...done(9), openRequests: [ask("r-1")] }),
      reviewer(),
      agent("s-loose", { workspaceId: null, openRequests: [ask("r-2", "ls")] }),
    ]);

    expect(waitingSessions).toMatchObject([
      { sessionId: "s-lead", groupName: "Fix checkout" },
      { sessionId: "s-loose", groupKey: "session:s-loose", groupName: "Agent s-loose" },
    ]);
  });
});

describe("the foot's counts and the Office's seats", () => {
  it("counts every Thread and Agent session not marked Done by pose, ungrouped ones too, and leaves out asleep and away ones", () => {
    const { counts } = prepare([
      thread("s-working", { status: "busy" }),
      thread("s-waiting", { openRequests: [ask("r-1")] }),
      thread("s-idle"),
      agent("s-agent", { workspaceId: null, status: "busy" }),
      thread("s-done", { ...done(4), status: "busy", openRequests: [ask("r-2")] }),
      thread("s-asleep", { status: "exited", resumable: true }),
      thread("s-away", { status: "exited" }),
    ]);

    expect(counts).toEqual({ working: 2, waiting: 1, idle: 1 });
  });

  it("seats a session as the Office does: a Thread unless Done, an Agent session while it works, waits or idles", () => {
    const { seatedIds, groupRows, sessions } = prepare([
      thread("s-lead", done(30)),
      thread("s-partner", { createdAt: at(2), status: "idle" }),
      agent("s-agent", { status: "busy" }),
      agent("s-gone", { createdAt: at(3), status: "exited", exitedAt: at(5) }),
      agent("s-loose", { workspaceId: null, status: "busy" }),
    ]);

    expect([...seatedIds].toSorted()).toEqual(["s-agent", "s-loose", "s-partner"]);
    // An ended Agent session is held and known not to be seated, unlike an unknown one.
    expect(sessions.map((session) => session.id)).toContain("s-gone");
    expect(groupRows[0]?.members.filter((member) => member.seated).length).toBe(2);
  });
});

describe("the open session", () => {
  const OLD_DONE = lone("s-old", 1, { projectId: OPS_PROJECT.id, ...done(2) });

  it("adds an old Done Thread the read left out, so its group keeps a row on the Done shelf", () => {
    const view = select([], { selectedId: "s-old" }, { openSession: OLD_DONE });

    expect(view.doneShelf.rows.map(({ row }) => row.key)).toEqual(["session:s-old"]);
    expect(view.openGroupKey).toBe("session:s-old");
    expect(select([], { selectedId: "s-old" }).openGroupKey).toBeNull();
    expect(prepare([], { openSession: OLD_DONE }).sessions).toEqual([OLD_DONE]);
  });

  it("keeps the list's record when both hold the session, and counts it once", () => {
    const reopened = lone("s-old", 1, { projectId: OPS_PROJECT.id, reopenedAt: at(9) });
    const presentation = prepare([reopened], { openSession: OLD_DONE });

    expect(presentation.groupRows.map((row) => row.doneAt)).toEqual([null]);
    expect(presentation.counts).toEqual({ working: 0, waiting: 0, idle: 1 });
  });

  it("lists an open Done Thread that still asks, and ignores an open session that is no Thread or Agent session", () => {
    const asking = { ...OLD_DONE, openRequests: [ask("r-1")] };
    const step = lone("s-step", 1, {
      kind: "run",
      agentId: "a-1",
      runId: "run-1",
      stepId: "build",
    });

    expect(prepare([], { openSession: asking }).waitingSessions).toHaveLength(1);
    expect(prepare([], { openSession: step }).groupRows).toEqual([]);
  });
});

describe("Waiting on you", () => {
  const waiting = (sessionId: string): Waiting => ({
    kind: "session",
    sessionId,
    requestId: `r-${sessionId}`,
    title: "A thread",
    groupKey: `session:${sessionId}`,
    groupName: "A thread",
    askerLabel: null,
    question: "Run git push?",
    newestRequestId: `r-${sessionId}`,
    openRequestIds: [`r-${sessionId}`],
    notificationBody: "Run git push?",
    activityAt: at(0),
  });

  it("is not there when nothing waits", () => {
    expect(select([lone("s-1", 0)]).waiting).toBeNull();
  });

  it("shows the first 3 entries and counts the rest, or all of them when expanded", () => {
    const entries = ["a", "b", "c", "d", "e"].map(waiting);

    const collapsed = select([], { waiting: entries }).waiting;
    const expanded = select([], {
      waiting: entries,
      expanded: { ...COLLAPSED, waiting: true },
    }).waiting;

    expect(collapsed?.rows.map((row) => row.sessionId)).toEqual(["a", "b", "c"]);
    expect(collapsed?.hiddenCount).toBe(2);
    expect(expanded).toMatchObject({ hiddenCount: 0, rows: { length: 5 } });
  });
});

describe("the project sections", () => {
  it("puts a group under its lead's project, and the groups of a deleted project or of none under no project, last", () => {
    const view = select([
      lone("s-lead", 0, { workspaceId: "w-1" }),
      lone("s-partner", 1, { workspaceId: "w-1", projectId: OPS_PROJECT.id }),
      lone("s-gone", 5, { projectId: "p-deleted" }),
      lone("s-none", 4, { projectId: null }),
    ]);

    expect(listShown(view)).toEqual({
      [WEBSHOP_PROJECT.id]: ["s-lead"],
      none: ["s-gone", "s-none"],
    });
  });

  it("orders the projects by their newest group, and ties by project id", () => {
    const newestOps = select([lone("s-w", 1), lone("s-o", 2, { projectId: OPS_PROJECT.id })]);
    const tied = select([lone("s-w", 1), lone("s-o", 1, { projectId: OPS_PROJECT.id })]);

    expect(newestOps.projects.map((project) => project.projectId)).toEqual([
      OPS_PROJECT.id,
      WEBSHOP_PROJECT.id,
    ]);
    expect(tied.projects.map((project) => project.projectId)).toEqual(
      [OPS_PROJECT.id, WEBSHOP_PROJECT.id].toSorted(),
    );
  });

  it("lists the project that holds the draft first, even with no group, and no project last", () => {
    const sessions = [lone("s-w", 5), lone("s-o", 1, { projectId: OPS_PROJECT.id })];
    const place = (projectId: string | null): DraftPlace => ({
      projectId,
      workspaceId: null,
      createsWorkspace: false,
    });
    const listed = (draft: DraftPlace, over: readonly Session[] = sessions) =>
      select(over, { draft }).projects.map((project) => [project.projectId, project.holdsDraft]);

    expect(listed(place(OPS_PROJECT.id))).toEqual([
      [OPS_PROJECT.id, true],
      [WEBSHOP_PROJECT.id, false],
    ]);
    expect(listed(place(null))).toEqual([
      [WEBSHOP_PROJECT.id, false],
      [OPS_PROJECT.id, false],
      [null, true],
    ]);
    expect(listed(place("p-deleted")).at(-1)).toEqual([null, true]);
    expect(listed(place(OPS_PROJECT.id), [])).toEqual([[OPS_PROJECT.id, true]]);
  });

  it("sorts a project's rows by when the group last started: a new partner does not move a group, a reopened one does", () => {
    const sessions = [
      lone("s-old", 0, { workspaceId: "w-old" }),
      lone("s-new", 5),
      // Spawned after s-new started, but it is a partner of s-old, so s-old keeps its place.
      lone("s-partner", 9, { workspaceId: "w-old" }),
    ];
    const reopened = sessions.map((session) =>
      session.id === "s-partner" ? { ...session, reopenedAt: at(12) } : session,
    );

    expect(listShown(select(sessions))[WEBSHOP_PROJECT.id]).toEqual(["s-new", "s-old"]);
    expect(listShown(select(reopened))[WEBSHOP_PROJECT.id]).toEqual(["s-old", "s-new"]);
  });

  describe("the cap", () => {
    /** Returns `count` idle groups, the lead `s-<n>` started at minute `n`, so `s-0` is the oldest. */
    const buildIdle = (count: number): Session[] =>
      Array.from({ length: count }, (_, index) => lone(`s-${String(index)}`, index));

    const shownIn = (view: SidebarView): string[] =>
      view.projects[0]?.rows.map(({ row }) => row.leadId) ?? [];

    it("shows 5 groups and counts the rest behind its more row", () => {
      const view = select(buildIdle(8));

      expect(shownIn(view)).toEqual(["s-7", "s-6", "s-5", "s-4", "s-3"]);
      expect(view.projects[0]?.hiddenCount).toBe(3);
    });

    it("picks waiting groups first, then working ones, then the rest, keeping the sorted order", () => {
      const sessions = buildIdle(8).map((session) => {
        if (session.id === "s-0") return { ...session, openRequests: [ask("r-0")] };
        if (session.id === "s-1") return { ...session, status: "busy" as const };
        return session;
      });

      expect(shownIn(select(sessions))).toEqual(["s-7", "s-6", "s-5", "s-1", "s-0"]);
    });

    it("counts a working Agent session as working for its group", () => {
      const sessions = [
        ...buildIdle(7),
        agent("s-agent", { workspaceId: "w-1", status: "busy", createdAt: at(0) }),
      ].map((session) => (session.id === "s-0" ? { ...session, workspaceId: "w-1" } : session));

      expect(shownIn(select(sessions))).toContain("s-0");
    });

    it("adds the group that holds the open session as a sixth, found in a partner too", () => {
      const sessions = [
        ...buildIdle(8).filter((session) => session.id !== "s-0"),
        lone("s-0", 0, { workspaceId: "w-1" }),
        lone("s-partner", 1, { workspaceId: "w-1" }),
      ];
      const view = select(sessions, { selectedId: "s-partner" });

      expect(shownIn(view)).toEqual(["s-7", "s-6", "s-5", "s-4", "s-3", "s-0"]);
      expect(view.projects[0]?.hiddenCount).toBe(2);
    });

    it("shows every group of an expanded section, and caps the groups of no project too", () => {
      const expanded = select(buildIdle(8), {
        expanded: { waiting: false, projectIds: new Set([WEBSHOP_PROJECT.id]) },
      });
      const none = select(buildIdle(7).map((session) => ({ ...session, projectId: null })));

      expect(shownIn(expanded)).toHaveLength(8);
      expect(expanded.projects[0]?.hiddenCount).toBe(0);
      expect(none.projects[0]).toMatchObject({ projectId: null, hiddenCount: 2 });
      expect(shownIn(none)).toHaveLength(5);
    });

    it("counts every counted session that waits in a project, shown or hidden, and not a Done Thread's", () => {
      const waitingTwo = buildIdle(8).map((session) =>
        session.id === "s-0" || session.id === "s-1"
          ? { ...session, openRequests: [ask(`r-${session.id}`)] }
          : session,
      );
      const withAgent = [
        ...waitingTwo,
        agent("s-agent", { workspaceId: "w-1", openRequests: [ask("r-agent")], createdAt: at(20) }),
      ].map((session) => (session.id === "s-3" ? { ...session, workspaceId: "w-1" } : session));
      const withDoneWaiting = [
        ...waitingTwo,
        lone("s-done", 30, { ...done(31), workspaceId: "w-9", openRequests: [ask("r-done")] }),
        lone("s-partner", 31, { workspaceId: "w-9" }),
      ];

      expect(select(waitingTwo).projects[0]?.waitingCount).toBe(2);
      expect(select(withAgent).projects[0]?.waitingCount).toBe(3);
      expect(select(withDoneWaiting).projects[0]?.waitingCount).toBe(2);
    });
  });
});

describe("the rows", () => {
  const crew = [
    thread("s-lead"),
    thread("s-second", { createdAt: at(2) }),
    agent("s-review", { role: "review", status: "busy" }),
  ];
  const openIdOf = (choices: Partial<SidebarChoices>): string | undefined =>
    select(crew, choices).projects[0]?.rows[0]?.openId;

  it("open the session last open in the group, else the lead, and the open session while the group holds it", () => {
    const lastOpen = (id: string) => new Map([["workspace:w-1", id]]);

    expect(openIdOf({})).toBe("s-lead");
    expect(openIdOf({ lastOpen: lastOpen("s-review") })).toBe("s-review");
    // A session no longer in the group is not opened.
    expect(openIdOf({ lastOpen: lastOpen("s-gone") })).toBe("s-lead");
    expect(openIdOf({ selectedId: "s-second", lastOpen: lastOpen("s-review") })).toBe("s-second");
  });

  it("say whether the Office seats the session they open", () => {
    const sessions = [thread("s-lead", done(5)), agent("s-review", { status: "busy" })];
    const seatedAfter = (lastOpenId: string) =>
      select(sessions, { lastOpen: new Map([["workspace:w-1", lastOpenId]]) }).projects[0]?.rows[0]
        ?.seated;

    expect(seatedAfter("s-lead")).toBe(false);
    expect(seatedAfter("s-review")).toBe(true);
  });

  it("unfold only a group of several sessions that the user unfolded", () => {
    const unfolded = (sessions: readonly Session[], keys: string[]) =>
      select(sessions, { unfolded: new Set(keys) }).projects[0]?.rows[0]?.unfolded;

    expect(unfolded(crew, ["workspace:w-1"])).toBe(true);
    expect(unfolded(crew, [])).toBe(false);
    expect(unfolded([thread("s-1")], ["workspace:w-1"])).toBe(false);
  });
});

describe("the lines of an unfolded row", () => {
  /** Returns a lead and `quiet` idle partners, `extra` sessions after them, and the lead working. */
  const buildRow = (quiet: number, extra: Session[] = []): Session[] => [
    thread("s-lead", { status: "busy" }),
    ...Array.from({ length: quiet }, (_, index) =>
      thread(`s-q${String(index)}`, { createdAt: at(index + 1) }),
    ),
    ...extra,
  ];

  /** Returns the lines the one group `sessions` draws once unfolded: session ids, then "quiet:n" for the folded line. */
  const listLines = (
    sessions: readonly Session[],
    {
      selectedId = null,
      quietShown = false,
    }: { selectedId?: string | null; quietShown?: boolean } = {},
  ): string[] => {
    const view = select(sessions, {
      selectedId,
      unfolded: new Set(["workspace:w-1"]),
      quietShown: quietShown ? new Set(["workspace:w-1"]) : new Set(),
      doneShelfLimit: DONE_SHELF_LIMIT,
    });
    const row = view.projects[0]?.rows[0] ?? view.doneShelf.rows[0];
    return (
      row?.lines.map((line) =>
        line.kind === "member" ? line.member.sessionId : `quiet:${String(line.count)}`,
      ) ?? []
    );
  };

  it("draws no lines for a row of one session", () => {
    expect(listLines(buildRow(0))).toEqual([]);
  });

  it("draws one line per session in the group's order, lead first", () => {
    const sessions = [
      thread("s-lead", { status: "busy" }),
      agent("s-agent", { status: "busy" }),
      thread("s-partner", { createdAt: at(2), status: "busy" }),
    ];

    expect(listLines(sessions)).toEqual(["s-lead", "s-agent", "s-partner"]);
  });

  it("draws two quiet sessions as lines, and folds three or more into one", () => {
    expect(listLines(buildRow(2))).toEqual(["s-lead", "s-q0", "s-q1"]);
    expect(listLines(buildRow(3))).toEqual(["s-lead", "quiet:3"]);
  });

  it("draws every line of a group whose sessions are all quiet, so the quiet line is never alone", () => {
    const idle = buildRow(3).map((session) => ({ ...session, status: "idle" as const }));
    const shelf = idle.map((session, index) => ({ ...session, ...done(10 + index) }));

    for (const sessions of [idle, shelf]) {
      expect(listLines(sessions)).toEqual(["s-lead", "s-q0", "s-q1", "s-q2"]);
    }
  });

  it("counts a Done Thread and an ended Agent session among the quiet ones, and draws them once the quiet line is pressed", () => {
    const sessions = buildRow(1, [
      thread("s-done", { ...done(30), createdAt: at(5) }),
      agent("s-ended", { status: "exited", exitedAt: at(6), createdAt: at(6) }),
    ]);

    expect(listLines(sessions)).toEqual(["s-lead", "quiet:3"]);
    expect(listLines(sessions, { quietShown: true })).toEqual([
      "s-lead",
      "s-q0",
      "s-done",
      "s-ended",
    ]);
  });

  it("always draws the open session, and leaves it out of the quiet count", () => {
    expect(listLines(buildRow(4), { selectedId: "s-q1" })).toEqual(["s-lead", "s-q1", "quiet:3"]);
    expect(listLines(buildRow(4), { selectedId: "s-lead" })).toEqual(["s-lead", "quiet:4"]);
    // With the open one out of the count only two are quiet, so they are drawn, not folded.
    expect(listLines(buildRow(3), { selectedId: "s-q2" })).toEqual([
      "s-lead",
      "s-q0",
      "s-q1",
      "s-q2",
    ]);
  });

  it("folds the quiet sessions when the open one is the only other line", () => {
    const sessions = buildRow(3).map((session) => ({ ...session, status: "idle" as const }));

    expect(listLines(sessions, { selectedId: "s-q2" })).toEqual(["s-q2", "quiet:3"]);
  });
});

describe("the Done shelf", () => {
  const lead = (id: string, minute: number, over: Partial<Session> = {}) =>
    lone(id, minute, { workspaceId: `w-${id}`, ...over });

  it("holds a group once every Thread is Done and every Agent session has ended, and counts groups", () => {
    const sessions = [
      // Done with its ended Agent session: on the shelf as one group of 3 sessions.
      lead("s-a", 0, done(20)),
      lone("s-a2", 1, { workspaceId: "w-s-a", ...done(21) }),
      agent("s-agent", { workspaceId: "w-s-a", status: "exited", createdAt: at(2) }),
      // A partner is still live: the group stays in its project.
      lead("s-b", 3, done(22)),
      lone("s-b2", 4, { workspaceId: "w-s-b" }),
      // A live Agent session keeps the group in its project too.
      lead("s-c", 5, done(23)),
      agent("s-c-agent", { workspaceId: "w-s-c", status: "busy", createdAt: at(6) }),
      // A lone Done Thread.
      lone("s-d", 7, done(24)),
    ];

    const view = select(sessions, { doneShelfLimit: DONE_SHELF_LIMIT });

    expect(view.doneShelf.count).toBe(2);
    expect(view.doneShelf.rows.map(({ row }) => row.leadId)).toEqual(["s-d", "s-a"]);
    expect(view.doneShelf.rows[1]).toMatchObject({
      doneAt: at(21),
      row: { title: "A thread", threadIds: ["s-a", "s-a2"] },
    });
    expect(view.doneShelf.rows[1]?.row.members.map((member) => member.sessionId)).toEqual([
      "s-a",
      "s-a2",
      "s-agent",
    ]);
    expect(listShown(view)[WEBSHOP_PROJECT.id]).toEqual(["s-c", "s-b"]);
  });

  it("lists no project that holds only done groups", () => {
    expect(select([lone("s-1", 0, done(9))]).projects).toEqual([]);
  });

  it("orders the groups by when they were done, newest first, ties by key", () => {
    const sessions = [lone("s-1", 0, done(10)), lone("s-2", 1, done(30)), lone("s-3", 2, done(30))];

    const rows = select(sessions, { doneShelfLimit: DONE_SHELF_LIMIT }).doneShelf.rows;

    expect(rows.map(({ row }) => row.leadId)).toEqual(["s-2", "s-3", "s-1"]);
  });

  it("shows nothing while closed, and `limit` groups with the rest counted when open", () => {
    const sessions = Array.from({ length: 5 }, (_, index) =>
      lone(`s-${String(index)}`, index, done(10 + index)),
    );

    const closed = select(sessions).doneShelf;
    const open = select(sessions, { doneShelfLimit: 2 }).doneShelf;

    expect(closed).toEqual({ count: 5, rows: [], hiddenCount: 0 });
    expect(open.rows.map(({ row }) => row.leadId)).toEqual(["s-4", "s-3"]);
    expect(open.hiddenCount).toBe(3);
  });

  it("always shows the group that holds the open session, closed or beyond the limit", () => {
    const sessions = [
      lone("s-old", 0, { workspaceId: "w-old", ...done(10) }),
      lone("s-old-partner", 1, { workspaceId: "w-old", ...done(11) }),
      lone("s-new", 2, done(30)),
    ];

    const closed = select(sessions, { selectedId: "s-old-partner" }).doneShelf;
    const open = select(sessions, { doneShelfLimit: 1, selectedId: "s-old-partner" }).doneShelf;

    expect(closed.rows.map(({ row }) => row.leadId)).toEqual(["s-old"]);
    expect(open.rows.map(({ row }) => row.leadId)).toEqual(["s-new", "s-old"]);
    expect(open.hiddenCount).toBe(0);
  });
});
