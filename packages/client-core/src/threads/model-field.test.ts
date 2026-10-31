/**
 * Tests `buildThreadModelField(catalogs, current)`, the model field of
 * Settings > Threads: the entries of the open Model Profile, as the composer's
 * model menu lists them, with the stored default selected and kept on the list
 * when no profile holds it.
 */
import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_IDENTITY,
  HARNESSES,
  OPENAI_IDENTITY,
  PROVIDERS,
  buildModelProfile,
  buildProfileEntry,
  buildProfileSection,
  buildProviderAccount,
} from "../providers.testing";
import type { ThreadCatalogs } from "./config";
import { buildThreadModelField } from "./model-field";

const CLAUDE = buildProviderAccount(ANTHROPIC_IDENTITY);
const CODEX = buildProviderAccount(OPENAI_IDENTITY);

const SONNET = buildProfileEntry(ANTHROPIC_IDENTITY, "claude-sonnet-5", { name: "Sonnet 5" });
const OPUS = buildProfileEntry(ANTHROPIC_IDENTITY, "claude-opus-5", { name: "Opus 5" });
const GPT = buildProfileEntry(OPENAI_IDENTITY, "gpt-6", { name: "GPT-6" });
const GPT_IN_PI = buildProfileEntry(OPENAI_IDENTITY, "gpt-6", {
  name: "GPT-6",
  harnessId: "pi/pi",
  resolvedHarnessId: "pi/pi",
});

const MAIN = buildModelProfile([
  buildProfileSection(ANTHROPIC_IDENTITY, [SONNET, OPUS]),
  buildProfileSection(OPENAI_IDENTITY, [GPT, GPT_IN_PI]),
]);

const buildCatalogs = (modelProfiles: ThreadCatalogs["modelProfiles"]): ThreadCatalogs => ({
  accounts: [CLAUDE, CODEX],
  runners: [],
  thisMacRunnerId: null,
  providers: PROVIDERS,
  harnesses: HARNESSES,
  modelProfiles,
});

const STORED = { providerAccountId: CLAUDE.id, harnessId: null, model: "claude-opus-5" };

describe("buildThreadModelField", () => {
  it("lists every entry of the open profile with its account and harness, and selects the stored one", () => {
    const field = buildThreadModelField(buildCatalogs([MAIN]), STORED);

    expect(field.dimmed).toBeNull();
    expect(
      field.options.map((option) => [option.label, option.harnessId, option.model, option.missing]),
    ).toEqual([
      ["Anthropic · Sonnet 5", "claude-code/claude-code", "claude-sonnet-5", false],
      ["Anthropic · Opus 5", "claude-code/claude-code", "claude-opus-5", false],
      ["OpenAI · GPT-6", "codex/codex", "gpt-6", false],
      ["OpenAI · GPT-6 · in pi", "pi/pi", "gpt-6", false],
    ]);
    expect(field.options.find((option) => option.key === field.selectedKey)?.label).toBe(
      "Anthropic · Opus 5",
    );
  });

  it("gives one model offered in two harnesses two keys", () => {
    const field = buildThreadModelField(buildCatalogs([MAIN]), STORED);

    expect(new Set(field.options.map((option) => option.key)).size).toBe(4);
  });

  it("selects the entry of the stored harness, and reads a stored null as the account's default harness", () => {
    const inPi = buildThreadModelField(buildCatalogs([MAIN]), {
      providerAccountId: CODEX.id,
      harnessId: "pi/pi",
      model: "gpt-6",
    });
    const byDefault = buildThreadModelField(buildCatalogs([MAIN]), {
      providerAccountId: CODEX.id,
      harnessId: null,
      model: "gpt-6",
    });

    expect(inPi.options.find((option) => option.key === inPi.selectedKey)?.harnessId).toBe("pi/pi");
    expect(
      byDefault.options.find((option) => option.key === byDefault.selectedKey)?.harnessId,
    ).toBe("codex/codex");
  });

  it("keeps a stored default that no profile holds on the list, marked as missing", () => {
    const field = buildThreadModelField(buildCatalogs([MAIN]), {
      ...STORED,
      model: "claude-haiku-5",
    });

    expect(field.options.at(-1)).toMatchObject({
      label: "Anthropic · claude-haiku-5",
      harnessId: "claude-code/claude-code",
      model: "claude-haiku-5",
      missing: true,
    });
    expect(field.selectedKey).toBe(field.options.at(-1)!.key);
  });

  it("carries the reason an entry cannot run", () => {
    const broken = {
      ...SONNET,
      problem: { reason: "token-expired" as const, message: "controller words" },
    };
    const profile = buildModelProfile([buildProfileSection(ANTHROPIC_IDENTITY, [broken, OPUS])]);

    const field = buildThreadModelField(buildCatalogs([profile]), STORED);

    expect(field.options.map((option) => option.problem)).toEqual(["expired", null]);
  });

  it("selects nothing when no model is stored", () => {
    const field = buildThreadModelField(buildCatalogs([MAIN]), { ...STORED, model: null });

    expect(field.selectedKey).toBeNull();
    expect(field.options).toHaveLength(4);
  });

  it("is dimmed, with nothing to choose, when the profile holds no entry", () => {
    const empty = buildModelProfile([buildProfileSection(ANTHROPIC_IDENTITY, [])]);

    expect(buildThreadModelField(buildCatalogs([empty]), { ...STORED, model: null })).toEqual({
      dimmed: "no models in your profile yet",
      options: [],
      selectedKey: null,
    });
    expect(buildThreadModelField(buildCatalogs([]), { ...STORED, model: null }).dimmed).toBe(
      "no models in your profile yet",
    );
  });
});
