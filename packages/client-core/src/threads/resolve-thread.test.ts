/**
 * Tests `resolveThreadConfig(catalogs, thread, picks)`, the one place that
 * decides what a thread runs with. Picks are built with `applyThreadChoice`,
 * the way the composer builds them, so each test is a sequence of choices and
 * the result they resolve to. The tests check that:
 *
 * - a pick the current model, account or runner cannot honour does not apply,
 *   but stays in the picks and applies again when it can;
 * - a draft's runner is the joined workspace's, else the picked one while the
 *   account has the harness there, else the account's own or default one;
 * - a pick of a menu row sets its account, harness and model together;
 * - a thread that has started always runs on its Session's account, runner,
 *   workspace and access mode, and only its model and options resolve from
 *   the picks;
 * - the input to a started thread carries only what changes (`outgoing`).
 */
import { describe, expect, it } from "vitest";
import type { ModelOption, ResolvedModelProfileEntry, Runner } from "@hercule/contract";
import {
  WITH_AGENTS,
  buildModelProfile,
  buildProfileEntry,
  buildProfileSection,
  buildProviderAccount,
  buildSnapshot,
  ANTHROPIC_IDENTITY,
  OPENAI_IDENTITY,
  HARNESSES,
  PROVIDERS,
} from "../providers.testing";
import type { ThreadCatalogs, ThreadConfig, ThreadPicks } from "./config";
import { resolveThreadConfig } from "./resolve-thread";
import { applyThreadChoice, type ThreadChoice } from "./thread-choice";
import {
  MOSS,
  PRIMARY,
  THREAD_3F1,
  WEBSHOP,
  WEBSHOP_PROJECT,
  buildSession,
} from "./workspaces.testing";

const buildRunner = (overrides: Partial<Runner> & { id: string }): Runner => ({
  ...WITH_AGENTS,
  ...overrides,
});

const LOCAL = buildRunner({ id: "r-local", name: "local" });
const REMOTE = buildRunner({ id: "r-remote", name: "cove" });
/** No account has a readiness row for it. */
const ISLAND = buildRunner({ id: "r-island", name: "atoll" });

const buildEffort = (...values: readonly string[]): ModelOption => ({
  id: "effort",
  label: "Reasoning effort",
  kind: "select",
  choices: values.map((value) => ({ value, label: value })),
  default: "low",
});

const THINKING: ModelOption = {
  id: "thinking",
  label: "Thinking",
  kind: "boolean",
  default: false,
};

const CLAUDE_IDENTITY = ANTHROPIC_IDENTITY;
const TEAM_IDENTITY = { ...OPENAI_IDENTITY, id: "account-team", label: "Team" };

const SONNET = buildProfileEntry(CLAUDE_IDENTITY, "claude-sonnet-5", {
  name: "Claude Sonnet 5",
  options: [buildEffort("low", "high")],
});
/** Offers one more effort level than Sonnet, and a thinking switch. */
const OPUS = buildProfileEntry(CLAUDE_IDENTITY, "claude-opus-5", {
  name: "Claude Opus 5",
  options: [buildEffort("low", "high", "max"), THINKING],
});
/** Offers no options at all. */
const HAIKU = buildProfileEntry(CLAUDE_IDENTITY, "claude-haiku-5", { name: "Claude Haiku 5" });
const GPT = buildProfileEntry(OPENAI_IDENTITY, "gpt-5", { name: "GPT-5" });
const GPT_MINI = buildProfileEntry(OPENAI_IDENTITY, "gpt-5-mini", { name: "GPT-5 mini" });
const TEAM_ENTRY = buildProfileEntry(TEAM_IDENTITY, "team-model", { name: "Team model" });
/** Claude's account offering GLM in pi, with the choices pi gives it. */
const GLM_IN_PI = buildProfileEntry(CLAUDE_IDENTITY, "glm-5.3", {
  name: "GLM 5.3",
  harnessId: "pi/pi",
  resolvedHarnessId: "pi/pi",
  options: [buildEffort("low", "high")],
});

