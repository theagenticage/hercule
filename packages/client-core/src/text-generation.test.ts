/**
 * Tests the model select of Settings > System (`buildTextGenerationField`)
 * and the line about the last failure (`describeTextGenerationFailure`).
 */
import { describe, expect, it } from "vitest";
import type { TextGenerationStatus } from "@hercule/contract";
import { buildInstance, buildSnapshot } from "./providers.testing";
import { buildTextGenerationField, describeTextGenerationFailure } from "./text-generation";

const model = (slug: string, name: string) => ({
  slug,
  name,
  imageInput: { maxBytes: null },
  options: [],
});

const CODEX = buildInstance("codex", "Codex", [
  buildSnapshot({ models: [model("gpt-6-luna", "GPT-6 Luna"), model("gpt-6", "GPT-6")] }),
]);
const CLAUDE = buildInstance("claude-code", "Claude Code", [
  buildSnapshot({ models: [model("claude-haiku-5", "Haiku 5")] }),
]);
const LOGGED_OUT = buildInstance("pi", "pi", [
  buildSnapshot({
    auth: { status: "unauthenticated" },
    models: [model("glm-5.3-flash", "GLM 5.3 Flash")],
  }),
]);

const NOTHING: TextGenerationStatus = { model: null, lastFailure: null };
const NOW = new Date("2026-09-05T10:00:00.000Z");

describe("buildTextGenerationField", () => {
  it("lists Automatic, every logged-in instance and model, then Off", () => {
    const field = buildTextGenerationField(undefined, [CODEX, CLAUDE, LOGGED_OUT], NOTHING);

    expect(field.choices.map((choice) => choice.label)).toEqual([
      "Automatic - no model available",
      "Codex · GPT-6 Luna",
      "Codex · GPT-6",
      "Claude Code · Haiku 5",
      "Off",
    ]);
  });

  it("names the model Automatic resolves to while Automatic is the setting", () => {
    const status: TextGenerationStatus = {
      model: { instanceId: CODEX.id, model: "gpt-6-luna" },
      lastFailure: null,
    };

    for (const stored of [undefined, "automatic" as const]) {
      const field = buildTextGenerationField(stored, [CODEX, CLAUDE], status);

      expect(field.selectedKey).toBe("automatic");
      expect(field.choices[0]?.label).toBe("Automatic - currently Codex · GPT-6 Luna");
    }
  });

  it("does not name a model for Automatic when another setting is stored", () => {
    const status: TextGenerationStatus = {
      model: { instanceId: CLAUDE.id, model: "claude-haiku-5" },
      lastFailure: null,
    };
    const stored = { instanceId: CLAUDE.id, model: "claude-haiku-5" };

    const field = buildTextGenerationField(stored, [CODEX, CLAUDE], status);

    expect(field.choices[0]?.label).toBe("Automatic");
    expect(field.choices.find((choice) => choice.key === field.selectedKey)?.setting).toEqual(
      stored,
    );
  });

  it("selects Off when the setting is off", () => {
    const field = buildTextGenerationField("off", [CODEX], NOTHING);

    expect(field.selectedKey).toBe("off");
    expect(field.choices[0]?.label).toBe("Automatic");
  });

  it("stores the setting the choice stands for", () => {
    const field = buildTextGenerationField(undefined, [CODEX], NOTHING);

    expect(field.choices.map((choice) => choice.setting)).toEqual([
      "automatic",
      { instanceId: CODEX.id, model: "gpt-6-luna" },
      { instanceId: CODEX.id, model: "gpt-6" },
      "off",
    ]);
  });

  it("lists a model once when several runners offer it", () => {
    const twice = buildInstance("codex", "Codex", [
      buildSnapshot({ models: [model("gpt-6", "GPT-6")] }),
      buildSnapshot({ runnerId: "other", models: [model("gpt-6", "GPT-6")] }),
    ]);

    const field = buildTextGenerationField(undefined, [twice], NOTHING);

    expect(field.choices).toHaveLength(3);
  });

  it("keeps a stored model that is no longer offered, marked as not offered", () => {
    const stored = { instanceId: LOGGED_OUT.id, model: "glm-5.3-flash" };

    const field = buildTextGenerationField(stored, [LOGGED_OUT], NOTHING);

    const kept = field.choices.find((choice) => choice.key === field.selectedKey);
    expect(kept?.label).toBe("pi · GLM 5.3 Flash (not offered)");
    expect(kept?.setting).toEqual(stored);
  });

  it("keeps a stored model whose instance was deleted, under the model's slug", () => {
    const stored = { instanceId: "gone", model: "gpt-6" };

    const field = buildTextGenerationField(stored, [CODEX], NOTHING);

    expect(field.choices.find((choice) => choice.key === field.selectedKey)?.label).toBe(
      "gpt-6 (not offered)",
    );
  });
});

describe("describeTextGenerationFailure", () => {
  const failed = (reason: "unavailable" | "timeout" | "invalid-output"): TextGenerationStatus => ({
    model: null,
    lastFailure: { reason, message: "The call went wrong.", at: "2026-09-05T09:55:00.000Z" },
  });

  it("reads the reason, the message and how long ago it was", () => {
    expect(describeTextGenerationFailure(undefined, failed("timeout"), NOW)).toBe(
      "Last failure 5 minutes ago - timed out: The call went wrong.",
    );
    expect(describeTextGenerationFailure("automatic", failed("unavailable"), NOW)).toBe(
      "Last failure 5 minutes ago - no model available: The call went wrong.",
    );
    expect(
      describeTextGenerationFailure(
        { instanceId: CODEX.id, model: "gpt-6" },
        failed("invalid-output"),
        NOW,
      ),
    ).toBe("Last failure 5 minutes ago - invalid output: The call went wrong.");
  });

  it("returns null when there is no failure", () => {
    expect(describeTextGenerationFailure(undefined, NOTHING, NOW)).toBeNull();
  });

  it("returns null while text generation is off", () => {
    expect(describeTextGenerationFailure("off", failed("timeout"), NOW)).toBeNull();
  });
});
