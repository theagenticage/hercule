/**
 * Tests `computeThreadDefaults`, the rule the composer and Settings > Threads
 * both use to prefill a new thread, `computeProviderAccountDefaults`, which resolves
 * the runner first and then the model, and `buildDraftConfig`, which places
 * those defaults in a Draft Thread's project. The tests check that:
 *
 * - a stored setting always wins;
 * - a stale account id falls back to the default account;
 * - the model is read from the runner the thread would actually be placed on;
 * - nothing picked is `null`, never an empty string.
 */
import { describe, expect, it } from "vitest";
import type { Profile, ProviderAccount, Runner, SettingsState } from "@hercule/contract";
import {
  WITH_AGENTS,
  buildProviderAccount,
  buildSnapshot,
  ANTHROPIC_IDENTITY,
  HARNESSES,
  OPENAI_IDENTITY,
  PROVIDERS,
  type SnapshotDraft,
} from "../providers.testing";

const CATALOGS = { providers: PROVIDERS, harnesses: HARNESSES };
import {
  buildDraftConfig,
  computeProviderAccountDefaults,
  computeThreadDefaults,
  findDefaultModel,
} from "./thread-defaults";

const buildRunner = (overrides: Partial<Runner> & { id: string }): Runner => ({
  ...WITH_AGENTS,
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

/** Returns a snapshot signed in on `runnerId`, with the given models. */
const buildSnapshotOn = (
  runnerId: string,
  models: ProviderAccount["snapshots"][number]["models"],
): SnapshotDraft => buildSnapshot({ runnerId, models });

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

describe("findDefaultModel", () => {
  it("reads the list of the given runner first", () => {
    const claude = buildProviderAccount(ANTHROPIC_IDENTITY, [
      buildSnapshotOn(LOCAL.id, [SONNET]),
      buildSnapshotOn(REMOTE.id, [HAIKU]),
    ]);

    expect(findDefaultModel(claude, ANTHROPIC_IDENTITY.harnessId, REMOTE.id)).toBe(
      "claude-haiku-5",
    );
  });

  it("reads the most recently probed signed-in list when the runner has none, or none is given", () => {
    const older = buildSnapshotOn(LOCAL.id, [SONNET]);
    const newer = {
      ...buildSnapshotOn(REMOTE.id, [HAIKU]),
      probedAt: "2026-09-06T09:10:00.000Z",
    };
    const claude = buildProviderAccount(ANTHROPIC_IDENTITY, [older, newer]);

    expect(findDefaultModel(claude, ANTHROPIC_IDENTITY.harnessId, "r-never-probed")).toBe(
      "claude-haiku-5",
    );
    expect(findDefaultModel(claude, ANTHROPIC_IDENTITY.harnessId, null)).toBe("claude-haiku-5");
  });

  it("ignores a runner's own list when it is signed out there, and returns null when no runner is signed in", () => {
    const signedOut = buildSnapshot({
      runnerId: LOCAL.id,
      auth: { status: "unauthenticated" },
      models: [SONNET],
    });
    const claude = buildProviderAccount(ANTHROPIC_IDENTITY, [signedOut]);

    expect(findDefaultModel(claude, ANTHROPIC_IDENTITY.harnessId, LOCAL.id)).toBeNull();
  });
});

describe("computeProviderAccountDefaults", () => {
  it("resolves the runner first and reads the model from that runner's catalog", () => {
    // The local runner is not signed in, so the thread is placed on the remote
    // runner, and the model must come from that runner's catalog, not from
    // whichever snapshot happens to be first.
    const claude = buildProviderAccount(ANTHROPIC_IDENTITY, [
      buildSnapshot({ runnerId: LOCAL.id, auth: { status: "unauthenticated" }, models: [SONNET] }),
      buildSnapshotOn(REMOTE.id, [HAIKU]),
    ]);

    expect(
      computeProviderAccountDefaults(
        claude,
        ANTHROPIC_IDENTITY.harnessId,
        [LOCAL, REMOTE],
        LOCAL.id,
        CATALOGS,
      ),
    ).toEqual({
      runnerId: REMOTE.id,
      model: "claude-haiku-5",
    });
  });

  it("prefers the local runner and the catalog's default model", () => {
    const claude = buildProviderAccount(ANTHROPIC_IDENTITY, [
      buildSnapshotOn(REMOTE.id, [HAIKU]),
      buildSnapshotOn(LOCAL.id, [OPUS, SONNET]),
    ]);

    expect(
      computeProviderAccountDefaults(
        claude,
        ANTHROPIC_IDENTITY.harnessId,
        [LOCAL, REMOTE],
        LOCAL.id,
        CATALOGS,
      ),
    ).toEqual({
      runnerId: LOCAL.id,
      model: "claude-sonnet-5",
    });
  });

  it("falls back to the catalog's first model when none is marked default", () => {
    const claude = buildProviderAccount(ANTHROPIC_IDENTITY, [
      buildSnapshotOn(LOCAL.id, [OPUS, HAIKU]),
    ]);

    expect(
      computeProviderAccountDefaults(
        claude,
        ANTHROPIC_IDENTITY.harnessId,
        [LOCAL],
        LOCAL.id,
        CATALOGS,
      ).model,
    ).toBe("claude-opus-5");
  });

  it("has no runner and no model when no runner is signed in to the account", () => {
    const claude = buildProviderAccount(ANTHROPIC_IDENTITY, [
      buildSnapshot({ runnerId: LOCAL.id, auth: { status: "unauthenticated" }, models: [SONNET] }),
    ]);

    expect(
      computeProviderAccountDefaults(
        claude,
        ANTHROPIC_IDENTITY.harnessId,
        [LOCAL],
        LOCAL.id,
        CATALOGS,
      ),
    ).toEqual({
      runnerId: null,
      model: null,
    });
  });
});

describe("computeThreadDefaults", () => {
  const claude = buildProviderAccount(ANTHROPIC_IDENTITY, [
    buildSnapshotOn(LOCAL.id, [SONNET, OPUS]),
  ]);
  const codex = buildProviderAccount(OPENAI_IDENTITY, [buildSnapshotOn(LOCAL.id, [HAIKU])]);

  it("prefills from the built-in defaults when no thread setting is stored", () => {
    expect(
      computeThreadDefaults(
        NO_SETTINGS,
        [claude, codex],
        [LOCAL],
        [UNRESTRICTED, WORKER],
        LOCAL.id,
        CATALOGS,
      ),
    ).toEqual({
      providerAccountId: claude.id,
      harnessId: null,
      model: "claude-sonnet-5",
      accessMode: "approval-required",
      runnerId: LOCAL.id,
      profileId: UNRESTRICTED.id,
    });
  });

  it("lets every stored thread setting win over the default", () => {
    const stored: SettingsState["user"] = {
      "thread.providerAccountId": codex.id,
      "thread.harnessId": OPENAI_IDENTITY.harnessId,
      "thread.model": "claude-haiku-5",
      "thread.accessMode": "full-access",
      "thread.profileId": WORKER.id,
    };

    expect(
      computeThreadDefaults(
        stored,
        [claude, codex],
        [LOCAL],
        [UNRESTRICTED, WORKER],
        LOCAL.id,
        CATALOGS,
      ),
    ).toEqual({
      providerAccountId: codex.id,
      harnessId: OPENAI_IDENTITY.harnessId,
      model: "claude-haiku-5",
      accessMode: "full-access",
      runnerId: LOCAL.id,
      profileId: WORKER.id,
    });
  });

  it("falls back to the default account when the stored id matches none, rather than picking nothing", () => {
    const stale: SettingsState["user"] = { "thread.providerAccountId": "account-that-went-away" };

    expect(
      computeThreadDefaults(stale, [claude, codex], [LOCAL], [UNRESTRICTED], LOCAL.id, CATALOGS)
        .providerAccountId,
    ).toBe(claude.id);
  });

  it("drops the stored harness when the stored account is gone, because it belonged to that account", () => {
    const stale: SettingsState["user"] = {
      "thread.providerAccountId": "account-that-went-away",
      "thread.harnessId": "pi/pi",
    };

    expect(
      computeThreadDefaults(stale, [claude], [LOCAL], [UNRESTRICTED], LOCAL.id, CATALOGS),
    ).toMatchObject({ providerAccountId: claude.id, harnessId: null });
  });

  it("drops the stored model when the stored account is gone, and uses the fallback account's default model", () => {
    const stale: SettingsState["user"] = {
      "thread.providerAccountId": "account-that-went-away",
      "thread.model": "model-of-the-deleted-account",
    };

    expect(
      computeThreadDefaults(stale, [claude], [LOCAL], [UNRESTRICTED], LOCAL.id, CATALOGS),
    ).toMatchObject({ providerAccountId: claude.id, model: "claude-sonnet-5" });
  });

  it("reads the model in the stored harness", () => {
    const withPi = {
      ...claude,
      snapshots: [
        ...claude.snapshots,
        buildSnapshot({
          runnerId: LOCAL.id,
          harnessId: "pi/pi",
          models: [{ slug: "glm-5.3", name: "GLM", imageInput: null, options: [] }],
        }),
      ],
    };
    const stored: SettingsState["user"] = {
      "thread.providerAccountId": claude.id,
      "thread.harnessId": "pi/pi",
    };

    expect(
      computeThreadDefaults(stored, [withPi], [LOCAL], [UNRESTRICTED], LOCAL.id, CATALOGS),
    ).toMatchObject({ harnessId: "pi/pi", model: "glm-5.3" });
  });

  it("keeps a stored model the resolved runner does not offer, rather than silently replacing it", () => {
    const stored: SettingsState["user"] = { "thread.model": "claude-haiku-5" };

    expect(
      computeThreadDefaults(stored, [claude], [LOCAL], [UNRESTRICTED], LOCAL.id, CATALOGS).model,
    ).toBe("claude-haiku-5");
  });

  it("takes the first profile when none is named unrestricted", () => {
    expect(
      computeThreadDefaults(NO_SETTINGS, [claude], [LOCAL], [WORKER], LOCAL.id, CATALOGS).profileId,
    ).toBe(WORKER.id);
  });

  it("returns null for every field when there is nothing to pick", () => {
    expect(computeThreadDefaults(NO_SETTINGS, [], [], [], null, CATALOGS)).toEqual({
      providerAccountId: null,
      harnessId: null,
      model: null,
      accessMode: "approval-required",
      runnerId: null,
      profileId: null,
    });
  });
});

describe("buildDraftConfig", () => {
  const claude = buildProviderAccount(ANTHROPIC_IDENTITY, [buildSnapshotOn(LOCAL.id, [SONNET])]);
  const reads = {
    accounts: [claude],
    runners: [LOCAL],
    profiles: [UNRESTRICTED],
    thisMacRunnerId: LOCAL.id,
    catalogs: CATALOGS,
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
      providerAccountId: claude.id,
      harnessId: null,
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