const CLAUDE = buildProviderAccount(
  CLAUDE_IDENTITY,
  [],
  [
    { runnerId: LOCAL.id },
    { runnerId: REMOTE.id },
    { runnerId: MOSS.id },
    { runnerId: LOCAL.id, harnessId: "pi/pi" },
  ],
);

/** Ready on the remote runner only; on the local one it is installed but signed out, and moss does not have Codex. */
const CODEX = buildProviderAccount(
  OPENAI_IDENTITY,
  [],
  [
    { runnerId: LOCAL.id, state: "not-signed-in" },
    { runnerId: REMOTE.id },
    { runnerId: MOSS.id, state: "harness-missing" },
  ],
);

/** Ready on the local, remote and moss runners. */
const TEAM = buildProviderAccount(
  TEAM_IDENTITY,
  [],
  [{ runnerId: LOCAL.id }, { runnerId: REMOTE.id }, { runnerId: MOSS.id }],
);

const MAIN = buildModelProfile([
  buildProfileSection(CLAUDE_IDENTITY, [SONNET, OPUS, HAIKU, GLM_IN_PI]),
  buildProfileSection(OPENAI_IDENTITY, [GPT, GPT_MINI]),
  buildProfileSection(TEAM_IDENTITY, [TEAM_ENTRY]),
]);

const CATALOGS: ThreadCatalogs = {
  accounts: [CLAUDE, CODEX, TEAM],
  runners: [LOCAL, REMOTE, ISLAND, MOSS],
  thisMacRunnerId: LOCAL.id,
  providers: PROVIDERS,
  harnesses: HARNESSES,
  modelProfiles: [MAIN],
  workspaces: [PRIMARY, THREAD_3F1],
};

/** What a new draft starts with: Claude's Sonnet on the local runner, no options. */
const BASE: ThreadConfig = {
  providerAccountId: CLAUDE.id,
  harnessId: null,
  model: SONNET.model,
  accessMode: "approval-required",
  runnerId: LOCAL.id,
  profileId: "p-unrestricted",
  options: {},
};

/** Returns the picks after the user made `choices` in order. */
const applyThreadChoices = (...choices: readonly ThreadChoice[]): ThreadPicks =>
  choices.reduce(applyThreadChoice, {} as ThreadPicks);

const resolveDraft = (
  picks: ThreadPicks,
  catalogs: ThreadCatalogs = CATALOGS,
  base: ThreadConfig = BASE,
) => resolveThreadConfig(catalogs, { kind: "draft", config: base }, picks);

/** Returns the choice of a menu row: the entry's account, harness and model. */
const pickEntry = (entry: ResolvedModelProfileEntry): ThreadChoice => ({
  kind: "model",
  providerAccountId: entry.providerAccountId,
  harnessId: entry.resolvedHarnessId,
  model: entry.model,
});
/** Returns a model choice for a model no profile holds, in the account's default harness. */
const pickCustom = (model: string): ThreadChoice => ({
  kind: "model",
  providerAccountId: CLAUDE.id,
  harnessId: CLAUDE.defaultHarnessId,
  model,
});
const pickOption = (id: string, value: string | boolean): ThreadChoice => ({
  kind: "option",
  id,
  value,
});

