/**
 * Tests `applyPicks(catalogs,  config,  picks, [pick])`, which applies one
 * selector choice to the picks the composer holds, and `applyPicks`, which
 * applies several in order. The tests check that:
 *
 * - the model options belong to the model that offered them, so anything
 *   that changes the catalog keeps the ones the new model also offers, and
 *   drops the rest;
 * - picking the value that already applies is not a change. The config holds
 *   what applies; the picks hold only what the user changed.
 */
import { describe, expect, it } from "vitest";
import type { ModelOption, ProviderInstance, Runner, Workspace } from "@hercule/contract";
import { BARE, buildInstance, buildSnapshot } from "../providers.testing";
import {
  addWorkspacePicks,
  applyPicks,
  buildModelPicks,
  buildWorkspacePicks,
  type ComposerPick,
} from "./apply-pick";
import { computeEffectiveConfig, type ThreadConfig, type ThreadPicks } from "./config";
import { MOSS, PRIMARY, THREAD_3F1, WEBSHOP } from "./workspaces.testing";

const buildRunner = (overrides: Partial<Runner> & { id: string }): Runner => ({
  ...BARE,
  ...overrides,
});

const LOCAL = buildRunner({ id: "r-local", name: "moss" });
const REMOTE = buildRunner({ id: "r-remote", name: "cove" });

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
/** Offers no effort levels at all. */
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

/** A runner with no Claude snapshot, so no model there offers any option. */
const ISLAND = buildRunner({ id: "r-island", name: "atoll" });

const CLAUDE = buildInstance("claude-code", "Claude Code", [
  buildSnapshot({ runnerId: LOCAL.id, models: [SONNET, OPUS, HAIKU] }),
  buildSnapshot({ runnerId: REMOTE.id, models: [SONNET, OPUS, HAIKU] }),
  buildSnapshot({ runnerId: MOSS.id, models: [SONNET, OPUS, HAIKU] }),
]);

/** Logged in on the remote runner only, so picking this instance changes the runner too. */
const CODEX = buildInstance("codex", "Codex", [
  buildSnapshot({ runnerId: LOCAL.id, auth: { status: "unauthenticated" }, models: [] }),
  buildSnapshot({ runnerId: REMOTE.id, models: [GPT] }),
]);

const CATALOGS: {
  readonly instances: readonly ProviderInstance[];
  readonly runners: readonly Runner[];
  readonly thisMacRunnerId: string | null;
  readonly workspaces: readonly Workspace[];
} = {
  instances: [CLAUDE, CODEX],
  runners: [LOCAL, REMOTE, ISLAND, MOSS],
  thisMacRunnerId: LOCAL.id,
  workspaces: [THREAD_3F1],
};

const TEAM_DEFAULT_ON_LOCAL = { ...GPT, slug: "team-local" };
const TEAM_DEFAULT_ON_REMOTE = { ...GPT, slug: "team-remote" };
const TEAM_DEFAULT_ON_MOSS = { ...GPT, slug: "team-moss" };

/** Logged in on the local, remote and moss runners, each with a different default model. */
const TEAM = buildInstance("team", "Team", [
  buildSnapshot({ runnerId: LOCAL.id, models: [TEAM_DEFAULT_ON_LOCAL] }),
  buildSnapshot({ runnerId: REMOTE.id, models: [TEAM_DEFAULT_ON_REMOTE] }),
  buildSnapshot({ runnerId: MOSS.id, models: [TEAM_DEFAULT_ON_MOSS] }),
]);

/**
 * Returns what the thread runs with while the picks are made: the defaults with
 * the picks applied.
 */
const CONFIG: ThreadConfig = {
  instanceId: CLAUDE.id,
  model: SONNET.slug,
  accessMode: "approval-required",
  runnerId: LOCAL.id,
  profileId: "p-unrestricted",
  options: { effort: "high" },
};

