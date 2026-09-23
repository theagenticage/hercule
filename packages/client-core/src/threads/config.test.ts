/**
 * `readThreadConfig(thread)` is what the thread itself runs with, and
 * `computeEffectiveConfig(base, picks)` is what the composer draws over it and what a
 * draft spawns with. What matters: the options a model carries survive a pick
 * that is not about the model, and go with the model - and with the account -
 * when either is picked.
 */
import { describe, expect, it } from "vitest";
import type { Session } from "@hercule/contract";
import { computeEffectiveConfig, readThreadConfig, type ThreadConfig } from "./config";

const BASE: ThreadConfig = {
  instanceId: "i-claude",
  model: "claude-sonnet-5",
  accessMode: "approval-required",
  runnerId: "r-local",
  profileId: "p-unrestricted",
  options: { effort: "high" },
};

describe("computeEffectiveConfig", () => {
  it("is the thread's own configuration when nothing is picked", () => {
    expect(computeEffectiveConfig(BASE, {})).toEqual(BASE);
  });

  it("lays the options picked over the ones the model already runs with", () => {
    expect(computeEffectiveConfig(BASE, { options: { thinking: true } }).options).toEqual({
      effort: "high",
      thinking: true,
    });
  });

  it("drops the stored options when another account is picked: they went with the pair", () => {
    expect(computeEffectiveConfig(BASE, { instanceId: "i-codex" }).options).toEqual({});
  });

  it("drops the stored options when another model is picked: they went with it", () => {
    expect(computeEffectiveConfig(BASE, { model: "claude-opus-5" })).toMatchObject({
      model: "claude-opus-5",
      options: {},
    });
  });

  it("keeps the options picked under the model just picked", () => {
    expect(
      computeEffectiveConfig(BASE, { model: "claude-opus-5", options: { effort: "low" } }).options,
    ).toEqual({ effort: "low" });
  });
});

const SESSION: Session = {
  id: "s1",
  title: "Fix the login bug",
  status: "idle",
  resumable: false,
  permissionProfileId: "p-unrestricted",
  agentId: null,
  instanceId: "i-claude",
  runnerId: "r-local",
  workspaceId: "w-1",
  projectId: null,
  requestedAccessMode: "full-access",
  accessMode: "approval-required",
  nativeSessionId: null,
  modelSelection: { model: "claude-sonnet-5", options: { effort: "high" } },
  parentSessionId: null,
  openRequest: null,
  createdAt: "2026-09-08T09:00:00.000Z",
  startedAt: "2026-09-08T09:00:01.000Z",
  exitedAt: null,
  lastActivityAt: "2026-09-08T09:05:00.000Z",
  unenforced: [],
};

describe("readThreadConfig", () => {
  it("is the draft's own config, which is all a draft has", () => {
    expect(readThreadConfig({ kind: "draft", config: BASE })).toBe(BASE);
  });

  it("reads an active thread off the session: the mode it runs at, not the one asked for", () => {
    expect(readThreadConfig({ kind: "active", session: SESSION })).toEqual({
      ...BASE,
      projectId: null,
      // Where it works is the session's own, and a session is in a workspace
      // that already stands or in none at all - never in one to be made.
      workspace: { kind: "existing", workspaceId: "w-1" },
    });
  });

  it("reads a thread with no workspace as one working without a checkout", () => {
    expect(
      readThreadConfig({ kind: "active", session: { ...SESSION, workspaceId: null } }),
    ).toMatchObject({ workspace: { kind: "none" } });
  });
});
