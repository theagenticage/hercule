/**
 * `lanesOf(sessions)` buckets sessions into the five pinned lanes in their
 * fixed order, and `headlineOf(sessions, now)` reads the same buckets as one
 * sentence.
 */
import { describe, expect, it } from "vitest";
import type { Session } from "@hydra/contract";
import { headlineOf, lanesOf } from "./lanes";

const BASE: Session = {
  id: "s0",
  title: "Fix the login bug",
  status: "idle",
  resumable: false,
  permissionProfileId: "profile-unrestricted",
  instanceId: "instance-claude-code",
  runnerId: "runner-1",
  workspaceId: null,
  requestedAccessMode: "approval-required",
  accessMode: "approval-required",
  nativeSessionId: null,
  modelSelection: { model: "claude-sonnet-5", options: {} },
  parentSessionId: null,
  createdAt: "2026-09-08T09:00:00.000Z",
  startedAt: "2026-09-08T09:00:01.000Z",
  exitedAt: null,
  lastActivityAt: "2026-09-08T09:05:00.000Z",
};

const session = (overrides: Partial<Session> & { id: string }): Session => ({
  ...BASE,
  ...overrides,
});

describe("lanesOf", () => {
  it("always returns the five pinned lanes, in order, even with no sessions", () => {
    const lanes = lanesOf([]);

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
    const busy = session({ id: "busy", status: "busy" });
    const starting = session({ id: "starting", status: "starting" });
    const queued = session({ id: "queued", status: "queued" });
    const idle = session({ id: "idle", status: "idle" });
    const exited = session({ id: "exited", status: "exited" });

    const lanes = lanesOf([busy, starting, queued, idle, exited]);
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
    const resumable = session({
      id: "resumable",
      status: "exited",
      resumable: true,
      nativeSessionId: "n",
    });
    const gone = session({ id: "gone", status: "exited", resumable: false });

    const lanes = lanesOf([resumable, gone]);
    const byKind = Object.fromEntries(lanes.map((lane) => [lane.kind, lane.sessions]));

    expect(byKind.idle!.map((s: Session) => s.id)).toEqual(["resumable"]);
    expect(byKind.settled!.map((s: Session) => s.id)).toEqual(["gone"]);
  });
});

describe("headlineOf", () => {
  const now = new Date("2026-09-08T12:00:00.000Z");

  it("joins running, idle and settled when every segment is nonzero", () => {
    const sessions = [
      session({ id: "r1", status: "busy" }),
      session({ id: "i1", status: "idle" }),
      session({ id: "i2", status: "idle" }),
      session({ id: "s1", status: "exited", exitedAt: "2026-09-05T12:00:00.000Z" }),
      session({ id: "s2", status: "exited", exitedAt: "2026-09-06T12:00:00.000Z" }),
      session({ id: "s3", status: "exited", exitedAt: "2026-09-07T12:00:00.000Z" }),
    ];

    expect(headlineOf(sessions, now)).toBe("1 running · 2 idle · 3 settled this week");
  });

  it("omits a segment whose count is zero", () => {
    const sessions = [
      session({ id: "r1", status: "busy" }),
      session({ id: "s1", status: "exited", exitedAt: "2026-09-07T12:00:00.000Z" }),
    ];

    expect(headlineOf(sessions, now)).toBe("1 running · 1 settled this week");
  });

  it("counts an exit that can be resumed as idle rather than as settled", () => {
    const sessions = [
      session({
        id: "resumable",
        status: "exited",
        resumable: true,
        nativeSessionId: "n",
        exitedAt: "2026-09-07T12:00:00.000Z",
      }),
    ];

    expect(headlineOf(sessions, now)).toBe("1 idle");
  });

  it("excludes an exit more than seven days before now from the settled count", () => {
    const recent = session({
      id: "recent",
      status: "exited",
      exitedAt: "2026-09-05T12:00:00.000Z",
    });
    const old = session({ id: "old", status: "exited", exitedAt: "2026-08-25T00:00:00.000Z" });

    expect(headlineOf([recent, old], now)).toBe("1 settled this week");
  });

  it("does not count an exited session with no exitedAt as settled", () => {
    const sessions = [session({ id: "x", status: "exited", exitedAt: null })];

    expect(headlineOf(sessions, now)).toBe("Nothing active this week");
  });

  it("reads as Nothing active this week when every exit is more than seven days old", () => {
    const sessions = [
      session({ id: "old1", status: "exited", exitedAt: "2026-08-01T00:00:00.000Z" }),
      session({ id: "old2", status: "exited", exitedAt: "2026-07-01T00:00:00.000Z" }),
    ];

    expect(headlineOf(sessions, now)).toBe("Nothing active this week");
  });

  it("reads as No sessions yet only when there is nothing at all", () => {
    expect(headlineOf([], now)).toBe("No sessions yet");
  });
});
