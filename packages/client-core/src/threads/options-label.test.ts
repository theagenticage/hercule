/**
 * `optionsLabel(descriptors, selected)` is the one line the model options
 * selector shows for what is picked under the model.
 */
import { describe, expect, it } from "vitest";
import type { ModelOption } from "@hydra/contract";
import { optionsLabel } from "./options-label";

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

describe("optionsLabel", () => {
  it("has nothing to say when the model declares no options", () => {
    expect(optionsLabel([], {})).toBeNull();
  });

  it("reads the selected effort choice's label, lower-cased", () => {
    expect(optionsLabel([EFFORT], { effort: "high" })).toBe("high");
  });

  it("says thinking on for a boolean thinking option that is set", () => {
    expect(optionsLabel([THINKING], { thinking: true })).toBe("thinking on");
  });

  it("has nothing to say while thinking is off", () => {
    expect(optionsLabel([THINKING], { thinking: false })).toBeNull();
  });

  it("has nothing to append the bolt to when fast mode is all the model offers", () => {
    expect(optionsLabel([FAST_MODE], { fastMode: true })).toBeNull();
  });

  it("appends the bolt while fast mode is on", () => {
    expect(optionsLabel([EFFORT, FAST_MODE], { effort: "high", fastMode: true })).toBe("high ⚡");
    expect(optionsLabel([THINKING, FAST_MODE], { thinking: true, fastMode: true })).toBe(
      "thinking on ⚡",
    );
  });

  it("leaves the bolt off while fast mode is off", () => {
    expect(optionsLabel([EFFORT, FAST_MODE], { effort: "high", fastMode: false })).toBe("high");
  });
});