describe("resolveThreadConfig: a draft's model and options", () => {
  it("runs with its own config when nothing is picked", () => {
    const resolved = resolveDraft({});
    expect(resolved.config).toEqual({ ...BASE, workspace: { kind: "none" } });
    expect(resolved.description).toBe(SONNET);
    expect(resolved.resolvedHarnessId).toBe(CLAUDE.defaultHarnessId);
  });

  it("keeps a picked option across a model change when the new model offers it", () => {
    const resolved = resolveDraft(
      applyThreadChoices(pickOption("effort", "high"), pickEntry(OPUS)),
    );
    expect(resolved.config).toMatchObject({ model: OPUS.model, options: { effort: "high" } });
  });

  it("brings an option back when the model that offers it is picked again (X, then Y, then X)", () => {
    const onOpus = applyThreadChoices(pickEntry(OPUS), pickOption("effort", "max"));
    expect(resolveDraft(onOpus).config.options).toEqual({ effort: "max" });

    // Sonnet has no "max", so the choice is held back, not forgotten.
    const onSonnet = applyThreadChoice(onOpus, pickEntry(SONNET));
    expect(resolveDraft(onSonnet).config.options).toEqual({});

    expect(resolveDraft(applyThreadChoice(onSonnet, pickEntry(OPUS))).config.options).toEqual({
      effort: "max",
    });
  });

  it("keeps the draft's own options the model offers, under the picked ones", () => {
    const base = { ...BASE, options: { effort: "high", bogus: "x" } };
    expect(resolveDraft({}, CATALOGS, base).config.options).toEqual({ effort: "high" });
    expect(
      resolveDraft(applyThreadChoices(pickOption("effort", "low")), CATALOGS, base).config.options,
    ).toEqual({
      effort: "low",
    });
    expect(
      resolveDraft(applyThreadChoices(pickEntry(HAIKU)), CATALOGS, base).config.options,
    ).toEqual({});
  });

  it("applies the latest choice of an option, and drops an earlier one for good", () => {
    const resolved = resolveDraft(
      applyThreadChoices(pickEntry(OPUS), pickOption("effort", "max"), pickOption("effort", "low")),
    );
    expect(resolved.config.options).toEqual({ effort: "low" });
  });

  it("offers an option only to the model that declares it, and only with a valid value", () => {
    const picks = applyThreadChoices(pickOption("effort", "low"), pickOption("thinking", true));
    expect(resolveDraft(applyThreadChoice(picks, pickEntry(OPUS))).config.options).toEqual({
      effort: "low",
      thinking: true,
    });
    expect(resolveDraft(applyThreadChoice(picks, pickEntry(HAIKU))).config.options).toEqual({});
    expect(
      resolveDraft({ options: { thinking: "yes" }, model: OPUS.model }).config.options,
    ).toEqual({});
  });

  it("keeps an explicit false of a boolean option", () => {
    const resolved = resolveDraft(
      applyThreadChoices(pickEntry(OPUS), pickOption("thinking", false)),
    );
    expect(resolved.config.options).toEqual({ thinking: false });
  });

  it("keeps a model no profile holds, which has no entry and so no options", () => {
    const resolved = resolveDraft(
      applyThreadChoices(pickOption("effort", "low"), pickCustom("my-own")),
    );
    expect(resolved.config).toMatchObject({ model: "my-own", options: {} });
    expect(resolved.entry).toBeUndefined();
  });

  it("takes the account, the harness and the model of a pick together", () => {
    const resolved = resolveDraft(applyThreadChoices(pickEntry(GPT)));
    expect(resolved.config).toMatchObject({
      providerAccountId: CODEX.id,
      harnessId: "codex/codex",
      model: GPT.model,
    });
    expect(resolved.entry).toBe(GPT);
  });

  it("runs a pick in the harness the menu showed, not the account's default one", () => {
    const resolved = resolveDraft(applyThreadChoices(pickEntry(GLM_IN_PI)));
    expect(resolved.config).toMatchObject({
      providerAccountId: CLAUDE.id,
      harnessId: "pi/pi",
      model: GLM_IN_PI.model,
    });
    expect(resolved.resolvedHarnessId).toBe("pi/pi");
    expect(resolved.entry).toBe(GLM_IN_PI);
  });

  it("finds the entry of a model that two harnesses offer by the harness picked", () => {
    const inPi = { ...SONNET, harnessId: "pi/pi", resolvedHarnessId: "pi/pi", options: [] };
    const catalogs = {
      ...CATALOGS,
      modelProfiles: [buildModelProfile([buildProfileSection(CLAUDE_IDENTITY, [SONNET, inPi])])],
    };

    expect(resolveDraft(applyThreadChoices(pickEntry(inPi)), catalogs).entry).toBe(inPi);
    expect(resolveDraft(applyThreadChoices(pickEntry(SONNET)), catalogs).entry).toBe(SONNET);
  });

  it("leaves the model open when only another account is picked, since its model belonged to the first account", () => {
    const resolved = resolveDraft({ providerAccountId: CODEX.id });
    expect(resolved.config).toMatchObject({
      providerAccountId: CODEX.id,
      harnessId: null,
      model: null,
      runnerId: REMOTE.id,
    });
    expect(resolved.resolvedHarnessId).toBe("codex/codex");
    expect(resolved.entry).toBeUndefined();
  });

  it("keeps the draft's own model when the account picked is the draft's own", () => {
    const resolved = resolveDraft({ providerAccountId: CLAUDE.id }, CATALOGS, {
      ...BASE,
      model: OPUS.model,
    });
    expect(resolved.config.model).toBe(OPUS.model);
  });

  it("gives an account with no entry anywhere no model, no options and no runner", () => {
    const empty = buildProviderAccount({ ...OPENAI_IDENTITY, id: "account-empty", label: "Empty" });
    const resolved = resolveDraft(
      applyThreadChoices(pickOption("effort", "low")),
      { ...CATALOGS, accounts: [CLAUDE, empty] },
      { ...BASE, providerAccountId: empty.id, model: null, runnerId: null },
    );
    expect(resolved.config).toMatchObject({
      providerAccountId: empty.id,
      model: null,
      runnerId: null,
      options: {},
    });
    expect(resolved).toMatchObject({ runner: undefined, entry: undefined });
  });
});

