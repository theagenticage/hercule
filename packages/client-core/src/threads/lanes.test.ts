/**
 * Tests `buildLanes(sessions)`, which groups sessions into the five lanes in
 * their fixed order, `buildHeadline(sessions, now)`, which summarizes the
 * same groups in one sentence, and the functions that sum up, describe and
 * list the step sessions, which sit in no lane.
 */
import { describe, expect, it } from "vitest";
import type { Session } from "@hercule/contract";
import {
  buildHeadline,
  buildLanes,
  buildStepSessionRows,
  describeStartingRun,
  summarizeStepSessions,
} from "./lanes";

const RUN_ID = "01a06d02-c111-7a0e-8b3d-9c1f1f3a9c2e";

const BASE: Session = {
  id: "s0",
  title: "Fix the login bug",
  status: "idle",
  resumable: false,
  resumeHeld: false,
  permissionProfileId: "profile-unrestricted",
  agentId: null,
  conversationId: null,
  runId: null,
  stepId: null,
  instanceId: "instance-claude-code",
  runnerId: "runner-1",
  workspaceId: null,
  projectId: null,
  requestedAccessMode: "approval-required",
  accessMode: "approval-required",
  nativeSessionId: null,
  modelSelection: { model: "claude-sonnet-5", options: {} },
  parentSessionId: null,
  openRequests: [],
  createdAt: "2026-09-08T09:00:00.000Z",
  startedAt: "2026-09-08T09:00:01.000Z",
  exitedAt: null,
  lastActivityAt: "2026-09-08T09:05:00.000Z",
  unenforced: [],
};

const buildSession = (overrides: Partial<Session> & { id: string }): Session => ({
  ...BASE,
  ...overrides,
});

describe("buildLanes", () => {
  it("always returns the five lanes, in order, even with no sessions", () => {
    const lanes = buildLanes([]);

    expect(lanes.map((lane) => lane.kind)).toEqual([
      "waiting",
      "running",
      "idle",
      "assistants",
      "settled",
    ]);
    for (const lane of lanes) expect(lane.sessions).toEqual([]);
  });

  it("places a session of each status in its matching lane, leaving waiting and assistants empty", () => {
    const busy = buildSession({ id: "busy", status: "busy" });
    const starting = buildSession({ id: "starting", status: "starting" });
    const queued = buildSession({ id: "queued", status: "queued" });
    const idle = buildSession({ id: "idle", status: "idle" });
    const exited = buildSession({ id: "exited", status: "exited" });

    const lanes = buildLanes([busy, starting, queued, idle, exited]);
    const byKind = Object.fromEntries(lanes.map((lane) => [lane.kind, lane.sessions]));

    expect(byKind.running!.map((s: Session) => s.id).sort()).toEqual([
      "busy",
      "queued",
      "starting",
    ]);
    expect(byKind.idle!.map((s: Session) => s.id)).toEqual(["idle"]);
    expect(byKind.settled!.map((s: Session) => s.id)).toEqual(["exited"]);
    // Nothing in this build produces a waiting session, and none of these
    // sessions answers a conversation.
    expect(byKind.waiting).toEqual([]);
    expect(byKind.assistants).toEqual([]);
  });

  it("places an exited session that can be resumed in the idle lane, and one that cannot in settled", () => {
    const resumable = buildSession({
      id: "resumable",
      status: "exited",
      resumable: true,
      nativeSessionId: "n",
    });
    const gone = buildSession({ id: "gone", status: "exited", resumable: false });

    const lanes = buildLanes([resumable, gone]);
    const byKind = Object.fromEntries(lanes.map((lane) => [lane.kind, lane.sessions]));

    expect(byKind.idle!.map((s: Session) => s.id)).toEqual(["resumable"]);
    expect(byKind.settled!.map((s: Session) => s.id)).toEqual(["gone"]);
  });

  it("places every session that answers a conversation in the assistants lane and in no other", () => {
    const busy = buildSession({ id: "busy", status: "busy", agentId: "ada", conversationId: "c" });
    const idle = buildSession({ id: "idle", status: "idle", agentId: "ada", conversationId: "c" });
    const exited = buildSession({
      id: "exited",
      status: "exited",
      agentId: "ada",
      conversationId: "c",
    });
    const thread = buildSession({ id: "thread", status: "busy" });

    const lanes = buildLanes([busy, idle, exited, thread]);
    const byKind = Object.fromEntries(lanes.map((lane) => [lane.kind, lane.sessions]));

    expect(byKind.assistants!.map((s: Session) => s.id).sort()).toEqual(["busy", "exited", "idle"]);
    expect(byKind.running!.map((s: Session) => s.id)).toEqual(["thread"]);
    expect(byKind.idle).toEqual([]);
    expect(byKind.settled).toEqual([]);
    expect(byKind.waiting).toEqual([]);
  });

  it("places a step session in no lane, whatever its status", () => {
    const started = (["busy", "idle", "exited"] as const).map((status) =>
      buildSession({ id: `step-${status}`, status, agentId: "ada", runId: RUN_ID }),
    );
    const thread = buildSession({ id: "thread", status: "busy" });

    const lanes = buildLanes([...started, thread]);

    expect(lanes.flatMap((lane) => lane.sessions.map((s) => s.id))).toEqual(["thread"]);
  });
});

