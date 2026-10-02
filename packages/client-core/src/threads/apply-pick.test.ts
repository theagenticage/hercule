/**
 * Tests `applyPick(catalogs, config, picks, pick)`, which applies one
 * selector choice to the picks the composer holds, and `applyPicks`, which
 * applies several in order. The tests check that:
 *
 * - the model options belong to the model that offered them, so anything
 *   that changes the catalog clears them;
 * - picking the value that already applies is not a change. The config holds
 *   what applies; the picks hold only what the user changed.
 */
import { describe, expect, it } from "vitest";
import type { ProviderInstance, Runner } from "@hercule/contract";
import { BARE, buildInstance, buildSnapshot } from "../providers.testing";
import {
  addWorkspacePicks,
  applyPick,
  applyPicks,
  buildModelPicks,
  buildWorkspacePicks,
} from "./apply-pick";
import type { ThreadConfig, ThreadPicks } from "./config";
import { MOSS, PRIMARY, THREAD_3F1, WEBSHOP } from "./workspaces.testing";

const buildRunner = (overrides: Partial<Runner> & { id: string }): Runner => ({
  ...BARE,
  ...overrides,
});

const LOCAL = buildRunner({ id: "r-local", name: "moss" });
const REMOTE = buildRunner({ id: "r-remote", name: "cove" });

const SONNET = { slug: "claude-sonnet-5", name: "Claude Sonnet 5", isDefault: true, options: [] };
const OPUS = { slug: "claude-opus-5", name: "Claude Opus 5", options: [] };
const GPT = { slug: "gpt-5", name: "GPT-5", isDefault: true, options: [] };

const CLAUDE = buildInstance("claude-code", "Claude Code", [
  buildSnapshot({ runnerId: LOCAL.id, models: [SONNET, OPUS] }),
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
} = { instances: [CLAUDE, CODEX], runners: [LOCAL, REMOTE], thisMacRunnerId: LOCAL.id };

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

describe("applyPick", () => {
  it("sets a new model and drops the old model's options", () => {
    expect(
      applyPick(
        CATALOGS,
        CONFIG,
        { model: SONNET.slug, options: { effort: "high" } },
        { kind: "model", value: OPUS.slug },
      ),
    ).toEqual({ model: OPUS.slug });
  });

  it("drops the model pick and its options when the current model is picked again", () => {
    // The config is the thread's own, so picking its model again after another
    // one undoes the change: the picks keep neither the model nor the options
    // picked for the other model.
    expect(
      applyPick(
        CATALOGS,
        CONFIG,
        { model: OPUS.slug, options: { effort: "high" } },
        { kind: "model", value: SONNET.slug },
      ),
    ).toEqual({});
  });

  it("changes nothing when the current model is picked and no other model was picked before", () => {
    const picks = { options: { effort: "high" } };

    expect(applyPick(CATALOGS, CONFIG, picks, { kind: "model", value: SONNET.slug })).toEqual(
      picks,
    );
  });

  it("takes the runner and model from the instance's defaults, and drops the options", () => {
    expect(
      applyPick(
        CATALOGS,
        CONFIG,
        { model: SONNET.slug, options: { effort: "high" } },
        { kind: "instanceId", value: CODEX.id },
      ),
    ).toEqual({
      instanceId: CODEX.id,
      runnerId: REMOTE.id,
      model: GPT.slug,
    });
  });

  it("merges an option into the options already picked", () => {
    expect(
      applyPick(
        CATALOGS,
        CONFIG,
        { options: { effort: "low" } },
        { kind: "option", id: "thinking", value: true },
      ),
    ).toEqual({ options: { effort: "low", thinking: true } });
  });

  it("overwrites an earlier pick of the same option", () => {
    expect(
      applyPick(
        CATALOGS,
        CONFIG,
        { options: { effort: "low" } },
        { kind: "option", id: "effort", value: "high" },
      ),
    ).toEqual({ options: { effort: "high" } });
  });

  it("sets the access mode and nothing else", () => {
    expect(
      applyPick(
        CATALOGS,
        CONFIG,
        { model: SONNET.slug, options: { effort: "high" } },
        { kind: "accessMode", value: "full-access" },
      ),
    ).toEqual({ model: SONNET.slug, options: { effort: "high" }, accessMode: "full-access" });
  });

  it("sets the runner and drops the options, because a catalog belongs to one instance on one runner", () => {
    expect(
      applyPick(
        CATALOGS,
        CONFIG,
        { model: SONNET.slug, options: { effort: "high" } },
        { kind: "runnerId", value: REMOTE.id },
      ),
    ).toEqual({ model: SONNET.slug, runnerId: REMOTE.id });
  });
});

describe("applyPicks", () => {
  it("applies the picks in order, so a model picked after its account is kept", () => {
    const picks = applyPicks(CATALOGS, CONFIG, { options: { effort: "low" } }, [
      { kind: "instanceId", value: CODEX.id },
      { kind: "model", value: "gpt-5-mini" },
    ]);
    expect(picks).toEqual({ instanceId: CODEX.id, runnerId: REMOTE.id, model: "gpt-5-mini" });
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