describe("applyPicks with one choice", () => {
  it("keeps an option the new model offers, with its value", () => {
    expect(
      applyPicks(CATALOGS, CONFIG, { options: { effort: "low" } }, [
        { kind: "model", value: OPUS.slug },
      ]),
    ).toEqual({ model: OPUS.slug, options: { effort: "low" } });
  });

  it("drops an option whose value the new model does not offer", () => {
    expect(
      applyPicks(CATALOGS, CONFIG, { model: OPUS.slug, options: { effort: "max" } }, [
        { kind: "model", value: SONNET.slug },
      ]),
    ).toEqual({});
  });

  it("drops an option the new model does not declare, and keeps the ones it does", () => {
    const picks = { options: { effort: "low", thinking: true } };
    expect(applyPicks(CATALOGS, CONFIG, picks, [{ kind: "model", value: HAIKU.slug }])).toEqual({
      model: HAIKU.slug,
    });
    expect(applyPicks(CATALOGS, CONFIG, picks, [{ kind: "model", value: OPUS.slug }])).toEqual({
      model: OPUS.slug,
      options: { effort: "low", thinking: true },
    });
  });

  it("drops a boolean option whose value is not a boolean", () => {
    expect(
      applyPicks(CATALOGS, { ...CONFIG, options: {} }, { options: { thinking: "yes" } }, [
        { kind: "model", value: OPUS.slug },
      ]),
    ).toEqual({ model: OPUS.slug });
  });

  it("carries the stored options of an active thread to a new model that offers them", () => {
    // The thread's stored options are `{ effort: "high" }`. The config only
    // keeps them for its own model, so the picks must hold them for Opus.
    expect(applyPicks(CATALOGS, CONFIG, {}, [{ kind: "model", value: OPUS.slug }])).toEqual({
      model: OPUS.slug,
      options: { effort: "high" },
    });
  });

  it("drops the stored options of an active thread when the new model does not offer them", () => {
    expect(applyPicks(CATALOGS, CONFIG, {}, [{ kind: "model", value: HAIKU.slug }])).toEqual({
      model: HAIKU.slug,
    });
  });

  it("ends with no options for a custom model slug, which has no descriptor", () => {
    expect(
      applyPicks(CATALOGS, CONFIG, { options: { effort: "low" } }, [
        { kind: "model", value: "my-own" },
      ]),
    ).toEqual({ model: "my-own" });
  });

  it("keeps a valid option when the current model is picked again", () => {
    // Picking the thread's own model undoes the model pick. The option picked
    // for the other model is still valid for it, so it stays.
    expect(
      applyPicks(
        CATALOGS,
        CONFIG,
        { model: OPUS.slug, options: { effort: "low", thinking: true } },
        [{ kind: "model", value: SONNET.slug }],
      ),
    ).toEqual({ options: { effort: "low" } });
  });

  it("drops the model pick and an option equal to the thread's own when the current model is picked again", () => {
    // The config is the thread's own, so picking its model again after another
    // one undoes the change: the picks keep neither the model nor an option
    // the thread already runs with.
    expect(
      applyPicks(CATALOGS, CONFIG, { model: OPUS.slug, options: { effort: "high" } }, [
        { kind: "model", value: SONNET.slug },
      ]),
    ).toEqual({});
  });

  it("changes nothing when the current model is picked and no other model was picked before", () => {
    const picks = { options: { effort: "low" } };

    expect(applyPicks(CATALOGS, CONFIG, picks, [{ kind: "model", value: SONNET.slug }])).toEqual(
      picks,
    );
  });

  it("picks only the account, whose default runner and model apply, and drops the options the default model does not offer", () => {
    const picks = applyPicks(
      CATALOGS,
      CONFIG,
      { model: SONNET.slug, options: { effort: "high" } },
      [{ kind: "instanceId", value: CODEX.id }],
    );
    expect(picks).toEqual({ instanceId: CODEX.id });
    expect(computeEffectiveConfig(CATALOGS, CONFIG, picks)).toMatchObject({
      runnerId: REMOTE.id,
      model: GPT.slug,
      options: {},
    });
  });

  it("merges an option into the options already picked", () => {
    expect(
      applyPicks(CATALOGS, CONFIG, { options: { effort: "low" } }, [
        { kind: "option", id: "thinking", value: true },
      ]),
    ).toEqual({ options: { effort: "low", thinking: true } });
  });

  it("overwrites an earlier pick of the same option", () => {
    expect(
      applyPicks(CATALOGS, CONFIG, { options: { effort: "low" } }, [
        { kind: "option", id: "effort", value: "high" },
      ]),
    ).toEqual({ options: { effort: "high" } });
  });

  it("sets the access mode and nothing else", () => {
    expect(
      applyPicks(CATALOGS, CONFIG, { model: SONNET.slug, options: { effort: "high" } }, [
        { kind: "accessMode", value: "full-access" },
      ]),
    ).toEqual({ model: SONNET.slug, options: { effort: "high" }, accessMode: "full-access" });
  });

  it("keeps the options when the runner is picked and the model is offered there", () => {
    expect(
      applyPicks(CATALOGS, CONFIG, { model: OPUS.slug, options: { effort: "max" } }, [
        { kind: "runnerId", value: REMOTE.id },
      ]),
    ).toEqual({ model: OPUS.slug, runnerId: REMOTE.id, options: { effort: "max" } });
  });

  it("drops the options when the picked runner has no snapshot of the instance", () => {
    expect(
      applyPicks(CATALOGS, CONFIG, { model: OPUS.slug, options: { effort: "max" } }, [
        { kind: "runnerId", value: ISLAND.id },
      ]),
    ).toEqual({ model: OPUS.slug, runnerId: ISLAND.id });
  });

  it("keeps a valid option when the thread's own runner is picked again", () => {
    expect(
      applyPicks(CATALOGS, CONFIG, { runnerId: REMOTE.id, options: { effort: "low" } }, [
        { kind: "runnerId", value: LOCAL.id },
      ]),
    ).toEqual({ options: { effort: "low" } });
  });
});

