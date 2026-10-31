/**
 * Tests `computeThreadDefaults`, the rule the composer and Settings > Threads
 * both use to prefill a new thread, and `buildDraftConfig`, which places those
 * defaults in a Draft Thread's project. The tests check that:
 *
 * - a stored setting wins over the open Model Profile's default entry;
 * - in a project that names a Model Profile, a new thread starts on the newest
 *   entry the user picked that the profile holds, else on the profile's
 *   default entry; a project with no profile, or a deleted one, starts as
 *   anywhere else;
 * - the profile's default entry starts the thread with its account, harness
 *   and model together;
 * - a stale account id falls back to the profile's default entry;
 * - the runner is the default runner where the account is ready;
 * - nothing picked is `null`, never an empty string.
 */
import { describe, expect, it } from "vitest";
import type { Profile, Project, Runner, SettingsState } from "@hercule/contract";
import {
  ANTHROPIC_IDENTITY,
  OPENAI_IDENTITY,
  WITH_AGENTS,
  buildModelProfile,
  buildProfileEntry,
  buildProfileSection,
  buildProviderAccount,
} from "../providers.testing";
import type { RecentModel } from "./recent";
import { buildDraftConfig, computeThreadDefaults } from "./thread-defaults";

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

const CLAUDE = buildProviderAccount(ANTHROPIC_IDENTITY, [], [{ runnerId: LOCAL.id }]);
const CODEX = buildProviderAccount(OPENAI_IDENTITY, [], [{ runnerId: LOCAL.id }]);

const SONNET = buildProfileEntry(ANTHROPIC_IDENTITY, "claude-sonnet-5");
const OPUS = buildProfileEntry(ANTHROPIC_IDENTITY, "claude-opus-5");
const GPT = buildProfileEntry(OPENAI_IDENTITY, "gpt-6");

/** A profile with Claude's Sonnet and Opus, then Codex's GPT; Sonnet is the default. */
const MAIN = buildModelProfile(
  [
    buildProfileSection(ANTHROPIC_IDENTITY, [SONNET, OPUS]),
    buildProfileSection(OPENAI_IDENTITY, [GPT]),
  ],
  { defaultEntry: { providerAccountId: CLAUDE.id, model: "claude-sonnet-5", harnessId: null } },
);

const NO_SETTINGS: SettingsState["user"] = {};

