/**
 * Tests `buildMachineWork`, `buildFleetFaces` and `listMachineRunIds`, which
 * decide what "Running here" and the Fleet cards' faces show for a machine.
 * The tests check that:
 *
 * - runs, rows of Threads and assistants each form one group with the name
 *   the user knows them by, and open what they are;
 * - only the machine's own, open sessions count;
 * - groups and sessions come in the order the page shows them;
 * - the cards' faces follow the page's groups;
 * - the result stays equal when a session's usage or last activity changes.
 */
import type { OpenRequest, Runner, Session } from "@hercule/contract";
import { describe, expect, it } from "vitest";
import { indexRowMembers } from "../threads/row-members";
import { prepareSessionPresentation } from "../threads/session-presentation";
import { COVE, MOSS, buildSession } from "../threads/workspaces.testing";
import { buildFleetFaces, buildMachineWork, listMachineRunIds } from "./machine-work";

const TIMEZONE = "UTC";
const TODAY = new Date("2026-09-10T12:00:00.000Z");

/** Returns a timestamp `minute` minutes after 09:00 on the day of `TODAY`. */
const at = (minute: number): string =>
  new Date(Date.parse("2026-09-10T09:00:00.000Z") + minute * 60_000).toISOString();

const approval: OpenRequest = {
  requestId: "req-1",
  itemId: "tool-1",
  decisions: ["allow", "deny"],
  kind: "command_approval",
  detail: { command: "git push" },
};

/** Returns a Thread of workspace `w-1`, started at minute `minute`. */
const thread = (id: string, minute: number, over: Partial<Session> = {}): Session =>
  buildSession({
    id,
    title: `Title of ${id}`,
    workspaceId: "w-1",
    status: "busy",
    createdAt: at(minute),
    startedAt: at(minute),
    ...over,
  });

/** Returns the Agent's session of workspace `w-1`, started at minute `minute`. */
const agentSession = (id: string, minute: number, over: Partial<Session> = {}): Session =>
  thread(id, minute, { agentId: "agent-1", ...over });

/** Returns the step session `stepId` of run `runId`, started at minute `minute`. */
const step = (id: string, runId: string, stepId: string, minute: number): Session =>
  thread(id, minute, {
    agentId: "agent-step",
    runId,
    stepId,
    workspaceId: `w-${runId}`,
    title: `Review PRs · ${stepId}`,
  });

/** Returns a session of the assistant `assistantId`. */
const assistantSession = (
  id: string,
  assistantId: string,
  minute: number,
  over: Partial<Session> = {},
): Session =>
  thread(id, minute, {
    agentId: assistantId,
    conversationId: "conv-1",
    workspaceId: null,
    title: "Good morning",
    ...over,
  });

/** Returns what the shell holds of the sidebar's rows for `sessions`, as `buildMachineWork` takes it. */
const holdRows = (sessions: readonly Session[]) =>
  indexRowMembers(
    prepareSessionPresentation({
      listedSessions: sessions.filter((s) => s.kind === "thread" || s.kind === "agent"),
      openSession: null,
      projects: [],
      workspaces: [],
      resources: [],
      runners: [MOSS, COVE],
      accounts: [],
    }).groupRows,
  );

const work = (
  sessions: readonly Session[],
  over: {
    runner?: Runner;
    workflowNames?: Record<string, string>;
    assistants?: { id: string; name: string }[];
    rowMembers?: ReturnType<typeof holdRows>;
  } = {},
) =>
  buildMachineWork({
    runner: over.runner ?? MOSS,
    sessions,
    rowMembers: over.rowMembers ?? holdRows(sessions),
    workflowNames: over.workflowNames ?? {},
    assistants: over.assistants ?? [],
    timezone: TIMEZONE,
    today: TODAY,
  });

