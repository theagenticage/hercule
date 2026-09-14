/**
 * `submission(thread, picks, message)` is what the composer hands the system
 * on send: a spawn on a draft thread, one input on an active one, each tagged
 * with which it is. What matters on the active side is what it leaves out - a
 * session's access mode and machine are fixed, so an input carries the text
 * and only the picks the user actually made.
 */
import { describe, expect, it } from "vitest";
import type { Session } from "@hydra/contract";
import { submission } from "./submission";

const CONFIG = {
  instanceId: "instance-claude-code",
  model: "claude-sonnet-5",
  accessMode: "approval-required" as const,
  runnerId: "r-local",
  profileId: "p-unrestricted",
  options: { effort: "low" },
};

const SESSION: Session = {
  id: "s1",
  title: "Fix the login bug",
  status: "idle",
  resumable: false,
  permissionProfileId: "p-unrestricted",
  instanceId: "instance-claude-code",
  runnerId: "r-local",
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

const DRAFT = { kind: "draft" as const, config: CONFIG };
const ACTIVE = { kind: "active" as const, session: SESSION };
const MESSAGE = { text: "ship it" };

describe("submission: a draft thread", () => {
  it("spawns with the draft's config, no workspace and the config's profile", () => {
    expect(submission(DRAFT, {}, MESSAGE)).toEqual({
      kind: "spawn",
      input: {
        prompt: "ship it",
        instanceId: "instance-claude-code",
        model: "claude-sonnet-5",
        options: { effort: "low" },
        accessMode: "approval-required",
        runnerId: "r-local",
        permissionProfileId: "p-unrestricted",
        workspaceId: null,
      },
    });
  });

  it("overlays the picks made since the draft was built", () => {
    expect(
      submission(
        DRAFT,
        { model: "claude-opus-5", options: {}, accessMode: "full-access", runnerId: "r-remote" },
        MESSAGE,
      ),
    ).toEqual({
      kind: "spawn",
      input: {
        prompt: "ship it",
        instanceId: "instance-claude-code",
        model: "claude-opus-5",
        options: {},
        accessMode: "full-access",
        runnerId: "r-remote",
        permissionProfileId: "p-unrestricted",
        workspaceId: null,
      },
    });
  });
});

describe("submission: an active thread", () => {
  it("sends the text alone when nothing was picked", () => {
    expect(submission(ACTIVE, {}, MESSAGE)).toEqual({
      kind: "input",
      sessionId: SESSION.id,
      payload: { text: "ship it" },
    });
  });

  it("sends a picked model with the text", () => {
    expect(submission(ACTIVE, { model: "claude-opus-5" }, MESSAGE)).toEqual({
      kind: "input",
      sessionId: SESSION.id,
      payload: { text: "ship it", model: "claude-opus-5" },
    });
  });

  it("sends picked options with the text", () => {
    expect(submission(ACTIVE, { options: { effort: "high" } }, MESSAGE)).toEqual({
      kind: "input",
      sessionId: SESSION.id,
      payload: { text: "ship it", options: { effort: "high" } },
    });
  });

  it("sends both when both were picked", () => {
    expect(
      submission(ACTIVE, { model: "claude-opus-5", options: { effort: "high" } }, MESSAGE),
    ).toEqual({
      kind: "input",
      sessionId: SESSION.id,
      payload: { text: "ship it", model: "claude-opus-5", options: { effort: "high" } },
    });
  });

  it("carries no other key, whatever else the picks hold", () => {
    expect(
      submission(ACTIVE, { accessMode: "full-access", runnerId: "r-remote" }, MESSAGE),
    ).toEqual({ kind: "input", sessionId: SESSION.id, payload: { text: "ship it" } });
  });
});