describe("resolveThreadConfig: a draft's runner", () => {
  it("runs on a picked runner while the account has the harness there, whatever its availability", () => {
    const offline = { ...REMOTE, connectivity: "offline" as const };
    const resolved = resolveDraft(applyThreadChoices({ kind: "runner", runnerId: REMOTE.id }), {
      ...CATALOGS,
      runners: [LOCAL, offline],
    });
    expect(resolved.config.runnerId).toBe(REMOTE.id);
    expect(resolved).toMatchObject({ kind: "draft", runner: offline, diagnosticRunner: undefined });
  });

  it("keeps a picked runner on which the new account has the harness but is signed out, so the composer can say why", () => {
    // Codex is installed on the local runner but not signed in there. The remote one is the base.
    const base = { ...BASE, runnerId: REMOTE.id };
    const resolved = resolveDraft(
      applyThreadChoices({ kind: "runner", runnerId: LOCAL.id }, pickEntry(GPT)),
      CATALOGS,
      base,
    );
    expect(resolved.config).toMatchObject({
      providerAccountId: CODEX.id,
      runnerId: LOCAL.id,
      model: "gpt-5",
    });
  });

  it("keeps a picked runner through a model choice of another account that has the harness there", () => {
    const resolved = resolveDraft(
      applyThreadChoices({ kind: "runner", runnerId: REMOTE.id }, pickEntry(TEAM_ENTRY)),
    );
    expect(resolved.config).toMatchObject({
      providerAccountId: TEAM.id,
      runnerId: REMOTE.id,
      model: TEAM_ENTRY.model,
    });
  });

  it("uses the default runner of an account that lacks the harness on the picked runner, and the pick comes back with an account that has it", () => {
    const picked = applyThreadChoices({ kind: "runner", runnerId: MOSS.id });
    // Codex is not on moss: its default runner applies instead.
    const onCodex = applyThreadChoice(picked, pickEntry(GPT));
    expect(resolveDraft(onCodex).config).toMatchObject({ runnerId: REMOTE.id, model: GPT.model });
    // Team is on moss, so the pick applies again.
    const onTeam = applyThreadChoice(onCodex, pickEntry(TEAM_ENTRY));
    expect(resolveDraft(onTeam).config).toMatchObject({ runnerId: MOSS.id });
    expect(onTeam.runnerId).toBe(MOSS.id);
  });

  it("uses the default runner of the harness picked when the pick changes the draft's own account to another harness", () => {
    // Claude runs in pi on the local runner only; the draft's own runner is the remote one.
    const base = { ...BASE, runnerId: REMOTE.id };
    const resolved = resolveDraft(applyThreadChoices(pickEntry(GLM_IN_PI)), CATALOGS, base);
    expect(resolved.config.runnerId).toBe(LOCAL.id);
  });

  it("follows the default runner of each account while no runner is picked (Claude, Codex, Team)", () => {
    const toCodex = applyThreadChoices(pickEntry(GPT));
    expect(resolveDraft(toCodex).config.runnerId).toBe(REMOTE.id);
    const toTeam = applyThreadChoice(toCodex, pickEntry(TEAM_ENTRY));
    expect(resolveDraft(toTeam).config).toMatchObject({ runnerId: LOCAL.id });
  });

  it("leaves the draft with no runner when its account has no default one, and names a reference runner apart", () => {
    const signedOut = buildProviderAccount(
      ANTHROPIC_IDENTITY,
      [],
      [{ runnerId: LOCAL.id, state: "not-signed-in" }],
    );
    const resolved = resolveDraft(
      {},
      { ...CATALOGS, accounts: [signedOut] },
      { ...BASE, providerAccountId: signedOut.id, model: null, runnerId: null },
    );
    expect(resolved.config.runnerId).toBeNull();
    expect(resolved).toMatchObject({ runner: undefined, diagnosticRunner: LOCAL });
  });

  it("runs on the runner of the existing workspace it joins, whatever is picked", () => {
    const joined = { kind: "existing", workspaceId: THREAD_3F1.id } as const;
    const picks = applyThreadChoices(
      { kind: "runner", runnerId: REMOTE.id },
      { kind: "workspace", workspace: joined },
    );
    const resolved = resolveDraft(picks);
    expect(resolved.config.runnerId).toBe(MOSS.id);
    expect(resolved).toMatchObject({ joined: THREAD_3F1, runner: MOSS });
  });

  it("runs on the picked or default runner again once the draft leaves the joined workspace", () => {
    const joined = { kind: "existing", workspaceId: THREAD_3F1.id } as const;
    const picked = applyThreadChoices(
      { kind: "runner", runnerId: REMOTE.id },
      { kind: "workspace", workspace: joined },
    );
    const left = applyThreadChoice(picked, { kind: "workspace", workspace: { kind: "none" } });
    expect(resolveDraft(left)).toMatchObject({ joined: undefined });
    expect(resolveDraft(left).config.runnerId).toBe(REMOTE.id);

    const noRunnerPicked = applyThreadChoices(
      { kind: "workspace", workspace: joined },
      { kind: "workspace", workspace: { kind: "none" } },
    );
    expect(resolveDraft(noRunnerPicked).config.runnerId).toBe(LOCAL.id);
  });

  it("judges the model menu on the joined workspace's runner, else the picked one, else on none", () => {
    const joined: ThreadChoice = {
      kind: "workspace",
      workspace: { kind: "existing", workspaceId: THREAD_3F1.id },
    };
    const picked: ThreadChoice = { kind: "runner", runnerId: REMOTE.id };

    expect(resolveDraft(applyThreadChoices(picked, joined)).menuRunnerId).toBe(MOSS.id);
    expect(resolveDraft(applyThreadChoices(picked)).menuRunnerId).toBe(REMOTE.id);
    // The draft is placed on its default runner, but the menu must not judge by it.
    expect(resolveDraft({}).menuRunnerId).toBeNull();
  });

  it("lets the joined workspace's runner decide, for an account that lacks the harness there too", () => {
    const joined = { kind: "existing", workspaceId: THREAD_3F1.id } as const;
    const workspace: ThreadChoice = { kind: "workspace", workspace: joined };
    expect(resolveDraft(applyThreadChoices(workspace, pickEntry(TEAM_ENTRY))).config).toMatchObject(
      { runnerId: MOSS.id, model: TEAM_ENTRY.model },
    );
    expect(resolveDraft(applyThreadChoices(workspace, pickEntry(GPT))).config).toMatchObject({
      runnerId: MOSS.id,
      model: GPT.model,
    });
  });
});

