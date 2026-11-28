/**
 * Tests how the runner cuts a probe result's Model Catalog to what the protocol
 * carries, and that it tells the log when it drops models.
 */
import { describe, expect, it } from "vitest";
import { Effect, Logger } from "effect";
import { MAX_PROBE_MODELS, type ModelDescriptor, type ProbeResult } from "@hercule/protocol";
import { limitProbeModels } from "./probe";

const buildProbeResult = (modelCount: number): ProbeResult => ({
  harnessVersion: "1.0.0",
  auth: { status: "ok" },
  models: Array.from({ length: modelCount }, (_, index): ModelDescriptor => ({
    slug: `model-${String(index)}`,
    name: `Model ${String(index)}`,
    imageInput: null,
    options: [],
  })),
  usage: null,
});

const limitCollectingWarnings = async (modelCount: number) => {
  const warnings: Array<string> = [];
  const collecting = Logger.make<unknown, void>(({ logLevel, message }) => {
    if (logLevel === "Warn") warnings.push(String(message));
  });
  const limited = await Effect.runPromise(
    limitProbeModels("pi", buildProbeResult(modelCount)).pipe(
      Effect.provide(Logger.layer([collecting])),
    ),
  );
  return { limited, warnings };
};

describe("limiting a probe result's models", () => {
  it("keeps every model up to the protocol's cap, as OpenCode Zen's 68 need, and logs nothing", async () => {
    const { limited, warnings } = await limitCollectingWarnings(68);

    expect(limited).toEqual(buildProbeResult(68));
    expect(warnings).toEqual([]);
  });

  it("keeps the 366 OpenRouter models pi 0.85.1 ships, which the cap of 256 once cut", async () => {
    const { limited, warnings } = await limitCollectingWarnings(366);

    expect(limited.models).toHaveLength(366);
    expect(warnings).toEqual([]);
  });

  it("cuts a longer list at the cap and warns once with how many models it dropped", async () => {
    const { limited, warnings } = await limitCollectingWarnings(MAX_PROBE_MODELS + 5);

    expect(limited.models).toHaveLength(MAX_PROBE_MODELS);
    expect(limited.models[0]?.slug).toBe("model-0");
    expect(limited.auth).toEqual(buildProbeResult(0).auth);
    expect(warnings).toEqual([
      `pi listed ${String(MAX_PROBE_MODELS + 5)} models and the probe reports ${String(MAX_PROBE_MODELS)}, so 5 were dropped`,
    ]);
  });
});