describe("grouping", () => {
  it("puts a run's step sessions in one group named by its workflow", () => {
    const sessions = [step("s-1", "run-1", "review", 5), step("s-2", "run-1", "tests", 6)];
    const { groups } = work(sessions, { workflowNames: { "run-1": "Review PRs" } });

    expect(groups).toEqual([
      expect.objectContaining({
        key: "run:run-1",
        title: "Review PRs",
        kindLabel: "Workflow run",
        memberLabels: "review, tests",
        status: "2 working",
        since: "since 09:05",
        face: { kind: "run", seed: "run-1", pose: "working" },
        faces: {
          faces: [
            { kind: "run", seed: "s-1", pose: "working" },
            { kind: "run", seed: "s-2", pose: "working" },
          ],
          moreCount: 0,
        },
        opens: { kind: "run", runId: "run-1" },
      }),
    ]);
  });

  it("names a run no workflow name is known for by its first session's title", () => {
    const { groups } = work([step("s-1", "run-1", "review", 5)]);

    expect(groups[0]?.title).toBe("Review PRs · review");
  });

  it("puts a Thread and its Agent sessions in the sidebar's row, listing all but the lead", () => {
    const sessions = [
      thread("lead", 0, { title: "Fix the flaky test", role: "lead" }),
      agentSession("helper", 1, { role: "review" }),
      agentSession("tester", 2, { role: "tests" }),
    ];
    const { groups } = work(sessions);

    expect(groups).toEqual([
      expect.objectContaining({
        key: "workspace:w-1",
        title: "Fix the flaky test",
        kindLabel: "Threads",
        memberLabels: "review, tests",
        status: "3 working",
        face: { kind: "thread", seed: "lead", pose: "working" },
        faces: {
          faces: [
            { kind: "thread", seed: "lead", pose: "working" },
            { kind: "agent", seed: "helper", pose: "working" },
            { kind: "agent", seed: "tester", pose: "working" },
          ],
          moreCount: 0,
        },
        opens: { kind: "thread", sessionId: "lead" },
      }),
    ]);
  });

  it("words a row whose only session here is a Thread as just Thread", () => {
    const { groups } = work([thread("lead", 0), agentSession("helper", 1, { status: "exited" })]);

    expect(groups[0]).toMatchObject({ kindLabel: "Thread", memberLabels: "" });
  });

  it("words a row with several sessions here as Threads", () => {
    const { groups } = work([thread("lead", 0), agentSession("helper", 1, { role: "review" })]);

    expect(groups[0]).toMatchObject({ kindLabel: "Threads", memberLabels: "review" });
  });

  it("keeps the sidebar's name for a row whose Threads exited while its Agent session works", () => {
    const sessions = [
      thread("lead", 0, { status: "exited", exitedAt: at(30) }),
      agentSession("helper", 1, { role: "review" }),
    ];
    const { groups } = work(sessions);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      title: "Title of lead",
      kindLabel: "Threads",
      memberLabels: "review",
      status: "1 working",
      opens: { kind: "thread", sessionId: "lead" },
    });
  });

  it("makes a group of its own of a Thread or Agent session no row holds", () => {
    const sessions = [thread("lead", 0), agentSession("stray", 1, { workspaceId: "w-other" })];
    const { groups } = work(sessions, { rowMembers: holdRows([sessions[0]!]) });

    expect(groups.find((group) => group.key === "session:stray")).toMatchObject({
      title: "Title of stray",
      kindLabel: "Agent session",
      memberLabels: "",
      face: { kind: "agent", seed: "stray", pose: "working" },
      opens: { kind: "thread", sessionId: "stray" },
    });
  });

  it("puts an assistant's sessions in one group named by the assistant", () => {
    const sessions = [assistantSession("s-1", "asst-1", 2), assistantSession("s-2", "asst-1", 3)];
    const { groups } = work(sessions, { assistants: [{ id: "asst-1", name: "Maya" }] });

    expect(groups).toEqual([
      expect.objectContaining({
        key: "assistant:asst-1",
        title: "Maya",
        kindLabel: "Assistant",
        memberLabels: "",
        face: { kind: "assistant", seed: "asst-1", pose: "working" },
        opens: { kind: "assistant", assistantId: "asst-1" },
      }),
    ]);
  });

  it("leaves out other machines' sessions and exited ones", () => {
    const sessions = [
      thread("here", 0),
      thread("elsewhere", 1, { workspaceId: "w-2", runnerId: COVE.id }),
      thread("gone", 2, { workspaceId: "w-3", status: "exited", exitedAt: at(10) }),
    ];
    const { groups, sessions: listed } = work(sessions);

    expect(groups.map((group) => group.key)).toEqual(["workspace:w-1"]);
    expect(listed.map((session) => session.id)).toEqual(["here"]);
  });
});

