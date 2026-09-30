/**
 * Tests `findModelName(instance, slug)` and `describeAgent(instance, model)`,
 * which name a thread's model from its instance's catalogs.
 */
import { describe, expect, it } from "vitest";
import { buildInstance, buildSnapshot } from "../providers.testing";
import { describeAgent, findModelName } from "./model-name";

/** An instance with a catalog on two runners; only the second lists Opus. */
const CLAUDE = buildInstance("claude-code", "Claude Code", [
  buildSnapshot({ runnerId: "atlas", models: [{ slug: "default", name: "Default", options: [] }] }),
  buildSnapshot({
    runnerId: "bare",
    models: [{ slug: "claude-opus-5-5", name: "Opus 5.5", options: [] }],
  }),
]);

describe("findModelName", () => {
  it("finds the name in any runner's catalog of the instance", () => {
    expect(findModelName(CLAUDE, "claude-opus-5-5")).toBe("Opus 5.5");
  });

  it("returns the slug when no catalog lists it", () => {
    expect(findModelName(CLAUDE, "claude-haiku-4-5")).toBe("claude-haiku-4-5");
  });

  it("returns the slug when the instance is gone", () => {
    expect(findModelName(undefined, "claude-opus-5-5")).toBe("claude-opus-5-5");
  });
});

describe("describeAgent", () => {
  it("joins the instance's display name and the model's name", () => {
    expect(describeAgent(CLAUDE, "claude-opus-5-5")).toBe("Claude Code · Opus 5.5");
  });

  it("leaves out the instance's name when the instance is gone", () => {
    expect(describeAgent(undefined, "claude-opus-5-5")).toBe("claude-opus-5-5");
  });
});
