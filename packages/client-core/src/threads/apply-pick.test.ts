/**
 * `applyPick(config, picks, pick, catalogs)` folds one selector choice into
 * the picks the composer holds. What matters: the per-model options belong to
 * the model that offered them, so anything that changes the catalog under
 * them clears them, and picking what is already in force is not a change at
 * all - it is the config that says what is in force, not the picks, which
 * hold only what the user has touched.
 */
import { describe, expect, it } from "vitest";
import type { ProviderInstance, Runner } from "@hydra/contract";
import { BARE, instance, snapshot } from "../providers.testing";
import { applyPick } from "./apply-pick";
import type { ThreadConfig } from "./config";

const runner = (overrides: Partial<Runner> & { id: string }): Runner => ({
  ...BARE,
  ...overrides,
});

const LOCAL = runner({ id: "r-local", name: "moss" });
const REMOTE = runner({ id: "r-remote", name: "cove" });

const SONNET = { slug: "claude-sonnet-5", name: "Claude Sonnet 5", isDefault: true, options: [] };
const OPUS = { slug: "claude-opus-5", name: "Claude Opus 5", options: [] };
const GPT = { slug: "gpt-5", name: "GPT-5", isDefault: true, options: [] };

const CLAUDE = instance("claude-code", "Claude Code", [
  snapshot({ runnerId: LOCAL.id, models: [SONNET, OPUS] }),
]);

/** Logged in on the remote machine only, so an instance pick moves the runner too. */
const CODEX = instance("codex", "Codex", [
  snapshot({ runnerId: LOCAL.id, auth: { status: "unauthenticated" }, models: [] }),
  snapshot({ runnerId: REMOTE.id, models: [GPT] }),
]);

const CATALOGS: {
  readonly instances: readonly ProviderInstance[];
  readonly runners: readonly Runner[];
  readonly localRunnerId: string | null;
} = { instances: [CLAUDE, CODEX], runners: [LOCAL, REMOTE], localRunnerId: LOCAL.id };

/** What the thread runs with while the picks below are made: the defaults overlaid with them. */
const CONFIG: ThreadConfig = {
  instanceId: CLAUDE.id,
  model: SONNET.slug,
  accessMode: "approval-required",
  runnerId: LOCAL.id,
  profileId: "p-unrestricted",
  options: { effort: "high" },
};

describe("applyPick", () => {
  it("sets a new model and drops the options the old model carried", () => {
    expect(
      applyPick(
        CONFIG,
        { model: SONNET.slug, options: { effort: "high" } },
        { kind: "model", value: OPUS.slug },
        CATALOGS,
      ),
    ).toEqual({ model: OPUS.slug });
  });

  it("changes nothing when the model already picked is picked again", () => {
    const picks = { model: SONNET.slug, options: { effort: "high" } };

    expect(applyPick(CONFIG, picks, { kind: "model", value: SONNET.slug }, CATALOGS)).toEqual(
      picks,
    );
  });

  it("changes nothing when the model in force is picked again, whatever the picks hold", () => {
    const picks = { options: { effort: "high" } };

    expect(applyPick(CONFIG, picks, { kind: "model", value: SONNET.slug }, CATALOGS)).toEqual(
      picks,
    );
  });

  it("takes the runner and the model from the instance's own defaults, and drops the options", () => {
    expect(
      applyPick(
        CONFIG,
        { model: SONNET.slug, options: { effort: "high" } },
        { kind: "instanceId", value: CODEX.id },
        CATALOGS,
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
        CONFIG,
        { options: { effort: "low" } },
        { kind: "option", id: "thinking", value: true },
        CATALOGS,
      ),
    ).toEqual({ options: { effort: "low", thinking: true } });
  });

  it("overwrites an option picked before under the same id", () => {
    expect(
      applyPick(
        CONFIG,
        { options: { effort: "low" } },
        { kind: "option", id: "effort", value: "high" },
        CATALOGS,
      ),
    ).toEqual({ options: { effort: "high" } });
  });

  it("sets the access mode and nothing else", () => {
    expect(
      applyPick(
        CONFIG,
        { model: SONNET.slug, options: { effort: "high" } },
        { kind: "accessMode", value: "full-access" },
        CATALOGS,
      ),
    ).toEqual({ model: SONNET.slug, options: { effort: "high" }, accessMode: "full-access" });
  });

  it("sets the runner and drops the options, since a catalog is scoped instance x runner", () => {
    expect(
      applyPick(
        CONFIG,
        { model: SONNET.slug, options: { effort: "high" } },
        { kind: "runnerId", value: REMOTE.id },
        CATALOGS,
      ),
    ).toEqual({ model: SONNET.slug, runnerId: REMOTE.id });
  });
});