describe("status", () => {
  const sessions = [
    thread("a", 0),
    thread("b", 1, { workspaceId: "w-b" }),
    thread("c", 2, { workspaceId: "w-c", status: "idle", openRequests: [approval] }),
    thread("d", 3, { workspaceId: "w-d", status: "queued", startedAt: null }),
    thread("e", 4, { workspaceId: "w-e", status: "queued", startedAt: null }),
    thread("f", 5, { workspaceId: "w-f", status: "idle" }),
  ];
  // The same sessions in one workspace, so the sidebar puts them in one row.
  const allInOneRow = sessions.map((session) => ({ ...session, workspaceId: "w-1" }));

  it("counts a machine's sessions in words, in a fixed order", () => {
    const { groups } = work(allInOneRow);

    expect(groups[0]?.status).toBe("2 working · 1 waits for you · 2 wait for a slot · 1 idle");
  });

  it("words each session and flags those waiting for a slot", () => {
    const { sessions: listed } = work(sessions);

    expect(listed.map(({ id, status, waitingForSlot }) => [id, status, waitingForSlot])).toEqual([
      ["d", "Waits for a slot", true],
      ["e", "Waits for a slot", true],
      ["a", "Working", false],
      ["b", "Working", false],
      ["c", "Waits for you", false],
      ["f", "Idle", false],
    ]);
  });

  it("draws a queued session idle, unless it waits on the user", () => {
    const queuedAsking = thread("q", 6, {
      workspaceId: "w-q",
      status: "queued",
      startedAt: null,
      openRequests: [approval],
    });
    const { sessions: listed } = work([sessions[3]!, queuedAsking]);

    expect(listed.map((session) => session.face.pose)).toEqual(["idle", "waiting"]);
    expect(listed.every((session) => session.status === "Waits for a slot")).toBe(true);
  });

  it("draws the group in the most urgent pose of its sessions", () => {
    const { groups } = work([
      thread("w", 0, { workspaceId: "w-a" }),
      thread("i", 1, { workspaceId: "w-a", status: "idle" }),
      thread("n", 2, { workspaceId: "w-a", status: "idle", openRequests: [approval] }),
    ]);

    expect(groups[0]?.face.pose).toBe("waiting");
  });

  it("words sessions on an offline machine as away", () => {
    const offline = { ...MOSS, connectivity: "offline" } satisfies Runner;
    const { groups, sessions: listed } = work([thread("a", 0)], { runner: offline });

    expect(groups[0]).toMatchObject({ status: "1 away", face: { pose: "away" } });
    expect(listed[0]?.status).toBe("Away");
  });
});

describe("order", () => {
  const sessions = [
    thread("old", 0, { workspaceId: "w-old" }),
    thread("new", 10, { workspaceId: "w-new" }),
    thread("queued-late", 20, {
      workspaceId: "w-late",
      status: "queued",
      startedAt: null,
    }),
    thread("queued-early", 15, {
      workspaceId: "w-early",
      status: "queued",
      startedAt: null,
    }),
    thread("mixed", 5, { workspaceId: "w-mixed" }),
    thread("mixed-queued", 30, { workspaceId: "w-mixed", status: "queued", startedAt: null }),
  ];
  const { groups, sessions: listed } = work(sessions);

  it("puts the groups waiting for a slot first, then the others by start", () => {
    expect(groups.map((group) => [group.key, group.waitingForSlot])).toEqual([
      ["workspace:w-early", true],
      ["workspace:w-late", true],
      ["workspace:w-mixed", true],
      ["workspace:w-old", false],
      ["workspace:w-new", false],
    ]);
  });

  it("puts the queued sessions first in the list, then the others by start", () => {
    expect(listed.map((session) => session.id)).toEqual([
      "queued-early",
      "queued-late",
      "mixed-queued",
      "old",
      "mixed",
      "new",
    ]);
  });

  it("does not depend on the order the sessions are listed in", () => {
    // The run has no workflow name and the assistant is not in the list, so each is named by the
    // title of its first session, which must be the first in the page's order.
    const all = [
      ...sessions,
      step("s-late", "run-1", "tests", 12),
      step("s-early", "run-1", "review", 11),
      assistantSession("a-late", "asst-1", 22, { title: "Good evening" }),
      assistantSession("a-early", "asst-1", 21, { title: "Good morning" }),
    ];
    const expected = work(all);

    expect(work(all.toReversed())).toEqual(expected);
    expect(expected.groups.find((group) => group.key === "run:run-1")?.title).toBe(
      "Review PRs · review",
    );
    expect(expected.groups.find((group) => group.key === "assistant:asst-1")?.title).toBe(
      "Good morning",
    );
  });
});