describe("resolveThreadConfig: a draft's workspace", () => {
  const withRepo: ThreadCatalogs = {
    ...CATALOGS,
    projects: [WEBSHOP_PROJECT],
    resources: [WEBSHOP],
  };
  const inProject: ThreadConfig = { ...BASE, projectId: WEBSHOP_PROJECT.id, workspace: null };

  it("starts in the default workspace the composer shows when none is picked", () => {
    expect(resolveDraft({}, withRepo, inProject).config.workspace).toEqual({
      kind: "ephemeral",
      checkouts: [{ resourceId: WEBSHOP.id }],
    });
    expect(
      resolveDraft({}, withRepo, { ...inProject, preferredWorkspace: "primary" }).config.workspace,
    ).toEqual({ kind: "primary", resourceId: WEBSHOP.id });
  });

  it("starts in the workspace its address names, and in the picked one over that", () => {
    const named: ThreadConfig = {
      ...inProject,
      workspace: { kind: "existing", workspaceId: PRIMARY.id },
    };
    expect(resolveDraft({}, withRepo, named).config.workspace).toEqual(named.workspace);
    const picked = { kind: "none" } as const;
    expect(
      resolveDraft(applyThreadChoices({ kind: "workspace", workspace: picked }), withRepo, named)
        .config.workspace,
    ).toEqual(picked);
  });

  it("works without a checkout in a draft with no project", () => {
    expect(resolveDraft({}).config.workspace).toEqual({ kind: "none" });
  });
});

