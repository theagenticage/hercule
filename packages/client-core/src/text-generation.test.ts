/**
 * Tests the "Text generation" select's choices, the name of the model
 * text generation runs on, and the line about the last failure.
 */
import { describe, expect, it } from "vitest";
import { buildInstance, buildSnapshot } from "./providers.testing";
import {
  describeTextGenerationFailure,
  describeTextGenerationModel,
  findTextGenerationChoiceKey,
  listTextGenerationChoices,
} from "./text-generation";

const model = (slug: string, name: string, extra: { isLegacy?: boolean } = {}) => ({
  slug,
  name,
  imageInput: null,
  options: [],
  ...extra,
});

/** Codex is logged in with two models, one of them also listed by a second runner. */
const CODEX = buildInstance("codex", "Codex", [
  buildSnapshot({ models: [model("gpt-6-luna", "GPT-6 Luna"), model("gpt-6", "GPT-6")] }),
  buildSnapshot({
    runnerId: "other",
    models: [model("gpt-6-luna", "GPT-6 Luna"), model("gpt-5", "GPT-5", { isLegacy: true })],
  }),
]);
/** Claude Code is logged out, so it offers nothing. */
const CLAUDE = buildInstance("claude-code", "Claude Code", [
  buildSnapshot({
    auth: { status: "unauthenticated" },
    models: [model("claude-haiku-4-5", "Haiku 4.5")],
  }),
]);
const LUNA = { instanceId: CODEX.id, model: "gpt-6-luna" };

describe("listTextGenerationChoices", () => {
  it("lists Automatic with its model, each logged-in model once, and Off", () => {
    const choices = listTextGenerationChoices([CODEX, CLAUDE], "automatic", LUNA);

    expect(choices.map((choice) => choice.label)).toEqual([
      "Automatic - currently Codex · GPT-6 Luna",
      "Codex · GPT-6 Luna",
      "Codex · GPT-6",
      "Off",
    ]);
    expect(choices.map((choice) => choice.setting)).toEqual([
      "automatic",
      LUNA,
      { instanceId: CODEX.id, model: "gpt-6" },
      "off",
    ]);
  });

  it("says that no model is available when Automatic resolves to none", () => {
    const [automatic] = listTextGenerationChoices([CLAUDE], "automatic", null);

    expect(automatic?.label).toBe("Automatic - no model available");
  });

  it("keeps a stored model that no logged-in instance lists any more", () => {
    const stored = { instanceId: CLAUDE.id, model: "claude-haiku-4-5" };
    const choices = listTextGenerationChoices([CODEX, CLAUDE], stored, null);

    expect(choices.at(-2)).toEqual({
      key: findTextGenerationChoiceKey(stored),
      label: "Claude Code · Haiku 4.5",
      setting: stored,
    });
  });

  it("gives every choice a different key, and the key of a stored setting is that choice's key", () => {
    const choices = listTextGenerationChoices([CODEX], LUNA, LUNA);

    expect(new Set(choices.map((choice) => choice.key)).size).toBe(choices.length);
    expect(
      choices.find((choice) => choice.key === findTextGenerationChoiceKey(LUNA))?.setting,
    ).toEqual(LUNA);
  });
});

describe("describeTextGenerationModel", () => {
  it("falls back to the slug when the instance is gone", () => {
    expect(describeTextGenerationModel([], LUNA)).toBe("gpt-6-luna");
  });
});

describe("describeTextGenerationFailure", () => {
  const now = new Date("2026-10-11T12:00:00.000Z");

  it("gives the age, the reason and the controller's message", () => {
    expect(
      describeTextGenerationFailure(
        {
          reason: "timeout",
          message: "Codex did not answer in 60 s.",
          at: "2026-10-11T11:57:00.000Z",
        },
        now,
      ),
    ).toBe("Last failure 3 minutes ago, timed out: Codex did not answer in 60 s.");
  });

  it("words each reason differently", () => {
    const at = "2026-10-11T11:59:50.000Z";
    const words = (reason: "unavailable" | "timeout" | "invalid-output") =>
      describeTextGenerationFailure({ reason, message: "m", at }, now);

    expect(new Set([words("unavailable"), words("timeout"), words("invalid-output")]).size).toBe(3);
    expect(words("unavailable")).toMatch(/^Last failure just now, /);
  });
});
