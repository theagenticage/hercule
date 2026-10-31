/**
 * Tests `resolveThreadConfig(catalogs, thread, picks)`, the one place that
 * decides what a thread runs with. Picks are built with `applyThreadChoice`,
 * the way the composer builds them, so each test is a sequence of choices and
 * the result they resolve to. The tests check that:
 *
 * - a pick the current model, account or runner cannot honour does not apply,
 *   but stays in the picks and applies again when it can;
 * - a draft's runner is the joined workspace's, else the picked one while the
 *   account is installed there, else the account's own or default one;
 * - a thread that has started always runs on its Session's account, runner,
 *   workspace and access mode, and only its model and options resolve from
 *   the picks;
 * - the input to a started thread carries only what changes (`outgoing`).
 */
import { describe, expect, it } from "vitest";
import type { ModelOption, Runner } from "@hercule/contract";
import {
  WITH_AGENTS,
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
/** Has no snapshot of any account. */
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

const SONNET = {
  slug: "claude-sonnet-5",
  name: "Claude Sonnet 5",
  imageInput: { maxBytes: null },
  isDefault: true,
  options: [buildEffort("low", "high")],
};
/** Offers one more effort level than Sonnet, and a thinking switch. */
const OPUS = {
  slug: "claude-opus-5",
  name: "Claude Opus 5",
  imageInput: { maxBytes: null },
  options: [buildEffort("low", "high", "max"), THINKING],
};
/** Offers no options at all. */
const HAIKU = {
  slug: "claude-haiku-5",
  name: "Claude Haiku 5",
  imageInput: { maxBytes: null },
  options: [],
};
const GPT = {
  slug: "gpt-5",
  name: "GPT-5",
  imageInput: { maxBytes: null },
  isDefault: true,
  options: [],
};

const CLAUDE = buildProviderAccount(ANTHROPIC_IDENTITY, [
  buildSnapshot({ runnerId: LOCAL.id, models: [SONNET, OPUS, HAIKU] }),
  buildSnapshot({ runnerId: REMOTE.id, models: [SONNET, OPUS, HAIKU] }),
  buildSnapshot({ runnerId: MOSS.id, models: [SONNET, OPUS, HAIKU] }),
]);

/** Signed in on the remote runner only; on the local one it is installed but signed out. */
const CODEX = buildProviderAccount(OPENAI_IDENTITY, [
  buildSnapshot({ runnerId: LOCAL.id, auth: { status: "unauthenticated" }, models: [] }),
  buildSnapshot({
    runnerId: REMOTE.id,
    models: [GPT, { ...GPT, slug: "gpt-5-mini", isDefault: false }],
  }),
]);

/** Signed in on the local, remote and moss runners, each with another default model. */
const TEAM = buildProviderAccount({ ...OPENAI_IDENTITY, id: "account-team", label: "Team" }, [
  buildSnapshot({ runnerId: LOCAL.id, models: [{ ...GPT, slug: "team-local" }] }),
  buildSnapshot({ runnerId: REMOTE.id, models: [{ ...GPT, slug: "team-remote" }] }),
  buildSnapshot({ runnerId: MOSS.id, models: [{ ...GPT, slug: "team-moss" }] }),
]);

const CATALOGS: ThreadCatalogs = {
  accounts: [CLAUDE, CODEX, TEAM],
  runners: [LOCAL, REMOTE, ISLAND, MOSS],
  thisMacRunnerId: LOCAL.id,
  providers: PROVIDERS,
  harnesses: HARNESSES,
  workspaces: [PRIMARY, THREAD_3F1],
};

/** What a new draft starts with: Claude's default model on the local runner, no options. */
const BASE: ThreadConfig = {
  providerAccountId: CLAUDE.id,
  harnessId: null,
  model: SONNET.slug,
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

const pickModel = (model: string, providerAccountId: string = CLAUDE.id): ThreadChoice => ({
  kind: "model",
  providerAccountId,
  model,
});
const pickOption = (id: string, value: string | boolean): ThreadChoice => ({
  kind: "option",
  id,
  value,
});

describe("resolveThreadConfig: a draft's model and options", () => {
  it("runs with its own config when nothing is picked", () => {
    expect(resolveDraft({}).config).toEqual({ ...BASE, workspace: { kind: "none" } });
  });

  it("keeps a picked option across a model change when the new model offers it", () => {
    const resolved = resolveDraft(
      applyThreadChoices(pickOption("effort", "high"), pickModel(OPUS.slug)),
    );
    expect(resolved.config).toMatchObject({ model: OPUS.slug, options: { effort: "high" } });
  });

  it("brings an option back when the model that offers it is picked again (X, then Y, then X)", () => {
    const onOpus = applyThreadChoices(pickModel(OPUS.slug), pickOption("effort", "max"));
    expect(resolveDraft(onOpus).config.options).toEqual({ effort: "max" });

    // Sonnet has no "max", so the choice is held back, not forgotten.
    const onSonnet = applyThreadChoice(onOpus, pickModel(SONNET.slug));
    expect(resolveDraft(onSonnet).config.options).toEqual({});

    expect(resolveDraft(applyThreadChoice(onSonnet, pickModel(OPUS.slug))).config.options).toEqual({
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
      resolveDraft(applyThreadChoices(pickModel(HAIKU.slug)), CATALOGS, base).config.options,
    ).toEqual({});
  });

  it("applies the latest choice of an option, and drops an earlier one for good", () => {
    const resolved = resolveDraft(
      applyThreadChoices(
        pickModel(OPUS.slug),
        pickOption("effort", "max"),
        pickOption("effort", "low"),
      ),
    );
    expect(resolved.config.options).toEqual({ effort: "low" });
  });

  it("offers an option only to the model that declares it, and only with a valid value", () => {
    const picks = applyThreadChoices(pickOption("effort", "low"), pickOption("thinking", true));
    expect(resolveDraft(applyThreadChoice(picks, pickModel(OPUS.slug))).config.options).toEqual({
      effort: "low",
      thinking: true,
    });
    expect(resolveDraft(applyThreadChoice(picks, pickModel(HAIKU.slug))).config.options).toEqual(
      {},
    );
    expect(resolveDraft({ options: { thinking: "yes" }, model: OPUS.slug }).config.options).toEqual(
      {},
    );
  });

  it("keeps an explicit false of a boolean option", () => {
    const resolved = resolveDraft(
      applyThreadChoices(pickModel(OPUS.slug), pickOption("thinking", false)),
    );
    expect(resolved.config.options).toEqual({ thinking: false });
  });

  it("keeps a custom model slug, which has no descriptor and so no options", () => {
    const resolved = resolveDraft(
      applyThreadChoices(pickOption("effort", "low"), pickModel("my-own")),
    );
    expect(resolved.config).toMatchObject({ model: "my-own", options: {} });
    expect(resolved.descriptor).toBeUndefined();
  });

  it("uses the default model of a picked account, read from the runner it runs on", () => {
    const resolved = resolveDraft(
      applyThreadChoices({ kind: "account", providerAccountId: TEAM.id }),
    );
    expect(resolved.config).toMatchObject({
      providerAccountId: TEAM.id,
      runnerId: LOCAL.id,
      model: "team-local",
    });
    const onRemote = resolveDraft(
      applyThreadChoices(
        { kind: "account", providerAccountId: TEAM.id },
        { kind: "runner", runnerId: REMOTE.id },
      ),
    );
    expect(onRemote.config).toMatchObject({ runnerId: REMOTE.id, model: "team-remote" });
  });

  it("drops the model pick when only the account is picked afterwards", () => {
    const resolved = resolveDraft(
      applyThreadChoices(pickModel(OPUS.slug), { kind: "account", providerAccountId: CODEX.id }),
    );
    expect(resolved.config).toMatchObject({
      providerAccountId: CODEX.id,
      runnerId: REMOTE.id,
      model: GPT.slug,
    });
  });

  it("keeps the draft's own model when the account picked is the draft's own", () => {
    const resolved = resolveDraft(
      applyThreadChoices({ kind: "account", providerAccountId: CLAUDE.id }),
      CATALOGS,
      {
        ...BASE,
        model: OPUS.slug,
      },
    );
    expect(resolved.config.model).toBe(OPUS.slug);
  });

  it("gives an account with no snapshot anywhere no model, no options and no runner", () => {
    const empty = buildProviderAccount({ ...OPENAI_IDENTITY, id: "account-empty", label: "Empty" });
    const resolved = resolveDraft(
      applyThreadChoices(pickOption("effort", "low"), {
        kind: "account",
        providerAccountId: empty.id,
      }),
      { ...CATALOGS, accounts: [CLAUDE, empty] },
    );
    expect(resolved.config).toMatchObject({
      providerAccountId: empty.id,
      model: null,
      runnerId: null,
      options: {},
    });
    expect(resolved).toMatchObject({
      runner: undefined,
      snapshot: undefined,
      descriptor: undefined,
    });
  });
});

describe("resolveThreadConfig: a draft's runner", () => {
  it("runs on a picked runner while the account is installed there, whatever its availability", () => {
    const offline = { ...REMOTE, connectivity: "offline" as const };
    const resolved = resolveDraft(applyThreadChoices({ kind: "runner", runnerId: REMOTE.id }), {
      ...CATALOGS,
      runners: [LOCAL, offline],
    });
    expect(resolved.config.runnerId).toBe(REMOTE.id);
    expect(resolved).toMatchObject({ kind: "draft", runner: offline, diagnosticRunner: undefined });
  });

  it("keeps a picked runner on which the new account is installed but signed out, and reads its models from a runner where it is signed in", () => {
    // Codex has a signed-out snapshot on the local runner. The remote one is picked first.
    const base = { ...BASE, runnerId: REMOTE.id };
    const resolved = resolveDraft(
      applyThreadChoices(
        { kind: "runner", runnerId: LOCAL.id },
        { kind: "account", providerAccountId: CODEX.id },
      ),
      CATALOGS,
      base,
    );
    expect(resolved.config).toMatchObject({
      providerAccountId: CODEX.id,
      runnerId: LOCAL.id,
      model: "gpt-5",
    });
    expect(resolved.snapshot?.auth.status).toBe("unauthenticated");
  });

  it("keeps a picked runner through a model choice of another account installed there", () => {
    const resolved = resolveDraft(
      applyThreadChoices({ kind: "runner", runnerId: REMOTE.id }, pickModel("x", TEAM.id)),
    );
    expect(resolved.config).toMatchObject({
      providerAccountId: TEAM.id,
      runnerId: REMOTE.id,
      model: "x",
    });
  });

  it("uses the default runner of an account not installed on the picked runner, and the pick comes back with an account that is", () => {
    const picked = applyThreadChoices({ kind: "runner", runnerId: MOSS.id });
    // Codex has no snapshot on moss: its default runner applies instead.
    const onCodex = applyThreadChoice(picked, { kind: "account", providerAccountId: CODEX.id });
    expect(resolveDraft(onCodex).config).toMatchObject({ runnerId: REMOTE.id, model: GPT.slug });
    // Team is installed on moss, so the pick applies again.
    const onTeam = applyThreadChoice(onCodex, { kind: "account", providerAccountId: TEAM.id });
    expect(resolveDraft(onTeam).config).toMatchObject({ runnerId: MOSS.id, model: "team-moss" });
    expect(onTeam.runnerId).toBe(MOSS.id);
  });

  it("follows the default runner of each account while no runner is picked (Claude, Codex, Team)", () => {
    const toCodex = applyThreadChoices({ kind: "account", providerAccountId: CODEX.id });
    expect(resolveDraft(toCodex).config.runnerId).toBe(REMOTE.id);
    const toTeam = applyThreadChoice(toCodex, { kind: "account", providerAccountId: TEAM.id });
    expect(resolveDraft(toTeam).config).toMatchObject({ runnerId: LOCAL.id, model: "team-local" });
  });

  it("leaves the draft with no runner when its account has no default one, and names a reference runner apart", () => {
    const signedOut = buildProviderAccount(ANTHROPIC_IDENTITY, [
      buildSnapshot({ runnerId: LOCAL.id, auth: { status: "unauthenticated" }, models: [] }),
    ]);
    const resolved = resolveDraft(
      {},
      { ...CATALOGS, accounts: [signedOut] },
      { ...BASE, providerAccountId: signedOut.id, model: null, runnerId: null },
    );
    expect(resolved.config.runnerId).toBeNull();
    expect(resolved).toMatchObject({ runner: undefined, diagnosticRunner: LOCAL });
    expect(resolved.snapshot?.auth.status).toBe("unauthenticated");
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

  it("reads the model from the joined workspace's runner, and from another runner's list when the account has none there", () => {
    const joined = { kind: "existing", workspaceId: THREAD_3F1.id } as const;
    const workspace: ThreadChoice = { kind: "workspace", workspace: joined };
    expect(
      resolveDraft(applyThreadChoices(workspace, { kind: "account", providerAccountId: TEAM.id }))
        .config,
    ).toMatchObject({ runnerId: MOSS.id, model: "team-moss" });
    expect(
      resolveDraft(applyThreadChoices(workspace, { kind: "account", providerAccountId: CODEX.id }))
        .config,
    ).toMatchObject({ runnerId: MOSS.id, model: "gpt-5" });
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
      modelSelection: { model: SONNET.slug, options: { effort: "high" } },
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
        { kind: "account", providerAccountId: CODEX.id },
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

  it("runs on the Session's runner even when the catalogs do not list the account there, and reads the model's descriptor from another runner's list", () => {
    const resolved = resolveActive({}, { runnerId: ISLAND.id });
    expect(resolved.config.runnerId).toBe(ISLAND.id);
    expect(resolved.snapshot).toBeUndefined();
    expect(resolved.descriptor?.slug).toBe(SONNET.slug);
  });

  it("changes nothing when nothing is picked", () => {
    const resolved = resolveActive({});
    expect(resolved.config).toMatchObject({ model: SONNET.slug, options: { effort: "high" } });
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

    it("keeps the stored options and applies no pick when the model has no descriptor", () => {
      const custom = { modelSelection: { model: "my-own", options: { depth: "3" } } };
      const resolved = resolveActive(applyThreadChoices(pickOption("depth", "5")), custom);
      expect(resolved.config.options).toEqual({ depth: "3" });
      expect(resolved.outgoing).toEqual({});
    });

    it("offers the options of another runner's list when the account has no snapshot on the Session's runner", () => {
      const resolved = resolveActive(applyThreadChoices(pickOption("effort", "low")), {
        runnerId: ISLAND.id,
      });
      expect(resolved.config.options).toEqual({ effort: "low" });
      expect(resolved.outgoing).toEqual({ options: { effort: "low" } });
    });

    it("sends no model when the picked model is the Session's own", () => {
      expect(resolveActive(applyThreadChoices(pickModel(SONNET.slug))).outgoing).toEqual({});
    });
  });

  describe("with another model", () => {
    it("sends the model and every resolved option, because a model change clears the stored ones", () => {
      const resolved = resolveActive(applyThreadChoices(pickModel(OPUS.slug)));
      expect(resolved.config).toMatchObject({ model: OPUS.slug, options: { effort: "high" } });
      expect(resolved.outgoing).toEqual({ model: OPUS.slug, options: { effort: "high" } });
    });

    it("merges picked options over the stored ones, and keeps those the model offers", () => {
      const resolved = resolveActive(
        applyThreadChoices(
          pickModel(OPUS.slug),
          pickOption("effort", "max"),
          pickOption("thinking", true),
        ),
      );
      expect(resolved.outgoing).toEqual({
        model: OPUS.slug,
        options: { effort: "max", thinking: true },
      });
    });

    it("drops the stored options the model does not offer, and sends the model alone", () => {
      const resolved = resolveActive(applyThreadChoices(pickModel(HAIKU.slug)));
      expect(resolved.config.options).toEqual({});
      expect(resolved.outgoing).toEqual({ model: HAIKU.slug });
    });

    it("brings the stored options back when the Session's model is picked again", () => {
      const back = applyThreadChoices(pickModel(HAIKU.slug), pickModel(SONNET.slug));
      const resolved = resolveActive(back);
      expect(resolved.config.options).toEqual({ effort: "high" });
      expect(resolved.outgoing).toEqual({});
    });

    it("sends a custom model with no options, since it has no descriptor", () => {
      const resolved = resolveActive(
        applyThreadChoices(pickOption("effort", "low"), pickModel("my-own")),
      );
      expect(resolved.outgoing).toEqual({ model: "my-own" });
    });
  });
});

describe("resolveThreadConfig: the harness", () => {
  const GLM = { slug: "glm-5.3", name: "GLM 5.3", imageInput: null, options: [] };
  /** Claude's account, with one more snapshot: its models in pi, on the local runner. */
  const CLAUDE_IN_PI = {
    ...CLAUDE,
    snapshots: [
      ...CLAUDE.snapshots,
      buildSnapshot({ runnerId: LOCAL.id, harnessId: "pi/pi", models: [GLM] }),
    ],
  };
  const catalogs = { ...CATALOGS, accounts: [CLAUDE_IN_PI, CODEX, TEAM] };

  it("reads a draft's snapshot in the harness its config names", () => {
    const resolved = resolveDraft({}, catalogs, { ...BASE, harnessId: "pi/pi", model: GLM.slug });

    expect(resolved.config.harnessId).toBe("pi/pi");
    expect(resolved.snapshot?.harnessId).toBe("pi/pi");
    expect(resolved.descriptor?.name).toBe("GLM 5.3");
  });

  it("reads a draft in the account's default harness while its config names none", () => {
    expect(resolveDraft({}, catalogs).snapshot?.harnessId).toBe(ANTHROPIC_IDENTITY.harnessId);
  });

  it("puts a draft in the default harness of an account picked in place of its own", () => {
    const resolved = resolveDraft(
      applyThreadChoices({ kind: "account", providerAccountId: CODEX.id }),
      catalogs,
      { ...BASE, harnessId: "pi/pi" },
    );

    expect(resolved.config.harnessId).toBeNull();
    expect(resolved.snapshot?.harnessId).toBe(OPENAI_IDENTITY.harnessId);
  });

  it("reads a thread that has started in the harness of its Session", () => {
    const session = buildSession({
      id: "s1",
      providerAccountId: CLAUDE.id,
      harnessId: "pi/pi",
      runnerId: LOCAL.id,
      modelSelection: { model: GLM.slug, options: {} },
    });

    const resolved = resolveThreadConfig(catalogs, { kind: "active", session }, {});

    expect(resolved.config.harnessId).toBe("pi/pi");
    expect(resolved.descriptor?.name).toBe("GLM 5.3");
  });
});
