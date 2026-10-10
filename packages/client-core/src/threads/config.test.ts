/**
 * Tests `readThreadConfig(thread)`, which returns what the thread itself runs
 * with, and `computeEffectiveConfig(base, picks)`, which returns what the
 * composer shows and what a draft spawns with. The model options survive a
 * pick that does not change the model, and are dropped when another model or
 * account is picked. It also tests `holdsMessageContent(message)`, which
 * decides whether a message draft holds anything to send.
 */
import { describe, expect, it } from "vitest";
import type { Session } from "@hercule/contract";
import type { ShelfItem } from "../attachments/shelf";
import {
  computeEffectiveConfig,
  holdsMessageContent,
  readThreadConfig,
  type ThreadConfig,
} from "./config";

const BASE: ThreadConfig = {
  instanceId: "i-claude",
  model: "claude-sonnet-5",
  accessMode: "approval-required",
  runnerId: "r-local",
  profileId: "p-unrestricted",
  options: { effort: "high" },
};

describe("computeEffectiveConfig", () => {
  it("returns the thread's own config when nothing is picked", () => {
    expect(computeEffectiveConfig(BASE, {})).toEqual(BASE);
  });

  it("applies the picked options over the model's current options", () => {
    expect(computeEffectiveConfig(BASE, { options: { thinking: true } }).options).toEqual({
      effort: "high",
      thinking: true,
    });
  });

  it("drops the stored options when another account is picked, because they belong to the old account and model", () => {
    expect(computeEffectiveConfig(BASE, { instanceId: "i-codex" }).options).toEqual({});
  });

  it("drops the stored options when another model is picked, because they belong to the old model", () => {
    expect(computeEffectiveConfig(BASE, { model: "claude-opus-5" })).toMatchObject({
      model: "claude-opus-5",
      options: {},
    });
  });

  it("keeps the options picked for the newly picked model", () => {
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
  resumeHeld: false,
  permissionProfileId: "p-unrestricted",
  agentId: null,
  conversationId: null,
  runId: null,
  stepId: null,
  instanceId: "i-claude",
  runnerId: "r-local",
  workspaceId: "w-1",
  projectId: null,
  requestedAccessMode: "full-access",
  accessMode: "approval-required",
  nativeSessionId: null,
  modelSelection: { model: "claude-sonnet-5", options: { effort: "high" } },
  parentSessionId: null,
  openRequests: [],
  openPermissionRequests: [],
  createdAt: "2026-09-08T09:00:00.000Z",
  startedAt: "2026-09-08T09:00:01.000Z",
  exitedAt: null,
  lastActivityAt: "2026-09-08T09:05:00.000Z",
  unenforced: [],
};

describe("readThreadConfig", () => {
  it("returns a draft's own config", () => {
    expect(readThreadConfig({ kind: "draft", config: BASE })).toBe(BASE);
  });

  it("reads an active thread from the session, using the access mode it runs with, not the one requested", () => {
    expect(readThreadConfig({ kind: "active", session: SESSION })).toEqual({
      ...BASE,
      projectId: null,
      // A session is in an existing workspace or in none, never in one still
      // to be created.
      workspace: { kind: "existing", workspaceId: "w-1" },
    });
  });

  it("treats a thread with no workspace as working without a checkout", () => {
    expect(
      readThreadConfig({ kind: "active", session: { ...SESSION, workspaceId: null } }),
    ).toMatchObject({ workspace: { kind: "none" } });
  });
});

describe("holdsMessageContent", () => {
  const IMAGE: ShelfItem = {
    key: "one",
    name: "one.png",
    sizeBytes: 1,
    file: Object.assign(new Blob(["x"]), { name: "one.png" }),
    status: "uploading",
  };

  it.each<[string, string, readonly ShelfItem[], boolean]>([
    ["no text and no image", "", [], false],
    ["blank text", "  \n", [], false],
    ["text", "Also the tests", [], true],
    ["an image with no text", "", [IMAGE], true],
  ])("returns whether a draft with %s holds something to send", (_, text, attachments, holds) => {
    expect(holdsMessageContent({ text, attachments })).toBe(holds);
  });
});
