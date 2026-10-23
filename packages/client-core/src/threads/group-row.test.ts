/**
 * Tests `describeGroupRows` and `listGroupLines`, which decide what the
 * sidebar shows for a group of sessions. The tests check that:
 *
 * - a lone Thread's row is that Thread's: its status, its place, no dots;
 * - the status is the most urgent counted session's, and a Done Thread or an
 *   ended Agent session is not counted, but stays among the members;
 * - the second line is the question of the session that asked first, named by
 *   its label unless the lead asks, and the place otherwise;
 * - the dots are one per counted session up to three, then the three most
 *   urgent and "+n", with words that describe every session, Done and ended
 *   ones included;
 * - an unfolded row folds more than two quiet sessions into one line, except
 *   the open one.
 */
import type { OpenRequest, ProviderInstance, Session } from "@hercule/contract";
import { describe, expect, it } from "vitest";
import { describeGroupRows, listGroupLines, type GroupRow } from "./group-row";
import { buildSessionGroups } from "./session-groups";
import {
  buildProject,
  MOSS,
  PRIMARY,
  THREAD_3F1,
  WEBSHOP,
  WEBSHOP_PROJECT,
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

const done = (minute: number): Pick<Session, "done"> => ({ done: { at: at(minute), by: "user" } });

const INSTANCES: readonly ProviderInstance[] = [
  { id: "i-claude", providerId: "claude-code", snapshots: [] },
  { id: "i-codex", providerId: "codex", snapshots: [] },
] as unknown as readonly ProviderInstance[];

/** Returns the row of the one group `sessions` form, with no project listed unless `projects` names some. */
const describeOnly = (
  sessions: readonly Session[],
  {
    projects = [WEBSHOP_PROJECT],
  }: { projects?: Parameters<typeof describeGroupRows>[0]["projects"] } = {},
): GroupRow => {
  const [row, ...rest] = describeGroupRows({
    groups: buildSessionGroups(sessions),
    projects,
    workspaces: [PRIMARY, THREAD_3F1],
    resources: [WEBSHOP],
    runners: [MOSS],
    instances: INSTANCES,
  });
  expect(rest).toEqual([]);
  if (row === undefined) throw new Error("expected one row");
  return row;
};

describe("describeGroupRows: a lone Thread", () => {
  it("is the Thread's own row: its title, status and place, with no dots", () => {
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
    expect(row.placeLabel).toEqual({ clip: "", keep: "main" });
  });

  it("asks the question alone, with no asker label", () => {
    const row = describeOnly([thread("s-1", { openRequests: [ask("r-1")] })]);

    expect(row.status).toBe("approval");
    expect(row.ask).toEqual({ askerLabel: null, question: "Run git push?" });
  });

  it("shows the lead's status when the whole group is done", () => {
    const row = describeOnly([thread("s-1", { ...done(30), status: "idle" })]);

    expect(row).toMatchObject({ status: "age", doneAt: at(30) });
  });
});

describe("describeGroupRows: the status", () => {
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
    const question: OpenRequest = {
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
      thread("s-partner", { createdAt: at(2), lastActivityAt: at(0), openRequests: [ask("r-1")] }),
    ]);
    const leadFirst = describeOnly([
      thread("s-lead", { lastActivityAt: at(0), openRequests: [question] }),
      thread("s-partner", { createdAt: at(2), lastActivityAt: at(9), openRequests: [ask("r-1")] }),
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
    const recent = describeOnly([
      thread("s-1", { status: "idle", lastActivityAt: at(2) }),
      thread("s-2", { status: "idle", lastActivityAt: at(9), createdAt: at(1) }),
    ]);
    const tied = describeOnly([
      thread("s-1", { status: "idle", lastActivityAt: at(2) }),
      thread("s-2", { status: "idle", lastActivityAt: at(2), createdAt: at(1) }),
    ]);

    expect(recent.activityAt).toBe(at(9));
    expect(tied.activityAt).toBe(at(2));
    expect(tied.members.map((member) => member.sessionId)).toEqual(["s-1", "s-2"]);
  });

  it("keeps the lead's name and ignores the lead when the lead is done and a partner works", () => {
    const row = describeOnly([
      thread("s-lead", { ...done(30), status: "idle" }),
      thread("s-partner", { createdAt: at(2), status: "busy" }),
    ]);

    expect(row).toMatchObject({ title: "Thread s-lead", status: "working", doneAt: null });
    expect(row.members.map((member) => [member.sessionId, member.counted, member.dot])).toEqual([
      ["s-lead", false, "quiet"],
      ["s-partner", true, "working"],
    ]);
  });

  it("does not let a Done Thread that waits decide the status, the dots or the question", () => {
    const row = describeOnly([
      thread("s-lead", { ...done(30), openRequests: [ask("r-1")] }),
      thread("s-partner", { createdAt: at(2), status: "idle" }),
    ]);

    expect(row).toMatchObject({ status: "age", ask: null });
    expect(row.members[0]).toMatchObject({ done: true, pose: "waiting", dot: "quiet" });
    expect(row.summary?.dots).toEqual(["quiet"]);
  });

  it("does not count an Agent session that has ended, and keeps it among the members", () => {
    const row = describeOnly([
      thread("s-1", { status: "idle" }),
      agent("s-agent", { status: "exited", exitedAt: at(5) }),
    ]);

    expect(row.members[1]).toMatchObject({ kind: "agent", counted: false, dot: "quiet" });
    expect(row.status).toBe("age");
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

describe("describeGroupRows: what a Done press and the Office use", () => {
  const row = () =>
    describeOnly([
      thread("s-lead", done(30)),
      thread("s-partner", { createdAt: at(2), status: "idle" }),
      agent("s-agent", { status: "busy" }),
      agent("s-gone", { createdAt: at(3), status: "exited", exitedAt: at(5) }),
    ]);

  it("lists the Threads a Done press marks: those not yet Done, never an Agent session", () => {
    expect(row().doneIds).toEqual(["s-partner"]);
  });

  it("seats a member as the Office does: a Done Thread and an ended Agent session are not", () => {
    expect(row().members.map((member) => [member.sessionId, member.seated])).toEqual([
      ["s-lead", false],
      ["s-agent", true],
      ["s-partner", true],
      ["s-gone", false],
    ]);
  });
});

describe("describeGroupRows: the second line", () => {
  const reviewer = (over: Partial<Session> = {}): Session =>
    agent("s-review", { role: "review", instanceId: "i-codex", ...over });

  it("names the asking session by its label, and leads with its provider", () => {
    const row = describeOnly([thread("s-1"), reviewer({ openRequests: [ask("r-1", "git push")] })]);

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

  it("follows the session that asked first, the one that has been still the longest", () => {
    const row = describeOnly([
      thread("s-1", { status: "busy" }),
      reviewer({ lastActivityAt: at(8), openRequests: [ask("r-1", "late")] }),
      agent("s-tests", {
        role: "tests",
        createdAt: at(2),
        lastActivityAt: at(3),
        openRequests: [ask("r-2", "early")],
      }),
    ]);

    expect(row.ask).toEqual({ askerLabel: "tests", question: "Run early?" });
  });

  it("shows where the lead works while nothing asks", () => {
    const row = describeOnly([
      thread("s-1", { workspaceId: PRIMARY.id, projectId: WEBSHOP_PROJECT.id }),
      agent("s-agent", { workspaceId: PRIMARY.id }),
    ]);

    expect(row.ask).toBeNull();
    expect(row.placeLabel).toEqual({ clip: "", keep: "main" });
    expect(row.placeDescription).toBe("in webshop, webshop main workspace, on moss, branch main");
  });

  it("falls back to the machine when the lead's workspace is a generated branch", () => {
    const row = describeOnly([thread("s-1", { workspaceId: THREAD_3F1.id })]);

    expect(row.placeLabel).toEqual({ clip: "moss", keep: "" });
  });
});

describe("describeGroupRows: the project", () => {
  it("is the lead's project", () => {
    expect(describeOnly([thread("s-1", { projectId: WEBSHOP_PROJECT.id })]).projectId).toBe(
      WEBSHOP_PROJECT.id,
    );
  });

  it("is none when the lead has none or its project is not listed any more", () => {
    expect(describeOnly([thread("s-1")]).projectId).toBeNull();
    expect(
      describeOnly([thread("s-1", { projectId: "p-deleted" })], {
        projects: [buildProject("p-other", "other")],
      }).projectId,
    ).toBeNull();
  });

  it("is the lead's even when a partner works in another project", () => {
    const row = describeOnly([
      thread("s-1", { projectId: WEBSHOP_PROJECT.id }),
      thread("s-2", { projectId: "p-ops", createdAt: at(2) }),
    ]);

    expect(row.projectId).toBe(WEBSHOP_PROJECT.id);
  });
});

describe("describeGroupRows: the dots", () => {
  /** Returns `count` Threads of one group: the first idle, then `busy` working and `waiting` waiting ones. */
  const buildCrew = (count: number, busy: number, waiting: number): Session[] =>
    Array.from({ length: count }, (_, index) =>
      thread(`s-${String(index)}`, {
        createdAt: at(index),
        status: index >= 1 && index <= busy ? "busy" : "idle",
        openRequests: index > busy && index <= busy + waiting ? [ask(`r-${String(index)}`)] : [],
      }),
    );

  it("has none for a group of one session", () => {
    expect(describeOnly(buildCrew(1, 0, 0)).summary).toBeNull();
  });

  it("has one dot per session for 2 and for 3 sessions, the most urgent first", () => {
    expect(describeOnly(buildCrew(2, 1, 0)).summary).toMatchObject({
      dots: ["working", "quiet"],
      hiddenCount: 0,
      label: "2 threads: 1 working, 1 quiet",
    });
    expect(describeOnly(buildCrew(3, 1, 1)).summary).toMatchObject({
      dots: ["waiting", "working", "quiet"],
      hiddenCount: 0,
    });
  });

  it("shows the three most urgent and the rest as +n for more than 3 sessions", () => {
    const summary = describeOnly(buildCrew(10, 3, 1)).summary;

    expect(summary).toMatchObject({
      dots: ["waiting", "working", "working"],
      hiddenCount: 7,
      label: "10 threads: 1 waiting on you, 3 working, 6 quiet",
    });
  });

  it("counts queued as working, and draws no dot for a Done Thread or an ended Agent session", () => {
    const summary = describeOnly([
      thread("s-1", { status: "queued" }),
      thread("s-2", { ...done(30), createdAt: at(2) }),
      agent("s-agent", { status: "exited", exitedAt: at(5) }),
    ]).summary;

    expect(summary).toMatchObject({
      dots: ["working"],
      hiddenCount: 0,
      label: "3 sessions: 1 working, 1 done, 1 ended",
    });
  });

  it("draws one quiet dot, and names the done Thread in words, for a Done lead and one idle partner", () => {
    const summary = describeOnly([
      thread("s-lead", { ...done(30), openRequests: [ask("r-1")] }),
      thread("s-partner", { createdAt: at(2), status: "idle" }),
    ]).summary;

    expect(summary).toMatchObject({
      dots: ["quiet"],
      hiddenCount: 0,
      label: "2 threads: 1 quiet, 1 done",
    });
  });

  it("does not let Done Threads inflate the +n", () => {
    const summary = describeOnly([
      ...buildCrew(4, 3, 0),
      ...[5, 6, 7].map((index) =>
        thread(`s-${String(index)}`, { ...done(30), createdAt: at(index) }),
      ),
    ]).summary;

    expect(summary).toMatchObject({
      dots: ["working", "working", "working"],
      hiddenCount: 1,
      label: "7 threads: 3 working, 1 quiet, 3 done",
    });
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

  it("keeps a summary with no dot for a group with nothing counted, so the row still unfolds", () => {
    const summary = describeOnly([
      thread("s-1", done(30)),
      thread("s-2", { ...done(31), createdAt: at(2) }),
    ]).summary;

    expect(summary).toMatchObject({ dots: [], hiddenCount: 0, label: "2 threads: 2 done" });
  });
});

describe("listGroupLines", () => {
  /** Returns a row of `quiet` idle Threads after a working lead, and any `extra` sessions. */
  const buildRow = (quiet: number, extra: Session[] = []): GroupRow =>
    describeOnly([
      thread("s-lead", { status: "busy" }),
      ...Array.from({ length: quiet }, (_, index) =>
        thread(`s-q${String(index)}`, { createdAt: at(index + 1) }),
      ),
      ...extra,
    ]);

  const ids = (row: GroupRow, selectedId: string | null = null, quietShown = false) => {
    const { lines, foldedQuietCount } = listGroupLines(row, { selectedId, quietShown });
    return { lines: lines.map((line) => line.sessionId), foldedQuietCount };
  };

  it("draws no lines for a row of one session", () => {
    expect(ids(buildRow(0))).toEqual({ lines: [], foldedQuietCount: 0 });
  });

  it("draws one line per session in the group's order, lead first", () => {
    const row = describeOnly([
      thread("s-lead", { status: "busy" }),
      agent("s-agent", { status: "busy" }),
      thread("s-partner", { createdAt: at(2), status: "busy" }),
    ]);

    expect(ids(row)).toEqual({ lines: ["s-lead", "s-agent", "s-partner"], foldedQuietCount: 0 });
  });

  it("draws two quiet sessions as lines, and folds three or more into one", () => {
    expect(ids(buildRow(2))).toEqual({ lines: ["s-lead", "s-q0", "s-q1"], foldedQuietCount: 0 });
    expect(ids(buildRow(3))).toEqual({ lines: ["s-lead"], foldedQuietCount: 3 });
  });

  it("counts a Done Thread and an ended Agent session among the quiet ones", () => {
    const row = buildRow(1, [
      thread("s-done", { ...done(30), createdAt: at(5) }),
      agent("s-ended", { status: "exited", exitedAt: at(6), createdAt: at(6) }),
    ]);

    expect(ids(row)).toEqual({ lines: ["s-lead"], foldedQuietCount: 3 });
    expect(listGroupLines(row, { selectedId: null, quietShown: true }).lines[2]).toMatchObject({
      sessionId: "s-done",
      done: true,
    });
  });

  it("always draws the open session, and leaves it out of the quiet count", () => {
    expect(ids(buildRow(4), "s-q1")).toEqual({ lines: ["s-lead", "s-q1"], foldedQuietCount: 3 });
    expect(ids(buildRow(4), "s-lead")).toEqual({ lines: ["s-lead"], foldedQuietCount: 4 });
    // With the open one out of the count only two are quiet, so they are drawn, not folded.
    expect(ids(buildRow(3), "s-q2")).toEqual({
      lines: ["s-lead", "s-q0", "s-q1", "s-q2"],
      foldedQuietCount: 0,
    });
  });

  it("draws every session once the user opened the quiet line", () => {
    expect(ids(buildRow(3), null, true)).toEqual({
      lines: ["s-lead", "s-q0", "s-q1", "s-q2"],
      foldedQuietCount: 0,
    });
  });

  it("labels each line by its role, or by its title when it has none, numbering repeated roles", () => {
    const row = describeOnly([
      thread("s-lead"),
      agent("s-r1", { role: "review" }),
      agent("s-r2", { role: "Review", createdAt: at(2) }),
    ]);

    expect(row.members.map((member) => member.label)).toEqual([
      "Thread s-lead",
      "review",
      "Review 2",
    ]);
  });
});
