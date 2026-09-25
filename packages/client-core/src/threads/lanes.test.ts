/**
 * Tests `buildLanes(sessions)`, which groups sessions into the five lanes in
 * their fixed order, and `buildHeadline(sessions, now)`, which summarizes the
 * same groups in one sentence.
 */
import { describe, expect, it } from "vitest";
import type { Session } from "@hercule/contract";
import { buildHeadline, buildLanes } from "./lanes";

const BASE: Session = {
  id: "s0",
  title: "Fix the login bug",
  status: "idle",
  resumable: false,
  permissionProfileId: "profile-unrestricted",
  agentId: null,
  conversationId: null,
  instanceId: "instance-claude-code",
  runnerId: "runner-1",
  workspaceId: null,
  projectId: null,
  requestedAccessMode: "approval-required",
  accessMode: "approval-required",
  nativeSessionId: null,
  modelSelection: { model: "claude-sonnet-5", options: {} },
  parentSessionId: null,
  openRequest: null,
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
    // Nothing in this build produces a waiting or an assistants session.
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

    expect(buildHeadline(sessions, now)).toBe("Nothing active this week");
  });

  it("returns Nothing active this week when every exit is more than seven days old", () => {
    const sessions = [
      buildSession({ id: "old1", status: "exited", exitedAt: "2026-08-01T00:00:00.000Z" }),
      buildSession({ id: "old2", status: "exited", exitedAt: "2026-07-01T00:00:00.000Z" }),
    ];

    expect(buildHeadline(sessions, now)).toBe("Nothing active this week");
  });

  it("returns No sessions yet only when there are no sessions", () => {
    expect(buildHeadline([], now)).toBe("No sessions yet");
  });
});
