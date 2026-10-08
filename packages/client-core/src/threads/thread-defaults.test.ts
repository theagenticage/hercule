/**
 * Tests `computeThreadDefaults`, the rule the composer and Settings > Threads
 * both use to prefill a new thread, `computeInstanceDefaults`, which resolves
 * the runner first and then the model, and `buildDraftConfig`, which places
 * those defaults in a Draft Thread's project. The tests check that:
 *
 * - a stored setting always wins;
 * - a stale instance id falls back to the default instance;
 * - the model is read from the runner the thread would actually be placed on;
 * - nothing picked is `null`, never an empty string.
 */
import { describe, expect, it } from "vitest";
import type { Profile, ProviderInstance, Runner, SettingsState } from "@hercule/contract";
import { BARE, buildInstance, buildSnapshot } from "../providers.testing";
import {
  buildDraftConfig,
  computeInstanceDefaults,
  computeThreadDefaults,
} from "./thread-defaults";

const buildRunner = (overrides: Partial<Runner> & { id: string }): Runner => ({
  ...BARE,
  ...overrides,
});

const LOCAL = buildRunner({ id: "r-local", name: "moss" });
const REMOTE = buildRunner({ id: "r-remote", name: "cove" });

const buildProfile = (id: string, name: string): Profile => ({
  id,
  name,
  grants: [],
  shipped: true,
  createdAt: "2026-09-05T09:00:00.000Z",
  updatedAt: "2026-09-05T09:00:00.000Z",
});

const UNRESTRICTED = buildProfile("p-unrestricted", "unrestricted");
const WORKER = buildProfile("p-worker", "worker");

/** Returns an instance logged in on `runnerId`, with the given models. */
const buildSnapshotOn = (
  runnerId: string,
  models: ProviderInstance["snapshots"][number]["models"],
): ProviderInstance["snapshots"][number] => buildSnapshot({ runnerId, models });

const SONNET = {
  slug: "claude-sonnet-5",
  name: "Sonnet",
  imageInput: { maxBytes: null },
  isDefault: true,
  options: [],
};
const OPUS = { slug: "claude-opus-5", name: "Opus", imageInput: { maxBytes: null }, options: [] };
const HAIKU = {
  slug: "claude-haiku-5",
  name: "Haiku",
  imageInput: { maxBytes: null },
  options: [],
};

const NO_SETTINGS: SettingsState["user"] = {};

describe("computeInstanceDefaults", () => {
  it("resolves the runner first and reads the model from that runner's catalog", () => {
    // The local runner is not logged in, so the thread is placed on the remote
    // runner, and the model must come from that runner's catalog, not from
    // whichever snapshot happens to be first.
    const claude = buildInstance("claude-code", "Claude Code", [
      buildSnapshot({ runnerId: LOCAL.id, auth: { status: "unauthenticated" }, models: [SONNET] }),
      buildSnapshotOn(REMOTE.id, [HAIKU]),
    ]);

    expect(computeInstanceDefaults(claude, [LOCAL, REMOTE], LOCAL.id)).toEqual({
      runnerId: REMOTE.id,
      model: "claude-haiku-5",
    });
  });

  it("prefers the local runner and the catalog's default model", () => {
    const claude = buildInstance("claude-code", "Claude Code", [
      buildSnapshotOn(REMOTE.id, [HAIKU]),
      buildSnapshotOn(LOCAL.id, [OPUS, SONNET]),
    ]);

    expect(computeInstanceDefaults(claude, [LOCAL, REMOTE], LOCAL.id)).toEqual({
      runnerId: LOCAL.id,
      model: "claude-sonnet-5",
    });
  });

  it("falls back to the catalog's first model when none is marked default", () => {
    const claude = buildInstance("claude-code", "Claude Code", [
      buildSnapshotOn(LOCAL.id, [OPUS, HAIKU]),
    ]);

    expect(computeInstanceDefaults(claude, [LOCAL], LOCAL.id).model).toBe("claude-opus-5");
  });

  it("has no runner and no model when no runner is logged in to the instance", () => {
    const claude = buildInstance("claude-code", "Claude Code", [
      buildSnapshot({ runnerId: LOCAL.id, auth: { status: "unauthenticated" }, models: [SONNET] }),
    ]);

    expect(computeInstanceDefaults(claude, [LOCAL], LOCAL.id)).toEqual({
      runnerId: null,
      model: null,
    });
  });
});

