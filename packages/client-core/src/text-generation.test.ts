/**
 * Tests the model select of Settings > System (`buildTextGenerationField`)
 * and the line about the last failure (`describeTextGenerationFailure`).
 */
import { describe, expect, it } from "vitest";
import type { TextGenerationStatus } from "@hercule/contract";
import {
  PROVIDERS,
  buildProviderAccount,
  buildSnapshot,
  ANTHROPIC_IDENTITY,
  OPENAI_IDENTITY,
  ZAI_IDENTITY,
} from "./providers.testing";
import {
  buildTextGenerationField,
  describeTextGenerationFailure,
  describeTextGenerationModel,
  describeTextGenerationRecap,
} from "./text-generation";

const model = (slug: string, name: string, extra: { isLegacy?: boolean } = {}) => ({
  slug,
  name,
  imageInput: { maxBytes: null },
  options: [],
  ...extra,
});

const CODEX = buildProviderAccount(OPENAI_IDENTITY, [
  buildSnapshot({ models: [model("gpt-6-luna", "GPT-6 Luna"), model("gpt-6", "GPT-6")] }),
]);
const CLAUDE = buildProviderAccount(ANTHROPIC_IDENTITY, [
  buildSnapshot({ models: [model("claude-haiku-5", "Haiku 5")] }),
]);
const SIGNED_OUT = buildProviderAccount(ZAI_IDENTITY, [
  buildSnapshot({
    auth: { status: "unauthenticated" },
    models: [model("glm-5.3-flash", "GLM 5.3 Flash")],
  }),
]);

const NOTHING: TextGenerationStatus = { model: null, unavailableReason: null, lastFailure: null };
const NOW = new Date("2026-09-05T10:00:00.000Z");

describe("buildTextGenerationField", () => {
  it("lists Automatic, every signed-in account and model, then Off", () => {
    const field = buildTextGenerationField(
      undefined,
      PROVIDERS,
      [CODEX, CLAUDE, SIGNED_OUT],
      NOTHING,
    );

    expect(field.choices.map((choice) => choice.label)).toEqual([
      "Automatic - no model available",
      "OpenAI · GPT-6 Luna",
      "OpenAI · GPT-6",
      "Anthropic · Haiku 5",
      "Off",
    ]);
  });

  it("names the model Automatic resolves to while Automatic is the setting", () => {
    const status: TextGenerationStatus = {
      model: { providerAccountId: CODEX.id, harnessId: "codex/codex", model: "gpt-6-luna" },
      unavailableReason: null,
      lastFailure: null,
    };

    for (const stored of [undefined, "automatic" as const]) {
      const field = buildTextGenerationField(stored, PROVIDERS, [CODEX, CLAUDE], status);

      expect(field.selectedKey).toBe("automatic");
      expect(field.choices[0]?.label).toBe("Automatic - currently OpenAI · GPT-6 Luna");
    }
  });

  it("does not name a model for Automatic when another setting is stored", () => {
    const status: TextGenerationStatus = {
      model: {
        providerAccountId: CLAUDE.id,
        harnessId: "claude-code/claude-code",
        model: "claude-haiku-5",
      },
      unavailableReason: null,
      lastFailure: null,
    };
    const stored = { providerAccountId: CLAUDE.id, model: "claude-haiku-5" };

    const field = buildTextGenerationField(stored, PROVIDERS, [CODEX, CLAUDE], status);

    expect(field.choices[0]?.label).toBe("Automatic");
    expect(field.choices.find((choice) => choice.key === field.selectedKey)?.setting).toEqual(
      stored,
    );
  });

  it("selects Off when the setting is off", () => {
    const field = buildTextGenerationField("off", PROVIDERS, [CODEX], NOTHING);

    expect(field.selectedKey).toBe("off");
    expect(field.choices[0]?.label).toBe("Automatic");
  });

  it("stores the setting the choice stands for", () => {
    const field = buildTextGenerationField(undefined, PROVIDERS, [CODEX], NOTHING);

    expect(field.choices.map((choice) => choice.setting)).toEqual([
      "automatic",
      { providerAccountId: CODEX.id, model: "gpt-6-luna" },
      { providerAccountId: CODEX.id, model: "gpt-6" },
      "off",
    ]);
  });

  it("lists a model once when several runners offer it", () => {
    const twice = buildProviderAccount(OPENAI_IDENTITY, [
      buildSnapshot({ models: [model("gpt-6", "GPT-6")] }),
      buildSnapshot({ runnerId: "other", models: [model("gpt-6", "GPT-6")] }),
    ]);

    const field = buildTextGenerationField(undefined, PROVIDERS, [twice], NOTHING);

    expect(field.choices).toHaveLength(3);
  });

  it("keeps a stored model that is no longer offered, marked as not offered", () => {
    const stored = { providerAccountId: SIGNED_OUT.id, model: "glm-5.3-flash" };

    const field = buildTextGenerationField(stored, PROVIDERS, [SIGNED_OUT], NOTHING);

    const kept = field.choices.find((choice) => choice.key === field.selectedKey);
    expect(kept?.label).toBe("Z.ai · GLM 5.3 Flash (not offered)");
    expect(kept?.setting).toEqual(stored);
  });

  it("treats a stored harness that is the account's default as the same choice as leaving it out", () => {
    const stored = {
      providerAccountId: CODEX.id,
      harnessId: "codex/codex",
      model: "gpt-6-luna",
    };

    const field = buildTextGenerationField(stored, PROVIDERS, [CODEX], NOTHING);

    expect(field.choices.find((choice) => choice.key === field.selectedKey)?.label).toBe(
      "OpenAI · GPT-6 Luna",
    );
  });

  it("keeps a stored model in another harness as not offered, since the list holds default harnesses only", () => {
    const stored = { providerAccountId: CODEX.id, harnessId: "pi/pi", model: "gpt-6-luna" };

    const field = buildTextGenerationField(stored, PROVIDERS, [CODEX], NOTHING);

    expect(field.choices.find((choice) => choice.key === field.selectedKey)?.label).toBe(
      "OpenAI · gpt-6-luna (not offered)",
    );
  });

  it("keeps a stored model whose account was deleted, under the model's slug", () => {
    const stored = { providerAccountId: "gone", model: "gpt-6" };

    const field = buildTextGenerationField(stored, PROVIDERS, [CODEX], NOTHING);

    expect(field.choices.find((choice) => choice.key === field.selectedKey)?.label).toBe(
      "gpt-6 (not offered)",
    );
  });
});

