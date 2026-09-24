/**
 * Tests `buildOptionsLabel(descriptors, selected)`, the short label the model
 * options selector shows for the picked options.
 */
import { describe, expect, it } from "vitest";
import type { ModelOption } from "@hercule/contract";
import { buildOptionsLabel } from "./options-label";

const EFFORT: ModelOption = {
  id: "effort",
  label: "Reasoning effort",
  kind: "select",
  choices: [
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
  ],
  default: "medium",
};

const THINKING: ModelOption = {
  id: "thinking",
  label: "Extended thinking",
  kind: "boolean",
  default: false,
};

const FAST_MODE: ModelOption = {
  id: "fastMode",
  label: "Fast mode",
  kind: "boolean",
  default: false,
};

describe("buildOptionsLabel", () => {
  it("returns null when the model declares no options", () => {
    expect(buildOptionsLabel([], {})).toBeNull();
  });

  it("uses the selected effort choice's label, in lower case", () => {
    expect(buildOptionsLabel([EFFORT], { effort: "high" })).toBe("high");
  });

  it("says thinking on for a boolean thinking option that is set", () => {
    expect(buildOptionsLabel([THINKING], { thinking: true })).toBe("thinking on");
  });

  it("returns null while thinking is off", () => {
    expect(buildOptionsLabel([THINKING], { thinking: false })).toBeNull();
  });

  it("returns null when fast mode is the only option, because the bolt has nothing to follow", () => {
    expect(buildOptionsLabel([FAST_MODE], { fastMode: true })).toBeNull();
  });

  it("appends the bolt while fast mode is on", () => {
    expect(buildOptionsLabel([EFFORT, FAST_MODE], { effort: "high", fastMode: true })).toBe(
      "high ⚡",
    );
    expect(buildOptionsLabel([THINKING, FAST_MODE], { thinking: true, fastMode: true })).toBe(
      "thinking on ⚡",
    );
  });

  it("leaves the bolt off while fast mode is off", () => {
    expect(buildOptionsLabel([EFFORT, FAST_MODE], { effort: "high", fastMode: false })).toBe(
      "high",
    );
  });
});