describe("applyPicks", () => {
  it("applies the picks in order, so a model picked after its account is kept", () => {
    const picks = applyPicks(CATALOGS, CONFIG, { options: { effort: "low" } }, [
      { kind: "instanceId", value: CODEX.id },
      { kind: "model", value: "gpt-5-mini" },
    ]);
    expect(picks).toEqual({ instanceId: CODEX.id, model: "gpt-5-mini" });
  });

  it("keeps a model that equals the thread's own when it is picked after another account", () => {
    // The other account offers the same model slug. The slug is picked, not
    // left to that account's default model.
    const other = buildInstance("other", "Other", [
      buildSnapshot({
        runnerId: LOCAL.id,
        models: [
          { ...GPT, slug: "first" },
          { ...GPT, slug: SONNET.slug, isDefault: false },
        ],
      }),
    ]);
    const catalogs = { ...CATALOGS, instances: [CLAUDE, other] };
    expect(
      applyPicks(catalogs, CONFIG, {}, buildModelPicks(CONFIG, other.id, SONNET.slug)),
    ).toEqual({ instanceId: other.id, model: SONNET.slug });
  });

  it("picks a runner that is not the default of the picked account, though it is the thread's own", () => {
    const picks = applyPicks(CATALOGS, CONFIG, { instanceId: CODEX.id }, [
      { kind: "runnerId", value: LOCAL.id },
    ]);
    expect(picks).toEqual({ instanceId: CODEX.id, runnerId: LOCAL.id });
  });
});

