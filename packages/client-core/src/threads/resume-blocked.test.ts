/**
 * Tests `findResumeBlockedReason(session)`, which returns why a thread cannot
 * take input, or `null` when it can.
 */
import { describe, expect, it } from "vitest";
import type { Session } from "@hercule/contract";
import { findResumeBlockedReason } from "@hercule/client-core";

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
  openPermissionRequests: [],
  createdAt: "2026-09-08T09:00:00.000Z",
  startedAt: "2026-09-08T09:00:01.000Z",
  exitedAt: null,
  lastActivityAt: "2026-09-08T09:05:00.000Z",
  unenforced: [],
};

const buildSession = (overrides: Partial<Session>): Session => ({ ...BASE, ...overrides });

describe("findResumeBlockedReason", () => {
  it("returns null for a session that has not exited", () => {
    expect(findResumeBlockedReason(buildSession({ status: "idle" }))).toBeNull();
    expect(findResumeBlockedReason(buildSession({ status: "busy" }))).toBeNull();
  });

  it("returns null for an exited session that can be resumed", () => {
    const exited = buildSession({ status: "exited", resumable: true, nativeSessionId: "n" });
    expect(findResumeBlockedReason(exited)).toBeNull();
  });

  it("says the transcript is gone when a session that cannot be resumed has no native session id", () => {
    const exited = buildSession({ status: "exited", resumable: false, nativeSessionId: null });
    expect(findResumeBlockedReason(exited)).toBe("its transcript is gone");
  });

  it("says the runner was retired when a session that cannot be resumed still has its native session id", () => {
    const exited = buildSession({ status: "exited", resumable: false, nativeSessionId: "n" });
    expect(findResumeBlockedReason(exited)).toBe("its runner was retired");
  });
});