describe("buildHeadline", () => {
  const now = new Date("2026-09-08T12:00:00.000Z");

  it("joins running, idle and settled when every segment is nonzero", () => {
    const sessions = [
      buildSession({ id: "r1", status: "busy" }),
      buildSession({ id: "i1", status: "idle" }),
      buildSession({ id: "i2", status: "idle" }),
      buildSession({ id: "s1", status: "exited", exitedAt: "2026-09-05T12:00:00.000Z" }),
      buildSession({ id: "s2", status: "exited", exitedAt: "2026-09-06T12:00:00.000Z" }),
      buildSession({ id: "s3", status: "exited", exitedAt: "2026-09-07T12:00:00.000Z" }),
    ];

    expect(buildHeadline(sessions, now)).toBe("1 running · 2 idle · 3 settled this week");
  });

  it("omits a segment whose count is zero", () => {
    const sessions = [
      buildSession({ id: "r1", status: "busy" }),
      buildSession({ id: "s1", status: "exited", exitedAt: "2026-09-07T12:00:00.000Z" }),
    ];

    expect(buildHeadline(sessions, now)).toBe("1 running · 1 settled this week");
  });

  it("counts an exit that can be resumed as idle rather than as settled", () => {
    const sessions = [
      buildSession({
        id: "resumable",
        status: "exited",
        resumable: true,
        nativeSessionId: "n",
        exitedAt: "2026-09-07T12:00:00.000Z",
      }),
    ];

    expect(buildHeadline(sessions, now)).toBe("1 idle");
  });

  it("excludes an exit more than seven days before now from the settled count", () => {
    const recent = buildSession({
      id: "recent",
      status: "exited",
      exitedAt: "2026-09-05T12:00:00.000Z",
    });
    const old = buildSession({ id: "old", status: "exited", exitedAt: "2026-08-25T00:00:00.000Z" });

    expect(buildHeadline([recent, old], now)).toBe("1 settled this week");
  });

  it("does not count an exited session with no exitedAt as settled", () => {
    const sessions = [buildSession({ id: "x", status: "exited", exitedAt: null })];

    expect(buildHeadline(sessions, now)).toBe("No threads active this week");
  });

  it("returns No threads active this week when every exit is more than seven days old", () => {
    const sessions = [
      buildSession({ id: "old1", status: "exited", exitedAt: "2026-08-01T00:00:00.000Z" }),
      buildSession({ id: "old2", status: "exited", exitedAt: "2026-07-01T00:00:00.000Z" }),
    ];

    expect(buildHeadline(sessions, now)).toBe("No threads active this week");
  });

  it("counts a session that answers a conversation by its status, as it counts a thread", () => {
    const sessions = [
      buildSession({ id: "a1", status: "busy", agentId: "ada", conversationId: "c" }),
      buildSession({ id: "a2", status: "idle", agentId: "bob", conversationId: "d" }),
      buildSession({ id: "t1", status: "busy" }),
    ];

    expect(buildHeadline(sessions, now)).toBe("2 running · 1 idle");
  });

  it("returns No sessions yet only when there are no sessions", () => {
    expect(buildHeadline([], now)).toBe("No sessions yet");
  });

  it("does not count step sessions", () => {
    const sessions = [
      buildSession({ id: "w1", status: "busy", agentId: "ada", runId: RUN_ID }),
      buildSession({ id: "t1", status: "idle" }),
    ];

    expect(buildHeadline(sessions, now)).toBe("1 idle");
    // Sessions exist, so the screen is not empty, but none of them is a thread
    // or an assistant's session.
    expect(buildHeadline(sessions.slice(0, 1), now)).toBe("No threads active this week");
  });
});

