import { describe, expect, it } from "vitest";
import type { Harness } from "./groups/harness";
import type { CapabilitySnapshot, ModelDescriptor } from "./groups/provider-account";
import { findSnapshotModel, isModelMissingFromHarness } from "./harness-models";

const model = (slug: string, name: string): ModelDescriptor => ({
  slug,
  name,
  imageInput: null,
  options: [],
});

const snapshot = (
  harnessId: string,
  probedAt: string,
  slugs: ReadonlyArray<string>,
  status: "ok" | "unauthenticated" = "ok",
  name = "probe",
): CapabilitySnapshot => ({
  runnerId: "01a06d02-8000-7000-8000-000000000001",
  harnessId,
  probedAt,
  harnessVersion: null,
  versionVerdict: "ok",
  auth: { status },
  models: slugs.map((slug) => model(slug, `${name} ${slug}`)),
});

/** A pi that runs Anthropic API keys, with its own model list or the provider's whole catalog. */
const piRuns = (models: "all" | "own-list"): Pick<Harness, "id" | "runs"> => ({
  id: "pi/pi",
  runs: [
    {
      providerId: "anthropic/anthropic",
      kinds: [{ kind: "api-key", modelArgument: "anthropic/{model}" }],
      models,
    },
  ],
});

describe("findSnapshotModel", () => {
  it("returns the model from the newest ok snapshot of that harness that lists the slug", () => {
    const account = {
      snapshots: [
        snapshot("pi/pi", "2026-10-01T00:00:00.000Z", ["glm-5"], "ok", "old"),
        snapshot("pi/pi", "2026-10-03T00:00:00.000Z", ["glm-5"], "ok", "new"),
        snapshot("pi/pi", "2026-10-05T00:00:00.000Z", ["other"], "ok", "newest"),
      ],
    };
    expect(findSnapshotModel(account, "pi/pi", "glm-5")?.name).toBe("new glm-5");
  });

  it("ignores snapshots of other harnesses and snapshots that are not ok", () => {
    const account = {
      snapshots: [
        snapshot("claude-code/claude-code", "2026-10-01T00:00:00.000Z", ["glm-5"]),
        snapshot("pi/pi", "2026-10-02T00:00:00.000Z", ["glm-5"], "unauthenticated"),
      ],
    };
    expect(findSnapshotModel(account, "pi/pi", "glm-5")).toBeUndefined();
  });
});

describe("isModelMissingFromHarness", () => {
  const account = (snapshots: ReadonlyArray<CapabilitySnapshot>) => ({
    providerId: "anthropic/anthropic",
    snapshots,
  });

  it("is true when the harness lists its own models and a successful probe lacks the model", () => {
    const probed = account([snapshot("pi/pi", "2026-10-01T00:00:00.000Z", ["glm-5"])]);
    expect(isModelMissingFromHarness(probed, piRuns("own-list"), "gpt-6")).toBe(true);
    expect(isModelMissingFromHarness(probed, piRuns("own-list"), "glm-5")).toBe(false);
  });

  it("is false without a successful probe, for a catalog harness and for an unknown harness", () => {
    const unprobed = account([
      snapshot("pi/pi", "2026-10-01T00:00:00.000Z", [], "unauthenticated"),
    ]);
    expect(isModelMissingFromHarness(unprobed, piRuns("own-list"), "gpt-6")).toBe(false);
    const probed = account([snapshot("pi/pi", "2026-10-01T00:00:00.000Z", ["glm-5"])]);
    expect(isModelMissingFromHarness(probed, piRuns("all"), "gpt-6")).toBe(false);
    expect(isModelMissingFromHarness(probed, undefined, "gpt-6")).toBe(false);
  });
});
