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

// The shape the pi harness declares: thinking as a list of levels.
const THINKING_LEVELS: ModelOption = {
  id: "thinking",
  label: "Thinking",
  kind: "select",
  choices: [
    { value: "low", label: "Low" },
    { value: "high", label: "High" },
    { value: "max", label: "Max" },
  ],
  default: "low",
};

const THINKING_LEVELS_WITH_OFF: ModelOption = {
  ...THINKING_LEVELS,
  choices: [{ value: "off", label: "Off" }, ...(THINKING_LEVELS.choices ?? [])],
  default: "off",
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

  it("uses the selected effort choice's label", () => {
    expect(buildOptionsLabel([EFFORT], { effort: "high" })).toBe("High");
  });

  it("says Thinking on for a boolean thinking option that is set", () => {
    expect(buildOptionsLabel([THINKING], { thinking: true })).toBe("Thinking on");
  });

  it("returns null while thinking is off", () => {
    expect(buildOptionsLabel([THINKING], { thinking: false })).toBeNull();
  });

  it("uses the picked level's label for a thinking option that lists levels", () => {
    expect(buildOptionsLabel([THINKING_LEVELS], { thinking: "max" })).toBe("Max");
  });

  it("uses the default level's label before a level is picked", () => {
    expect(buildOptionsLabel([THINKING_LEVELS], {})).toBe("Low");
  });

  it("returns null while a thinking option that lists levels is at its off level", () => {
    expect(buildOptionsLabel([THINKING_LEVELS_WITH_OFF], {})).toBeNull();
    expect(buildOptionsLabel([THINKING_LEVELS_WITH_OFF], { thinking: "off" })).toBeNull();
    expect(buildOptionsLabel([THINKING_LEVELS_WITH_OFF], { thinking: "high" })).toBe("High");
  });

  it("returns null when fast mode is the only option, because the bolt has nothing to follow", () => {
    expect(buildOptionsLabel([FAST_MODE], { fastMode: true })).toBeNull();
  });

  it("appends the bolt while fast mode is on", () => {
    expect(buildOptionsLabel([EFFORT, FAST_MODE], { effort: "high", fastMode: true })).toBe(
      "High ⚡",
    );
    expect(buildOptionsLabel([THINKING, FAST_MODE], { thinking: true, fastMode: true })).toBe(
      "Thinking on ⚡",
    );
  });

  it("leaves the bolt off while fast mode is off", () => {
    expect(buildOptionsLabel([EFFORT, FAST_MODE], { effort: "high", fastMode: false })).toBe(
      "High",
    );
  });
});