describe("describeTextGenerationFailure", () => {
  const failed = (
    reason: "unavailable" | "failed" | "timeout" | "invalid-output",
  ): TextGenerationStatus => ({
    model: null,
    unavailableReason: null,
    lastFailure: { reason, message: "The call went wrong.", at: "2026-09-05T09:55:00.000Z" },
  });

  it("reads the reason, the message and how long ago it was", () => {
    expect(describeTextGenerationFailure(undefined, failed("timeout"), NOW)).toBe(
      "Last failure 5 minutes ago - timed out: The call went wrong.",
    );
    expect(describeTextGenerationFailure("automatic", failed("unavailable"), NOW)).toBe(
      "Last failure 5 minutes ago - unavailable: The call went wrong.",
    );
    expect(describeTextGenerationFailure("automatic", failed("failed"), NOW)).toBe(
      "Last failure 5 minutes ago - failed: The call went wrong.",
    );
    expect(
      describeTextGenerationFailure(
        { providerAccountId: CODEX.id, model: "gpt-6" },
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

describe("buildTextGenerationField, with models several runners list", () => {
  it("offers each model once, and no model kept only for old sessions", () => {
    const twoRunners = buildProviderAccount(OPENAI_IDENTITY, [
      buildSnapshot({ models: [model("gpt-6-luna", "GPT-6 Luna")] }),
      buildSnapshot({
        runnerId: "other",
        models: [model("gpt-6-luna", "GPT-6 Luna"), model("gpt-5", "GPT-5", { isLegacy: true })],
      }),
    ]);

    const field = buildTextGenerationField("off", PROVIDERS, [twoRunners], NOTHING);

    expect(field.choices.map((choice) => choice.label)).toEqual([
      "Automatic",
      "OpenAI · GPT-6 Luna",
      "Off",
    ]);
  });
});

describe("describeTextGenerationRecap", () => {
  it("names the model text generation runs on", () => {
    const status: TextGenerationStatus = {
      model: { providerAccountId: CODEX.id, harnessId: "codex/codex", model: "gpt-6-luna" },
      unavailableReason: null,
      lastFailure: null,
    };

    expect(describeTextGenerationRecap(PROVIDERS, [CODEX], status)).toBe("OpenAI · GPT-6 Luna");
  });

  it("reads no model available when the status holds none", () => {
    expect(describeTextGenerationRecap(PROVIDERS, [CODEX], NOTHING)).toBe("no model available");
  });
});

describe("describeTextGenerationModel", () => {
  it("falls back to the slug when the account is gone", () => {
    expect(
      describeTextGenerationModel(PROVIDERS, [], {
        providerAccountId: CODEX.id,
        model: "gpt-6-luna",
      }),
    ).toBe("gpt-6-luna");
  });
});