describe("computeThreadDefaults", () => {
  it("starts on the open profile's default entry when no thread setting is stored", () => {
    expect(
      computeThreadDefaults(
        NO_SETTINGS,
        [CLAUDE, CODEX],
        [LOCAL],
        [UNRESTRICTED, WORKER],
        LOCAL.id,
        [MAIN],
      ),
    ).toEqual({
      providerAccountId: CLAUDE.id,
      harnessId: "claude-code/claude-code",
      model: "claude-sonnet-5",
      accessMode: "approval-required",
      runnerId: LOCAL.id,
      profileId: UNRESTRICTED.id,
    });
  });

  it("starts on the profile's default entry in the harness that entry runs in", () => {
    const inPi = buildProfileEntry(OPENAI_IDENTITY, "gpt-6", {
      harnessId: "pi/pi",
      resolvedHarnessId: "pi/pi",
    });
    const profile = buildModelProfile([buildProfileSection(OPENAI_IDENTITY, [inPi])], {
      defaultEntry: { providerAccountId: CODEX.id, model: "gpt-6", harnessId: "pi/pi" },
    });
    const codex = buildProviderAccount(
      OPENAI_IDENTITY,
      [],
      [{ runnerId: LOCAL.id, harnessId: "pi/pi" }],
    );

    expect(
      computeThreadDefaults(NO_SETTINGS, [codex], [LOCAL], [UNRESTRICTED], LOCAL.id, [profile]),
    ).toMatchObject({ providerAccountId: codex.id, harnessId: "pi/pi", model: "gpt-6" });
  });

  it("starts on the first entry when the profile names no default", () => {
    const profile = { ...MAIN, defaultEntry: null };

    expect(
      computeThreadDefaults(NO_SETTINGS, [CLAUDE, CODEX], [LOCAL], [UNRESTRICTED], LOCAL.id, [
        profile,
      ]),
    ).toMatchObject({ providerAccountId: CLAUDE.id, model: "claude-sonnet-5" });
  });

  it("lets every stored thread setting win over the profile's default entry", () => {
    const stored: SettingsState["user"] = {
      "thread.providerAccountId": CODEX.id,
      "thread.harnessId": OPENAI_IDENTITY.harnessId,
      "thread.model": "gpt-6",
      "thread.accessMode": "full-access",
      "thread.profileId": WORKER.id,
    };

    expect(
      computeThreadDefaults(stored, [CLAUDE, CODEX], [LOCAL], [UNRESTRICTED, WORKER], LOCAL.id, [
        MAIN,
      ]),
    ).toEqual({
      providerAccountId: CODEX.id,
      harnessId: OPENAI_IDENTITY.harnessId,
      model: "gpt-6",
      accessMode: "full-access",
      runnerId: LOCAL.id,
      profileId: WORKER.id,
    });
  });

  it("uses the profile's entry for a stored account that has no stored model", () => {
    const stored: SettingsState["user"] = { "thread.providerAccountId": CODEX.id };

    expect(
      computeThreadDefaults(stored, [CLAUDE, CODEX], [LOCAL], [UNRESTRICTED], LOCAL.id, [MAIN]),
    ).toMatchObject({
      providerAccountId: CODEX.id,
      harnessId: OPENAI_IDENTITY.harnessId,
      model: "gpt-6",
    });
  });

  it("falls back to the profile's default entry when the stored account matches none", () => {
    const stale: SettingsState["user"] = { "thread.providerAccountId": "account-that-went-away" };

    expect(
      computeThreadDefaults(stale, [CLAUDE, CODEX], [LOCAL], [UNRESTRICTED], LOCAL.id, [MAIN])
        .providerAccountId,
    ).toBe(CLAUDE.id);
  });

  it("drops the stored harness and model when the stored account is gone, because they belonged to that account", () => {
    const stale: SettingsState["user"] = {
      "thread.providerAccountId": "account-that-went-away",
      "thread.harnessId": "pi/pi",
      "thread.model": "model-of-the-deleted-account",
    };

    expect(
      computeThreadDefaults(stale, [CLAUDE], [LOCAL], [UNRESTRICTED], LOCAL.id, [MAIN]),
    ).toMatchObject({
      providerAccountId: CLAUDE.id,
      harnessId: "claude-code/claude-code",
      model: "claude-sonnet-5",
    });
  });

  it("keeps a stored model that no profile holds, rather than silently replacing it", () => {
    const stored: SettingsState["user"] = {
      "thread.providerAccountId": CLAUDE.id,
      "thread.model": "claude-haiku-5",
    };

    expect(
      computeThreadDefaults(stored, [CLAUDE], [LOCAL], [UNRESTRICTED], LOCAL.id, [MAIN]).model,
    ).toBe("claude-haiku-5");
  });

  it("falls back to the first ready account, with no model, when the profile has no entry", () => {
    const first = buildProviderAccount(
      ANTHROPIC_IDENTITY,
      [],
      [{ runnerId: LOCAL.id, state: "not-signed-in" }],
    );
    const empty = buildModelProfile([buildProfileSection(ANTHROPIC_IDENTITY, [])]);

    expect(
      computeThreadDefaults(NO_SETTINGS, [first, CODEX], [LOCAL], [UNRESTRICTED], LOCAL.id, [
        empty,
      ]),
    ).toMatchObject({ providerAccountId: CODEX.id, harnessId: null, model: null });
  });

  it("places the thread on the default runner where the account is ready", () => {
    // The local runner is not ready for the account, so the thread goes to the remote one.
    const claude = buildProviderAccount(
      ANTHROPIC_IDENTITY,
      [],
      [{ runnerId: LOCAL.id, state: "not-signed-in" }, { runnerId: REMOTE.id }],
    );

    expect(
      computeThreadDefaults(NO_SETTINGS, [claude], [LOCAL, REMOTE], [UNRESTRICTED], LOCAL.id, [
        MAIN,
      ]).runnerId,
    ).toBe(REMOTE.id);
  });

  it("has no runner when none is ready for the account", () => {
    const claude = buildProviderAccount(
      ANTHROPIC_IDENTITY,
      [],
      [{ runnerId: LOCAL.id, state: "not-signed-in" }],
    );

    expect(
      computeThreadDefaults(NO_SETTINGS, [claude], [LOCAL], [UNRESTRICTED], LOCAL.id, [MAIN])
        .runnerId,
    ).toBeNull();
  });

  it("takes the first profile when none is named unrestricted", () => {
    expect(
      computeThreadDefaults(NO_SETTINGS, [CLAUDE], [LOCAL], [WORKER], LOCAL.id, [MAIN]).profileId,
    ).toBe(WORKER.id);
  });

  it("returns null for every field when there is nothing to pick", () => {
    expect(computeThreadDefaults(NO_SETTINGS, [], [], [], null, [])).toEqual({
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
  const reads = {
    accounts: [CLAUDE],
    runners: [LOCAL],
    profiles: [UNRESTRICTED],
    thisMacRunnerId: LOCAL.id,
    modelProfiles: [MAIN],
    projects: [],
    recent: [],
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
      providerAccountId: CLAUDE.id,
      harnessId: "claude-code/claude-code",
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

describe("a new thread in a project with a Model Profile", () => {
  const AT = "2026-09-05T09:00:00.000Z";
  const buildProject = (id: string, modelProfileId?: string): Project => ({
    id,
    name: id,
    createdAt: AT,
    updatedAt: AT,
    ...(modelProfileId === undefined ? {} : { modelProfileId }),
  });

  /** Holds Codex's GPT, with a Claude entry besides; GPT is the default. */
  const WORK = buildModelProfile(
    [buildProfileSection(OPENAI_IDENTITY, [GPT]), buildProfileSection(ANTHROPIC_IDENTITY, [OPUS])],
    {
      id: "profile-work",
      name: "Work",
      defaultEntry: { providerAccountId: CODEX.id, model: "gpt-6", harnessId: null },
    },
  );
  const OPUS_PICK = {
    providerAccountId: CLAUDE.id,
    harnessId: ANTHROPIC_IDENTITY.harnessId,
    model: "claude-opus-5",
  };
  const SONNET_PICK = { ...OPUS_PICK, model: "claude-sonnet-5" };

  const draftIn = (
    project: Project,
    options: {
      readonly recent?: readonly RecentModel[];
      readonly settingsUser?: SettingsState["user"];
    } = {},
  ) =>
    buildDraftConfig({
      settingsUser: options.settingsUser ?? NO_SETTINGS,
      accounts: [CLAUDE, CODEX],
      runners: [LOCAL],
      profiles: [UNRESTRICTED],
      thisMacRunnerId: LOCAL.id,
      modelProfiles: [MAIN, WORK],
      projects: [project],
      recent: options.recent ?? [],
      projectId: project.id,
      workspaceId: null,
    });

  it("starts on the newest entry the user picked that the profile holds, in the config the spawn sends", () => {
    // Sonnet is newer but only Main holds it; the profile Work holds Opus.
    const config = draftIn(buildProject("p-work", WORK.id), {
      recent: [SONNET_PICK, OPUS_PICK],
    });

    expect(config).toMatchObject({
      providerAccountId: CLAUDE.id,
      harnessId: ANTHROPIC_IDENTITY.harnessId,
      model: "claude-opus-5",
      runnerId: LOCAL.id,
    });
  });

  it("starts on the profile's default entry when the user picked none of its entries", () => {
    const config = draftIn(buildProject("p-work", WORK.id), { recent: [SONNET_PICK] });

    expect(config).toMatchObject({
      providerAccountId: CODEX.id,
      harnessId: OPENAI_IDENTITY.harnessId,
      model: "gpt-6",
    });
  });

  it("starts on the profile's entry before a stored thread setting", () => {
    const config = draftIn(buildProject("p-work", WORK.id), {
      settingsUser: {
        "thread.providerAccountId": CLAUDE.id,
        "thread.harnessId": ANTHROPIC_IDENTITY.harnessId,
        "thread.model": "claude-sonnet-5",
      },
    });

    expect(config).toMatchObject({ providerAccountId: CODEX.id, model: "gpt-6" });
  });

  it("starts on the thread default in a project with no profile", () => {
    const config = draftIn(buildProject("p-plain"), { recent: [OPUS_PICK] });

    expect(config).toMatchObject({ providerAccountId: CLAUDE.id, model: "claude-sonnet-5" });
  });

  it("starts on the thread default in a project whose profile was deleted", () => {
    const config = draftIn(buildProject("p-gone", "profile-deleted"), { recent: [OPUS_PICK] });

    expect(config).toMatchObject({ providerAccountId: CLAUDE.id, model: "claude-sonnet-5" });
  });

  it("starts on the thread default when the project's profile holds no entry", () => {
    const empty = buildModelProfile([buildProfileSection(ANTHROPIC_IDENTITY, [])], {
      id: "profile-empty",
      name: "Empty",
    });

    const config = buildDraftConfig({
      settingsUser: NO_SETTINGS,
      accounts: [CLAUDE],
      runners: [LOCAL],
      profiles: [UNRESTRICTED],
      thisMacRunnerId: LOCAL.id,
      modelProfiles: [MAIN, empty],
      projects: [buildProject("p-empty", empty.id)],
      recent: [],
      projectId: "p-empty",
      workspaceId: null,
    });

    expect(config).toMatchObject({ providerAccountId: CLAUDE.id, model: "claude-sonnet-5" });
  });

  it("starts on the thread default outside any project, whatever was picked", () => {
    const config = buildDraftConfig({
      settingsUser: NO_SETTINGS,
      accounts: [CLAUDE, CODEX],
      runners: [LOCAL],
      profiles: [UNRESTRICTED],
      thisMacRunnerId: LOCAL.id,
      modelProfiles: [MAIN, WORK],
      projects: [buildProject("p-work", WORK.id)],
      recent: [OPUS_PICK],
      projectId: null,
      workspaceId: null,
    });

    expect(config).toMatchObject({ providerAccountId: CLAUDE.id, model: "claude-sonnet-5" });
  });
});