describe("step sessions", () => {
  const now = new Date("2026-09-08T12:00:00.000Z");
  const ZONE = "Europe/Amsterdam";
  /** Returns a session that step `implement` of the run started, created at `createdAt`. */
  const buildStepSession = (id: string, status: Session["status"], createdAt: string): Session =>
    buildSession({
      id,
      title: "Fix and ship a pull request · implement",
      status,
      createdAt,
      lastActivityAt: createdAt,
      agentId: "ada",
      runId: RUN_ID,
      stepId: "implement",
    });
  const STARTED = [
    buildStepSession("w-busy", "busy", "2026-09-08T11:00:00.000Z"),
    buildStepSession("w-queued", "queued", "2026-09-07T11:00:00.000Z"),
    // 22:30 UTC on the 7th is already the 8th in Amsterdam.
    buildStepSession("w-idle", "idle", "2026-09-07T22:30:00.000Z"),
    buildStepSession("w-exited", "exited", "2026-09-01T11:00:00.000Z"),
  ];
  const THREAD = buildSession({ id: "thread", status: "busy" });

  it("sums them up as how many, how many running, how many queued, and how many were created today in the user's zone", () => {
    expect(summarizeStepSessions([THREAD, ...STARTED], now, ZONE)).toBe(
      "4 · 1 running · 1 queued · 2 today",
    );
    expect(summarizeStepSessions([THREAD, ...STARTED], now, "UTC")).toBe(
      "4 · 1 running · 1 queued · 1 today",
    );
  });

  it("leaves out a running, queued or today count of zero", () => {
    expect(summarizeStepSessions(STARTED.slice(3), now, ZONE)).toBe("1");
    expect(summarizeStepSessions(STARTED.slice(2), now, ZONE)).toBe("2 · 1 today");
    expect(summarizeStepSessions(STARTED.slice(0, 1), now, ZONE)).toBe("1 · 1 running · 1 today");
  });

  it("sums up nothing when there is no step session", () => {
    expect(summarizeStepSessions([THREAD], now, ZONE)).toBeUndefined();
    expect(summarizeStepSessions([], now, ZONE)).toBeUndefined();
  });

  it("names the run that started a session by the tail of its id", () => {
    expect(describeStartingRun(STARTED[0]!)).toBe("run 1f3a9c2e");
    expect(describeStartingRun(THREAD)).toBeUndefined();
  });

  it("lists only the step sessions as rows, newest first, each with its run", () => {
    const rows = buildStepSessionRows([THREAD, ...STARTED], []);

    expect(rows.map((row) => [row.id, row.secondLine, row.end.kind])).toEqual([
      ["w-busy", "run 1f3a9c2e", "mark"],
      ["w-idle", "run 1f3a9c2e", "age"],
      ["w-queued", "run 1f3a9c2e", "word"],
      ["w-exited", "run 1f3a9c2e", "age"],
    ]);
  });
});