describe("resolveThreadConfig: a thread that has started", () => {
  const buildActiveSession = (over: Partial<Parameters<typeof buildSession>[0]> = {}) =>
    buildSession({
      id: "s1",
      providerAccountId: CLAUDE.id,
      runnerId: LOCAL.id,
      workspaceId: THREAD_3F1.id,
      accessMode: "approval-required",
      modelSelection: { model: SONNET.model, options: { effort: "high" } },
      ...over,
    });
  const resolveActive = (picks: ThreadPicks, over?: Parameters<typeof buildActiveSession>[0]) =>
    resolveThreadConfig(CATALOGS, { kind: "active", session: buildActiveSession(over) }, picks);

  it("always runs on the Session's account, runner, workspace and access mode", () => {
    const resolved = resolveActive(
      applyThreadChoices(
        { kind: "runner", runnerId: REMOTE.id },
        { kind: "workspace", workspace: { kind: "none" } },
        { kind: "accessMode", value: "full-access" },
        pickEntry(GPT),
      ),
    );
    expect(resolved.config).toMatchObject({
      providerAccountId: CLAUDE.id,
      runnerId: LOCAL.id,
      workspace: { kind: "existing", workspaceId: THREAD_3F1.id },
      accessMode: "approval-required",
    });
    expect(resolved).toMatchObject({ kind: "active", sessionId: "s1", runner: LOCAL });
  });

  it("runs on the Session's runner even when the account has no readiness row there, and still finds the model's entry", () => {
    const resolved = resolveActive({}, { runnerId: ISLAND.id });
    expect(resolved.config.runnerId).toBe(ISLAND.id);
    expect(resolved.description).toBe(SONNET);
    expect(resolved.resolvedHarnessId).toBe(CLAUDE.defaultHarnessId);
  });

  describe("a model that no profile holds", () => {
    const probed = (slug: string, name: string, probedAt: string, status: "ok" | "error" = "ok") =>
      buildSnapshot({
        harnessId: CLAUDE.defaultHarnessId,
        runnerId: LOCAL.id,
        probedAt,
        auth: status === "ok" ? { status: "ok" } : { status },
        models: [{ slug, name, imageInput: { maxBytes: null }, options: [buildEffort("low")] }],
      });
    const withSnapshots = (...snapshots: ReturnType<typeof probed>[]): ThreadCatalogs => ({
      ...CATALOGS,
      accounts: [{ ...CLAUDE, snapshots }, CODEX, TEAM],
    });
    const resolveWith = (catalogs: ThreadCatalogs, model: string) =>
      resolveThreadConfig(
        catalogs,
        {
          kind: "active",
          session: buildSession({
            id: "s1",
            providerAccountId: CLAUDE.id,
            runnerId: LOCAL.id,
            modelSelection: { model, options: {} },
          }),
        },
        {},
      );

    it("keeps the name, options and image input of the account's newest good probe in the session's harness", () => {
      const catalogs = withSnapshots(
        probed("retired-model", "Retired old", "2026-09-05T09:00:00.000Z"),
        probed("retired-model", "Retired new", "2026-09-05T10:00:00.000Z"),
      );

      const { description, config } = resolveWith(catalogs, "retired-model");

      expect(description).toMatchObject({
        name: "Retired new",
        imageInput: { maxBytes: null },
        options: [expect.objectContaining({ id: "effort" })],
      });
      expect(config.model).toBe("retired-model");
    });

    it("ignores a probe that failed, and a probe in another harness", () => {
      const catalogs = withSnapshots(
        probed("retired-model", "Failed probe", "2026-09-05T11:00:00.000Z", "error"),
        {
          ...probed("retired-model", "Other harness", "2026-09-05T12:00:00.000Z"),
          harnessId: "pi/pi",
        },
      );

      expect(resolveWith(catalogs, "retired-model").description).toBeUndefined();
    });

    it("prefers the profile entry to the probe", () => {
      const catalogs = withSnapshots(
        probed(SONNET.model, "From the probe", "2026-09-05T10:00:00.000Z"),
      );

      expect(resolveWith(catalogs, SONNET.model).description).toBe(SONNET);
    });
  });

  it("changes nothing when nothing is picked", () => {
    const resolved = resolveActive({});
    expect(resolved.config).toMatchObject({ model: SONNET.model, options: { effort: "high" } });
    expect(resolved.outgoing).toEqual({});
  });

  describe("with the Session's model", () => {
    it("overlays only the picked options the model offers on the stored options", () => {
      const resolved = resolveActive(
        applyThreadChoices(
          pickOption("effort", "low"),
          pickOption("thinking", true),
          pickOption("bogus", "x"),
        ),
      );
      expect(resolved.config.options).toEqual({ effort: "low" });
      expect(resolved.outgoing).toEqual({ options: { effort: "low" } });
    });

    it("ignores a picked value the model does not offer, and keeps the stored one", () => {
      const resolved = resolveActive(applyThreadChoices(pickOption("effort", "max")));
      expect(resolved.config.options).toEqual({ effort: "high" });
      expect(resolved.outgoing).toEqual({});
    });

    it("does not send a picked option that equals the stored one", () => {
      expect(resolveActive(applyThreadChoices(pickOption("effort", "high"))).outgoing).toEqual({});
    });

    it("keeps the stored options and applies no pick when no profile holds the model", () => {
      const custom = { modelSelection: { model: "my-own", options: { depth: "3" } } };
      const resolved = resolveActive(applyThreadChoices(pickOption("depth", "5")), custom);
      expect(resolved.config.options).toEqual({ depth: "3" });
      expect(resolved.outgoing).toEqual({});
    });

    it("offers the model's options whatever runner the Session is on", () => {
      const resolved = resolveActive(applyThreadChoices(pickOption("effort", "low")), {
        runnerId: ISLAND.id,
      });
      expect(resolved.config.options).toEqual({ effort: "low" });
      expect(resolved.outgoing).toEqual({ options: { effort: "low" } });
    });

    it("sends no model when the picked model is the Session's own", () => {
      expect(resolveActive(applyThreadChoices(pickEntry(SONNET))).outgoing).toEqual({});
    });
  });

  describe("with another model", () => {
    it("sends the model and every resolved option, because a model change clears the stored ones", () => {
      const resolved = resolveActive(applyThreadChoices(pickEntry(OPUS)));
      expect(resolved.config).toMatchObject({ model: OPUS.model, options: { effort: "high" } });
      expect(resolved.outgoing).toEqual({ model: OPUS.model, options: { effort: "high" } });
    });

    it("merges picked options over the stored ones, and keeps those the model offers", () => {
      const resolved = resolveActive(
        applyThreadChoices(
          pickEntry(OPUS),
          pickOption("effort", "max"),
          pickOption("thinking", true),
        ),
      );
      expect(resolved.outgoing).toEqual({
        model: OPUS.model,
        options: { effort: "max", thinking: true },
      });
    });

    it("drops the stored options the model does not offer, and sends the model alone", () => {
      const resolved = resolveActive(applyThreadChoices(pickEntry(HAIKU)));
      expect(resolved.config.options).toEqual({});
      expect(resolved.outgoing).toEqual({ model: HAIKU.model });
    });

    it("brings the stored options back when the Session's model is picked again", () => {
      const back = applyThreadChoices(pickEntry(HAIKU), pickEntry(SONNET));
      const resolved = resolveActive(back);
      expect(resolved.config.options).toEqual({ effort: "high" });
      expect(resolved.outgoing).toEqual({});
    });

    it("sends a model no profile holds with no options, since it has no entry", () => {
      const resolved = resolveActive(
        applyThreadChoices(pickOption("effort", "low"), pickCustom("my-own")),
      );
      expect(resolved.outgoing).toEqual({ model: "my-own" });
    });
  });
});

