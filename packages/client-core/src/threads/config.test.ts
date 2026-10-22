/**
 * Tests `readThreadConfig(thread)`, which returns what the thread itself runs
 * with, and `computeEffectiveConfig(base, picks)`, which returns what the
 * composer shows and what a draft spawns with. The model options survive a
 * pick that does not change the model, and are dropped when another model or
 * account is picked. It also tests `holdsMessageContent(message)`, which
 * decides whether a message draft holds anything to send.
 */
import { describe, expect, it } from "vitest";
import type { Runner, Session, Workspace } from "@hercule/contract";
import type { ShelfItem } from "../attachments/shelf";
import { BARE, buildInstance, buildSnapshot } from "../providers.testing";
import {
  computeEffectiveConfig,
  holdsMessageContent,
  readThreadConfig,
  type ThreadCatalogs,
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

const NO_CATALOGS: ThreadCatalogs = { instances: [], runners: [], thisMacRunnerId: null };

const buildModel = (slug: string, isDefault: boolean) => ({
  slug,
  name: slug,
  imageInput: { maxBytes: null },
  isDefault,
  options: [],
});

const LOCAL: Runner = { ...BARE, id: "r-local" };
const REMOTE: Runner = { ...BARE, id: "r-remote" };

/** Logged in on the remote runner only, with a different default model on each runner. */
const CODEX = buildInstance("codex", "Codex", [
  buildSnapshot({ runnerId: LOCAL.id, auth: { status: "unauthenticated" }, models: [] }),
  buildSnapshot({
    runnerId: REMOTE.id,
    models: [buildModel("gpt-5-mini", false), buildModel("gpt-5", true)],
  }),
]);
/** Logged in on both runners, and on the local one it offers a model the remote one does not. */
const TEAM = buildInstance("team", "Team", [
  buildSnapshot({ runnerId: LOCAL.id, models: [buildModel("team-local", true)] }),
  buildSnapshot({ runnerId: REMOTE.id, models: [buildModel("team-remote", true)] }),
]);
/** Has a snapshot on the local runner only. */
const LOCAL_ONLY = buildInstance("local-only", "Local only", [
  buildSnapshot({ runnerId: LOCAL.id, models: [buildModel("local-model", true)] }),
]);
const CATALOGS: ThreadCatalogs = {
  instances: [CODEX, TEAM, LOCAL_ONLY],
  runners: [LOCAL, REMOTE],
  thisMacRunnerId: LOCAL.id,
  workspaces: [{ id: "w-remote", runnerId: REMOTE.id } as Workspace],
};

describe("computeEffectiveConfig", () => {
  it("returns the thread's own config when nothing is picked", () => {
    expect(computeEffectiveConfig(NO_CATALOGS, BASE, {})).toEqual(BASE);
  });

  it("applies the picked options over the model's current options", () => {
    expect(
      computeEffectiveConfig(NO_CATALOGS, BASE, { options: { thinking: true } }).options,
    ).toEqual({
      effort: "high",
      thinking: true,
    });
  });

  it("drops the stored options when another account is picked, because they belong to the old account and model", () => {
    expect(computeEffectiveConfig(NO_CATALOGS, BASE, { instanceId: "i-codex" }).options).toEqual(
      {},
    );
  });

  it("drops the stored options when another model is picked, because they belong to the old model", () => {
    expect(computeEffectiveConfig(NO_CATALOGS, BASE, { model: "claude-opus-5" })).toMatchObject({
      model: "claude-opus-5",
      options: {},
    });
  });

  it("treats an explicit null as a pick of none, and an omitted key as no pick", () => {
    expect(computeEffectiveConfig(NO_CATALOGS, BASE, { model: null }).model).toBeNull();
    expect(computeEffectiveConfig(NO_CATALOGS, BASE, { runnerId: null }).runnerId).toBeNull();
    expect(computeEffectiveConfig(NO_CATALOGS, BASE, { instanceId: null }).instanceId).toBeNull();
    expect(computeEffectiveConfig(NO_CATALOGS, BASE, {})).toMatchObject({
      instanceId: BASE.instanceId,
      model: BASE.model,
      runnerId: BASE.runnerId,
    });
  });

  it("drops the stored options when the model is picked as none", () => {
    expect(computeEffectiveConfig(NO_CATALOGS, BASE, { model: null }).options).toEqual({});
  });

  it("derives the runner and the model of a picked account that has no runner or model picked", () => {
    expect(computeEffectiveConfig(CATALOGS, BASE, { instanceId: CODEX.id })).toMatchObject({
      instanceId: CODEX.id,
      runnerId: REMOTE.id,
      model: "gpt-5",
    });
  });

  it("derives only the model when the runner is picked, from that runner", () => {
    expect(
      computeEffectiveConfig(CATALOGS, BASE, { instanceId: TEAM.id, runnerId: REMOTE.id }),
    ).toMatchObject({ runnerId: REMOTE.id, model: "team-remote" });
  });

  it("keeps the picked model and derives only the runner", () => {
    expect(
      computeEffectiveConfig(CATALOGS, BASE, { instanceId: TEAM.id, model: "custom" }),
    ).toMatchObject({ runnerId: LOCAL.id, model: "custom" });
  });

  it("derives the runner from the existing workspace the draft joins", () => {
    const joined = { kind: "existing", workspaceId: "w-remote" } as const;
    expect(
      computeEffectiveConfig(CATALOGS, { ...BASE, workspace: joined }, { instanceId: TEAM.id }),
    ).toMatchObject({ runnerId: REMOTE.id, model: "team-remote" });
  });

  it("derives no model when the picked account has no snapshot on the runner", () => {
    // The workspace is on the remote runner, and the account is on the local
    // one only. The local runner's model must not be borrowed.
    const joined = { kind: "existing", workspaceId: "w-remote" } as const;
    expect(
      computeEffectiveConfig(
        CATALOGS,
        { ...BASE, workspace: joined },
        { instanceId: LOCAL_ONLY.id },
      ),
    ).toMatchObject({ runnerId: REMOTE.id, model: null });
  });

  it("keeps the options picked for the newly picked model", () => {
    expect(
      computeEffectiveConfig(NO_CATALOGS, BASE, {
        model: "claude-opus-5",
        options: { effort: "low" },
      }).options,
    ).toEqual({ effort: "low" });
  });
});

const SESSION: Session = {
  id: "s1",
  title: "Fix the login bug",
  status: "idle",
  resumable: false,
  resumeHeld: false,
  toolCalls: 0,
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
