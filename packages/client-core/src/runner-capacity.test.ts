import { describe, expect, it } from "vitest";
import type { Runner, Session, SessionStatus } from "@hercule/contract";
import { describeCapacity } from "./runner-capacity";

const GIB = 1024 * 1024 * 1024;

const MOSS: Runner = {
  id: "01a06d02-beff-7037-9f5b-042822015952",
  name: "moss",
  connectivity: "online",
  lifecycle: "active",
  reserved: false,
  version: "0.4.2",
  labels: [],
  facts: null,
  watermark: null,
  maxConcurrentSessions: 2,
  diskWatermarkBytes: 10 * GIB,
  lastSeenAt: "2026-09-05T09:14:00.000Z",
};

let next = 0;

/** Returns a session with the given status; no other field matters here. */
const buildSession = (status: SessionStatus): Session => {
  next += 1;
  return {
    id: `01a06d02-2000-7000-8000-00000000000${String(next)}`,
    title: "Fix the login bug",
    status,
    resumable: false,
    resumeHeld: false,
    permissionProfileId: "01a06d02-3000-7000-8000-000000000001",
    agentId: null,
    conversationId: null,
    runId: null,
    stepId: null,
    instanceId: "01a06d02-1000-7000-8000-000000000001",
    runnerId: MOSS.id,
    workspaceId: null,
    projectId: null,
    requestedAccessMode: "approval-required",
    accessMode: "approval-required",
    nativeSessionId: null,
    modelSelection: { model: "claude-sonnet-5", options: {} },
    parentSessionId: null,
    openRequests: [],
    openPermissionRequests: [],
    createdAt: "2026-09-05T09:00:00.000Z",
    startedAt: null,
    exitedAt: null,
    lastActivityAt: "2026-09-05T09:00:00.000Z",
    unenforced: [],
  };
};

describe("describeCapacity", () => {
  it("shows how many slots are in use and how many sessions are waiting", () => {
    expect(
      describeCapacity(MOSS, [
        buildSession("busy"),
        buildSession("queued"),
        buildSession("queued"),
      ]),
    ).toBe("1 running of 2 · 2 queued");
  });

  it("leaves out the queue when it is empty", () => {
    expect(describeCapacity(MOSS, [buildSession("busy")])).toBe("1 running of 2");
  });

  it("counts one waiting session too", () => {
    expect(describeCapacity(MOSS, [buildSession("busy"), buildSession("queued")])).toBe(
      "1 running of 2 · 1 queued",
    );
  });

  it("counts a session as running from starting until it exits", () => {
    // `starting` and `idle` hold a slot just as `busy` does: the controller
    // counts all three against the limit, so counting only `busy` would show
    // a full runner as having room.
    expect(
      describeCapacity(MOSS, [
        buildSession("starting"),
        buildSession("idle"),
        buildSession("busy"),
      ]),
    ).toBe("3 running of 2");
  });

  it("counts an exited session as neither running nor queued", () => {
    expect(describeCapacity(MOSS, [buildSession("exited"), buildSession("exited")])).toBe(
      "0 running of 2",
    );
  });

  it("shows zero running for a runner with no sessions", () => {
    expect(describeCapacity(MOSS, [])).toBe("0 running of 2");
  });

  it("reads the maximum from the given runner", () => {
    expect(describeCapacity({ ...MOSS, maxConcurrentSessions: 7 }, [buildSession("busy")])).toBe(
      "1 running of 7",
    );
  });
});