describe("resolveThreadConfig: the harness", () => {
  it("reads a draft's entry in the harness its config names", () => {
    const resolved = resolveDraft({}, CATALOGS, {
      ...BASE,
      harnessId: "pi/pi",
      model: GLM_IN_PI.model,
    });

    expect(resolved.config.harnessId).toBe("pi/pi");
    expect(resolved.resolvedHarnessId).toBe("pi/pi");
    expect(resolved.entry?.name).toBe("GLM 5.3");
  });

  it("finds no entry for a model in a harness that no entry offers it in", () => {
    const resolved = resolveDraft({}, CATALOGS, {
      ...BASE,
      harnessId: "pi/pi",
      model: SONNET.model,
    });

    expect(resolved.entry).toBeUndefined();
  });

  it("reads a draft in the account's default harness while its config names none", () => {
    expect(resolveDraft({}).resolvedHarnessId).toBe(ANTHROPIC_IDENTITY.harnessId);
  });

  it("puts a draft in the default harness of an account picked in place of its own", () => {
    const resolved = resolveDraft({ providerAccountId: CODEX.id }, CATALOGS, {
      ...BASE,
      harnessId: "pi/pi",
    });

    expect(resolved.config.harnessId).toBeNull();
    expect(resolved.resolvedHarnessId).toBe(OPENAI_IDENTITY.harnessId);
  });

  it("reads a thread that has started in the harness of its Session", () => {
    const session = buildSession({
      id: "s1",
      providerAccountId: CLAUDE.id,
      harnessId: "pi/pi",
      runnerId: LOCAL.id,
      modelSelection: { model: GLM_IN_PI.model, options: {} },
    });

    const resolved = resolveThreadConfig(CATALOGS, { kind: "active", session }, {});

    expect(resolved.config.harnessId).toBe("pi/pi");
    expect(resolved.resolvedHarnessId).toBe("pi/pi");
    expect(resolved.description?.name).toBe("GLM 5.3");
  });
});
