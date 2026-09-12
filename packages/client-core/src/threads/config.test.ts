/**
 * `effectiveConfig(base, picks)` is what the composer draws and what a draft
 * spawns with. What matters: the options a model carries survive a pick that
 * is not about the model, and go with the model when one is picked.
 */
import { describe, expect, it } from "vitest";
import { effectiveConfig, type ThreadConfig } from "./config";

const BASE: ThreadConfig = {
  instanceId: "i-claude",
  model: "claude-sonnet-5",
  accessMode: "approval-required",
  runnerId: "r-local",
  profileId: "p-unrestricted",
  options: { effort: "high" },
};

describe("effectiveConfig", () => {
  it("is the thread's own configuration when nothing is picked", () => {
    expect(effectiveConfig(BASE, {})).toEqual(BASE);
  });

  it("lays the options picked over the ones the model already runs with", () => {
    expect(effectiveConfig(BASE, { options: { thinking: true } }).options).toEqual({
      effort: "high",
      thinking: true,
    });
  });

  it("drops the stored options when another model is picked: they went with it", () => {
    expect(effectiveConfig(BASE, { model: "claude-opus-5" })).toMatchObject({
      model: "claude-opus-5",
      options: {},
    });
  });

  it("keeps the options picked under the model just picked", () => {
    expect(
      effectiveConfig(BASE, { model: "claude-opus-5", options: { effort: "low" } }).options,
    ).toEqual({ effort: "low" });
  });
});
