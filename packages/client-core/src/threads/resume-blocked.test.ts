/**
 * `resumeBlockedReason(session)` says why a thread cannot take input, or
 * `null` when it can.
 */
import { describe, expect, it } from "vitest";
import type { Session } from "@hydra/contract";
import { resumeBlockedReason } from "@hydra/client-core";

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
  openRequest: null,
  createdAt: "2026-09-08T09:00:00.000Z",
  startedAt: "2026-09-08T09:00:01.000Z",
  exitedAt: null,
  lastActivityAt: "2026-09-08T09:05:00.000Z",
};

const session = (overrides: Partial<Session>): Session => ({ ...BASE, ...overrides });

describe("resumeBlockedReason", () => {
  it("blocks nothing on a session that is not exited", () => {
    expect(resumeBlockedReason(session({ status: "idle" }))).toBeNull();
    expect(resumeBlockedReason(session({ status: "busy" }))).toBeNull();
  });

  it("blocks nothing on an exited session that is resumable", () => {
    const exited = session({ status: "exited", resumable: true, nativeSessionId: "n" });
    expect(resumeBlockedReason(exited)).toBeNull();
  });

  it("says the transcript is gone when an unresumable exit kept no native session", () => {
    const exited = session({ status: "exited", resumable: false, nativeSessionId: null });
    expect(resumeBlockedReason(exited)).toBe("its transcript is gone");
  });

  it("says the runner was retired when an unresumable exit still has its native session", () => {
    const exited = session({ status: "exited", resumable: false, nativeSessionId: "n" });
    expect(resumeBlockedReason(exited)).toBe("its runner was retired");
  });
});