describe("applyPicks with an account change", () => {
  const catalogs = { ...CATALOGS, instances: [CLAUDE, CODEX, TEAM] };
  const pickAccount = (instanceId: string): ComposerPick => ({
    kind: "instanceId",
    value: instanceId,
  });

  it("keeps a picked runner when the new account is logged in there, and reads the default model from it", () => {
    const picks = applyPicks(catalogs, CONFIG, { runnerId: REMOTE.id }, [pickAccount(TEAM.id)]);
    expect(picks).toEqual({ instanceId: TEAM.id, runnerId: REMOTE.id });
    expect(computeEffectiveConfig(catalogs, CONFIG, picks)).toMatchObject({
      runnerId: REMOTE.id,
      model: TEAM_DEFAULT_ON_REMOTE.slug,
    });
  });

  it("keeps a picked runner across a cross-account model pick", () => {
    expect(
      applyPicks(catalogs, CONFIG, { runnerId: REMOTE.id }, buildModelPicks(CONFIG, TEAM.id, "x")),
    ).toEqual({ instanceId: TEAM.id, runnerId: REMOTE.id, model: "x" });
  });

  it("drops the model pick of the old account", () => {
    expect(applyPicks(catalogs, CONFIG, { model: OPUS.slug }, [pickAccount(TEAM.id)])).toEqual({
      instanceId: TEAM.id,
    });
  });

  it("drops a picked runner the new account is not logged in on, so its default runner applies", () => {
    const picks = applyPicks(catalogs, CONFIG, { runnerId: MOSS.id }, [pickAccount(CODEX.id)]);
    expect(picks).toEqual({ instanceId: CODEX.id });
    expect(computeEffectiveConfig(catalogs, CONFIG, picks)).toMatchObject({
      runnerId: REMOTE.id,
      model: GPT.slug,
    });
  });

  it("follows the default runner of each account when no runner is picked (A, B, then C)", () => {
    // Codex is on the remote runner only, Team is on both and defaults to the
    // local one. The remote runner that Codex ran on must not stick to Team.
    const toCodex = applyPicks(catalogs, CONFIG, {}, [pickAccount(CODEX.id)]);
    expect(computeEffectiveConfig(catalogs, CONFIG, toCodex).runnerId).toBe(REMOTE.id);
    const toTeam = applyPicks(catalogs, CONFIG, toCodex, [pickAccount(TEAM.id)]);
    expect(toTeam).toEqual({ instanceId: TEAM.id });
    expect(computeEffectiveConfig(catalogs, CONFIG, toTeam)).toMatchObject({
      runnerId: LOCAL.id,
      model: TEAM_DEFAULT_ON_LOCAL.slug,
    });
  });

  it("keeps a runner the user picked through two account changes (pick, B, then C)", () => {
    // The user picked the remote runner on the first account. Codex defaults
    // to the remote runner too, and Team defaults to the local one.
    const picked = applyPicks(catalogs, CONFIG, {}, [{ kind: "runnerId", value: REMOTE.id }]);
    const toCodex = applyPicks(catalogs, CONFIG, picked, [pickAccount(CODEX.id)]);
    const toTeam = applyPicks(catalogs, CONFIG, toCodex, [pickAccount(TEAM.id)]);
    expect(toTeam).toEqual({ instanceId: TEAM.id, runnerId: REMOTE.id });
  });

  it("leaves nothing of an earlier account when the base account is picked again (A, B, then A)", () => {
    const toCodex = applyPicks(catalogs, CONFIG, {}, [pickAccount(CODEX.id)]);
    expect(applyPicks(catalogs, CONFIG, toCodex, [pickAccount(CLAUDE.id)])).toEqual({});
  });

  it("keeps a picked runner when the base account is picked again and is usable there", () => {
    const held: ThreadPicks = { instanceId: TEAM.id, runnerId: REMOTE.id };
    expect(applyPicks(catalogs, CONFIG, held, [pickAccount(CLAUDE.id)])).toEqual({
      runnerId: REMOTE.id,
    });
  });

  it("drops a picked runner when the base account is picked again and is not usable there", () => {
    const config = { ...CONFIG, instanceId: CODEX.id, model: GPT.slug, runnerId: REMOTE.id };
    const held: ThreadPicks = { instanceId: TEAM.id, runnerId: ISLAND.id };
    expect(applyPicks(catalogs, config, held, [pickAccount(CODEX.id)])).toEqual({});
  });

  it("carries no model and no options to an account that has no snapshot anywhere", () => {
    const empty = buildInstance("empty", "Empty", []);
    const withEmpty = { ...catalogs, instances: [CLAUDE, empty] };
    const picks = applyPicks(withEmpty, CONFIG, { options: { effort: "low" } }, [
      pickAccount(empty.id),
    ]);
    expect(picks).toEqual({ instanceId: empty.id });
    expect(computeEffectiveConfig(withEmpty, CONFIG, picks)).toMatchObject({
      model: null,
      runnerId: null,
      options: {},
    });
  });

  it("leaves the runner to the workspace the draft joins, and reads the model from its runner", () => {
    const joined = { kind: "existing", workspaceId: THREAD_3F1.id } as const;
    const config: ThreadConfig = { ...CONFIG, workspace: joined };
    const picks = applyPicks(catalogs, config, {}, [pickAccount(TEAM.id)]);
    expect(picks).toEqual({ instanceId: TEAM.id });
    expect(computeEffectiveConfig(catalogs, config, picks)).toMatchObject({
      runnerId: MOSS.id,
      model: TEAM_DEFAULT_ON_MOSS.slug,
    });
    // Even when the account is not on the workspace's runner at all: the
    // composer's blocker explains it, and no other runner is picked.
    const toCodex = applyPicks(catalogs, config, {}, [pickAccount(CODEX.id)]);
    expect(toCodex).toEqual({ instanceId: CODEX.id });
    expect(computeEffectiveConfig(catalogs, config, toCodex)).toMatchObject({
      runnerId: MOSS.id,
      model: null,
    });
  });

  it("keeps the runner of a joined workspace in the picks when the base account is picked again", () => {
    const joined = { kind: "existing", workspaceId: THREAD_3F1.id } as const;
    const held: ThreadPicks = { workspace: joined, runnerId: MOSS.id, instanceId: CODEX.id };
    expect(applyPicks(catalogs, CONFIG, held, [pickAccount(CLAUDE.id)])).toEqual({
      workspace: joined,
      runnerId: MOSS.id,
    });
  });
});