describe("faces of a group", () => {
  it("lists one face per session, at most 12, and counts the rest", () => {
    const lead = thread("lead", 0);
    const helpers = Array.from({ length: 13 }, (_, index) =>
      agentSession(`h-${String(index).padStart(2, "0")}`, index + 1),
    );
    const { groups } = work([lead, ...helpers]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.faces.faces.map((face) => face.seed)).toEqual([
      "lead",
      ...helpers.slice(0, 11).map((session) => session.id),
    ]);
    expect(groups[0]?.faces.moreCount).toBe(2);
  });

  it("counts none left out for a group with fewer", () => {
    const { groups } = work([thread("lead", 0), agentSession("helper", 1)]);

    expect(groups[0]?.faces).toMatchObject({ moreCount: 0 });
    expect(groups[0]?.faces.faces).toHaveLength(2);
  });
});

describe("since", () => {
  it("words the earliest start as the Fleet words a time, in the user's timezone", () => {
    const sessions = [thread("a", 12), thread("b", 3)];
    const { groups } = buildMachineWork({
      runner: MOSS,
      sessions,
      rowMembers: holdRows(sessions),
      workflowNames: {},
      assistants: [],
      timezone: "Europe/Amsterdam",
      today: TODAY,
    });

    expect(groups[0]?.since).toBe("since 11:03");
  });
});

describe("buildFleetFaces", () => {
  const many = Array.from({ length: 7 }, (_, index) =>
    thread(`t-${String(index)}`, index, { workspaceId: `w-${String(index)}` }),
  );

  it("shows one face per group, at most 5, and counts the rest", () => {
    const faces = buildFleetFaces({
      sessions: many,
      rowMembers: holdRows(many),
      runners: [MOSS, COVE],
    });

    expect(faces[MOSS.id]?.faces.map((face) => face.seed)).toEqual([
      "t-0",
      "t-1",
      "t-2",
      "t-3",
      "t-4",
    ]);
    expect(faces[MOSS.id]?.moreCount).toBe(2);
  });

  it("draws the groups in the order of the page", () => {
    const sessions = [
      ...many.slice(0, 3),
      thread("q", 9, { workspaceId: "w-q", status: "queued", startedAt: null }),
      step("s-1", "run-1", "review", 4),
    ];
    const rowMembers = holdRows(sessions);
    const page = work(sessions, { rowMembers }).groups.map((group) => group.face);

    const { faces } = buildFleetFaces({ sessions, rowMembers, runners: [MOSS] })[MOSS.id]!;

    expect(faces).toEqual(page);
  });

  it("has an entry only for a machine with open sessions, and poses by the machine", () => {
    const sessions = [
      thread("a", 0),
      thread("b", 1, { workspaceId: "w-b", runnerId: COVE.id }),
      thread("c", 2, { workspaceId: "w-c", runnerId: "retired" }),
      thread("d", 3, { workspaceId: "w-d", runnerId: "quiet", status: "exited" }),
    ];
    const faces = buildFleetFaces({
      sessions,
      rowMembers: holdRows(sessions),
      runners: [MOSS, { ...COVE, connectivity: "offline" }],
    });

    expect(Object.keys(faces).toSorted()).toEqual([COVE.id, MOSS.id, "retired"].toSorted());
    expect(faces[MOSS.id]?.faces[0]?.pose).toBe("working");
    expect(faces[COVE.id]?.faces[0]?.pose).toBe("away");
    expect(faces["retired"]?.faces[0]?.pose).toBe("working");
  });
});

describe("a push that changes only usage or last activity", () => {
  it("leaves both results equal", () => {
    const before = [thread("lead", 0), step("s-1", "run-1", "review", 1)];
    const after = before.map((session) => ({
      ...session,
      lastActivityAt: at(50),
      toolCalls: session.toolCalls + 7,
    }));
    const runFor = (sessions: readonly Session[]) => ({
      work: work(sessions, { workflowNames: { "run-1": "Review PRs" } }),
      faces: buildFleetFaces({
        sessions,
        rowMembers: holdRows(sessions),
        runners: [MOSS],
      }),
    });

    expect(runFor(after)).toEqual(runFor(before));
  });
});

describe("listMachineRunIds", () => {
  it("lists the runs with an open step session on the machine, once each and sorted", () => {
    const sessions = [
      step("s-1", "run-b", "review", 0),
      step("s-2", "run-b", "tests", 1),
      step("s-3", "run-a", "review", 2),
      { ...step("s-4", "run-c", "review", 3), status: "exited" } satisfies Session,
      { ...step("s-5", "run-d", "review", 4), runnerId: COVE.id } satisfies Session,
      thread("plain", 5),
    ];

    expect(listMachineRunIds(sessions, MOSS.id)).toEqual(["run-a", "run-b"]);
  });
});
