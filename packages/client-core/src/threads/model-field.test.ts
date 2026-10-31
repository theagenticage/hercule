/**
 * Tests `buildThreadModelField(catalogs, current)`, the model field of
 * Settings > Threads: the entries of every Model Profile, as the composer's
 * model menu lists them, grouped by profile name when there are several, with the stored default selected and kept on the list
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
      groups: [],
      selectedKey: null,
    });
    expect(buildThreadModelField(buildCatalogs([]), { ...STORED, model: null }).dimmed).toBe(
      "no models in your profile yet",
    );
  });

  describe("with several profiles", () => {
    const WORK = {
      ...buildModelProfile([buildProfileSection(OPENAI_IDENTITY, [GPT])]),
      id: "01a06d02-7800-7000-8000-0000000000b2",
      name: "Work",
    };
    const HOME = {
      ...buildModelProfile([buildProfileSection(ANTHROPIC_IDENTITY, [SONNET, OPUS])]),
      id: "01a06d02-7800-7000-8000-0000000000b1",
      name: "Home",
    };

    it("offers the entries of every profile, grouped by the profile's name", () => {
      const field = buildThreadModelField(buildCatalogs([HOME, WORK]), STORED);

      expect(
        field.groups.map((group) => [group.label, group.options.map((option) => option.label)]),
      ).toEqual([
        ["Home", ["Anthropic · Sonnet 5", "Anthropic · Opus 5"]],
        ["Work", ["OpenAI · GPT-6"]],
      ]);
      expect(field.options.map((option) => option.model)).toEqual([
        "claude-sonnet-5",
        "claude-opus-5",
        "gpt-6",
      ]);
    });

    it("lets an entry that is only in the second profile be the default", () => {
      const field = buildThreadModelField(buildCatalogs([HOME, WORK]), {
        providerAccountId: CODEX.id,
        harnessId: null,
        model: "gpt-6",
      });

      expect(field.options.find((option) => option.key === field.selectedKey)).toMatchObject({
        label: "OpenAI · GPT-6",
        missing: false,
      });
    });

    it("lists an entry two profiles hold once, under the first", () => {
      const alsoOpus = {
        ...buildModelProfile([buildProfileSection(ANTHROPIC_IDENTITY, [OPUS])]),
        id: WORK.id,
        name: "Work",
      };

      const field = buildThreadModelField(buildCatalogs([HOME, alsoOpus]), STORED);

      expect(field.options.filter((option) => option.model === "claude-opus-5")).toHaveLength(1);
      expect(field.groups.map((group) => group.label)).toEqual(["Home"]);
    });

    it("puts the not offered entry last, in a group with no label", () => {
      const field = buildThreadModelField(buildCatalogs([HOME, WORK]), {
        ...STORED,
        model: "claude-haiku-5",
      });

      expect(field.groups.map((group) => group.label)).toEqual(["Home", "Work", null]);
      expect(field.groups.at(-1)?.options).toMatchObject([
        { model: "claude-haiku-5", missing: true },
      ]);
    });
  });

  it("does not label the single group when there is one profile", () => {
    const field = buildThreadModelField(buildCatalogs([MAIN]), {
      ...STORED,
      model: "claude-haiku-5",
    });

    expect(field.groups.map((group) => group.label)).toEqual([null, null]);
  });
});