describe("applyPicks with an existing workspace", () => {
  it("keeps the model options, because the workspace's runner offers the model", () => {
    const joined = { kind: "existing", workspaceId: THREAD_3F1.id } as const;
    const picks = applyPicks(
      CATALOGS,
      CONFIG,
      { model: OPUS.slug, options: { effort: "max" } },
      buildWorkspacePicks(joined, [THREAD_3F1]),
    );
    expect(picks).toEqual({
      model: OPUS.slug,
      workspace: joined,
      runnerId: MOSS.id,
      options: { effort: "max" },
    });
  });

  it("drops an option the runner of the new workspace does not offer, though the runner pick changes nothing", () => {
    // The draft opens at a workspace on the remote runner, while the config's
    // runner is the local one. `effort: max` is offered on the remote runner only.
    const remoteWorkspace = { ...THREAD_3F1, id: "w-remote", runnerId: REMOTE.id };
    const localWorkspace = { ...THREAD_3F1, id: "w-local", runnerId: LOCAL.id };
    const workspaces = [remoteWorkspace, localWorkspace];
    const split = buildInstance("claude-code", "Claude Code", [
      buildSnapshot({ runnerId: LOCAL.id, models: [SONNET] }),
      buildSnapshot({
        runnerId: REMOTE.id,
        models: [{ ...SONNET, options: [buildEffort("low", "high", "max")] }],
      }),
    ]);
    const catalogs = { ...CATALOGS, instances: [split], workspaces };
    const config: ThreadConfig = {
      ...CONFIG,
      instanceId: split.id,
      options: {},
      workspace: { kind: "existing", workspaceId: remoteWorkspace.id },
    };
    const held = applyPicks(catalogs, config, {}, [{ kind: "option", id: "effort", value: "max" }]);
    expect(held).toEqual({ options: { effort: "max" } });

    const local = { kind: "existing", workspaceId: localWorkspace.id } as const;
    expect(applyPicks(catalogs, config, held, buildWorkspacePicks(local, workspaces))).toEqual({
      workspace: local,
    });
    expect(
      applyPicks(catalogs, config, held, [{ kind: "workspace", value: { kind: "none" } }]),
    ).toEqual({
      workspace: { kind: "none" },
    });
  });

  it("keeps an option picked in the same list, a false boolean included", () => {
    expect(
      applyPicks(CATALOGS, { ...CONFIG, options: {} }, {}, [
        { kind: "option", id: "thinking", value: false },
        { kind: "model", value: OPUS.slug },
      ]),
    ).toEqual({ model: OPUS.slug, options: { thinking: false } });
  });

  it("keeps an option the final model offers, though the account's default model does not", () => {
    const other = buildInstance("other", "Other", [
      buildSnapshot({
        runnerId: LOCAL.id,
        models: [
          { ...GPT, slug: "plain" },
          { ...GPT, slug: "reasoner", isDefault: false, options: [buildEffort("low", "high")] },
        ],
      }),
    ]);
    const catalogs = { ...CATALOGS, instances: [CLAUDE, other] };
    const picks = applyPicks(
      catalogs,
      { ...CONFIG, options: {} },
      { options: { effort: "low" } },
      buildModelPicks(CONFIG, other.id, "reasoner"),
    );
    // The account's default runner is the config's runner already, so no
    // runner is picked.
    expect(picks).toEqual({
      instanceId: other.id,
      model: "reasoner",
      options: { effort: "low" },
    });
  });
});