describe("computeThreadDefaults", () => {
  const claude = buildInstance("claude-code", "Claude Code", [
    buildSnapshotOn(LOCAL.id, [SONNET, OPUS]),
  ]);
  const codex = buildInstance("codex", "Codex", [buildSnapshotOn(LOCAL.id, [HAIKU])]);

  it("prefills from the built-in defaults when no thread setting is stored", () => {
    expect(
      computeThreadDefaults(
        NO_SETTINGS,
        [claude, codex],
        [LOCAL],
        [UNRESTRICTED, WORKER],
        LOCAL.id,
      ),
    ).toEqual({
      instanceId: claude.id,
      model: "claude-sonnet-5",
      accessMode: "approval-required",
      runnerId: LOCAL.id,
      profileId: UNRESTRICTED.id,
    });
  });

  it("lets every stored thread setting win over the default", () => {
    const stored: SettingsState["user"] = {
      "thread.instanceId": codex.id,
      "thread.model": "claude-haiku-5",
      "thread.accessMode": "full-access",
      "thread.profileId": WORKER.id,
    };

    expect(
      computeThreadDefaults(stored, [claude, codex], [LOCAL], [UNRESTRICTED, WORKER], LOCAL.id),
    ).toEqual({
      instanceId: codex.id,
      model: "claude-haiku-5",
      accessMode: "full-access",
      runnerId: LOCAL.id,
      profileId: WORKER.id,
    });
  });

  it("falls back to the default instance when the stored id matches none, rather than picking nothing", () => {
    const stale: SettingsState["user"] = { "thread.instanceId": "instance-that-went-away" };

    expect(
      computeThreadDefaults(stale, [claude, codex], [LOCAL], [UNRESTRICTED], LOCAL.id).instanceId,
    ).toBe(claude.id);
  });

  it("keeps a stored model the resolved runner does not offer, rather than silently replacing it", () => {
    const stored: SettingsState["user"] = { "thread.model": "claude-haiku-5" };

    expect(computeThreadDefaults(stored, [claude], [LOCAL], [UNRESTRICTED], LOCAL.id).model).toBe(
      "claude-haiku-5",
    );
  });

  it("takes the first profile when none is named unrestricted", () => {
    expect(
      computeThreadDefaults(NO_SETTINGS, [claude], [LOCAL], [WORKER], LOCAL.id).profileId,
    ).toBe(WORKER.id);
  });

  it("returns null for every field when there is nothing to pick", () => {
    expect(computeThreadDefaults(NO_SETTINGS, [], [], [], null)).toEqual({
      instanceId: null,
      model: null,
      accessMode: "approval-required",
      runnerId: null,
      profileId: null,
    });
  });
});

describe("buildDraftConfig", () => {
  const claude = buildInstance("claude-code", "Claude Code", [buildSnapshotOn(LOCAL.id, [SONNET])]);
  const reads = {
    instances: [claude],
    runners: [LOCAL],
    profiles: [UNRESTRICTED],
    thisMacRunnerId: LOCAL.id,
  };

  it("starts a draft in its project from the defaults, joining no workspace, with the stored workspace setting", () => {
    expect(
      buildDraftConfig({
        ...reads,
        settingsUser: { "thread.workspace": "ephemeral" },
        projectId: "p-webshop",
        workspaceId: null,
      }),
    ).toEqual({
      instanceId: claude.id,
      model: "claude-sonnet-5",
      accessMode: "approval-required",
      runnerId: LOCAL.id,
      profileId: UNRESTRICTED.id,
      options: {},
      projectId: "p-webshop",
      workspace: null,
      preferredWorkspace: "ephemeral",
    });
  });

  it("joins the workspace the draft was opened for, and has no stored workspace setting when none is set", () => {
    expect(
      buildDraftConfig({
        ...reads,
        settingsUser: NO_SETTINGS,
        projectId: null,
        workspaceId: "w-shared",
      }),
    ).toMatchObject({
      projectId: null,
      workspace: { kind: "existing", workspaceId: "w-shared" },
      preferredWorkspace: null,
    });
  });
});