describe("buildModelPicks", () => {
  it("picks only the model on the account the thread runs on, so a picked machine stays", () => {
    // The user switched the draft to Codex, then picked the local machine
    // over Codex's default, the remote one.
    const held: ThreadPicks = { instanceId: CODEX.id, runnerId: LOCAL.id, model: GPT.slug };
    const current = { ...CONFIG, ...held };
    const picks = applyPicks(
      CATALOGS,
      CONFIG,
      held,
      buildModelPicks(current, CODEX.id, "gpt-5-mini"),
    );
    expect(picks).toEqual({ instanceId: CODEX.id, runnerId: LOCAL.id, model: "gpt-5-mini" });
  });

  it("picks the account before the model when the model is another account's", () => {
    expect(buildModelPicks(CONFIG, CODEX.id, GPT.slug)).toEqual([
      { kind: "instanceId", value: CODEX.id },
      { kind: "model", value: GPT.slug },
    ]);
  });
});

describe("buildWorkspacePicks", () => {
  it("picks the machine of a workspace that exists, which never moves", () => {
    const joined = { kind: "existing", workspaceId: THREAD_3F1.id } as const;
    expect(buildWorkspacePicks(joined, [PRIMARY, THREAD_3F1])).toEqual([
      { kind: "workspace", value: joined },
      { kind: "runnerId", value: MOSS.id },
    ]);
  });

  it("leaves the machine alone for a workspace that does not exist yet", () => {
    const fresh = { kind: "primary", resourceId: WEBSHOP.id } as const;
    expect(buildWorkspacePicks(fresh, [PRIMARY])).toEqual([{ kind: "workspace", value: fresh }]);
  });
});

describe("addWorkspacePicks", () => {
  it("adds a joined workspace and its machine, and keeps the model options", () => {
    const held: ThreadPicks = { runnerId: REMOTE.id, options: { effort: "low" } };
    const joined = { kind: "existing", workspaceId: THREAD_3F1.id } as const;
    expect(addWorkspacePicks(held, joined, [THREAD_3F1])).toEqual({
      workspace: joined,
      runnerId: MOSS.id,
      options: { effort: "low" },
    });
  });

  it("keeps the picked machine for a workspace that does not exist yet", () => {
    const held: ThreadPicks = { runnerId: REMOTE.id };
    const fresh = { kind: "none" } as const;
    expect(addWorkspacePicks(held, fresh, [THREAD_3F1])).toEqual({
      workspace: fresh,
      runnerId: REMOTE.id,
    });
  });
});
