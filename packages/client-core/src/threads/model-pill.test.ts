import { describe, expect, it } from "vitest";
import type { ModelOption } from "@hydra/contract";
import { modelPillLabel } from "./model-pill";

const INSTANCE = { displayName: "Claude Code", name: "personal" };

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
  default: true,
};

describe("modelPillLabel", () => {
  it("reads displayName, instance name and slug, with no fourth segment when the model has no effort option", () => {
    expect(modelPillLabel(INSTANCE, "claude-haiku-5", [], {})).toBe(
      "Claude Code · personal · claude-haiku-5",
    );
  });

  it("appends the effort option's default choice label when nothing has been picked yet", () => {
    expect(modelPillLabel(INSTANCE, "claude-sonnet-5", [EFFORT], {})).toBe(
      "Claude Code · personal · claude-sonnet-5 · Medium",
    );
  });

  it("appends the chosen choice's label, not its value", () => {
    expect(modelPillLabel(INSTANCE, "claude-sonnet-5", [EFFORT], { effort: "high" })).toBe(
      "Claude Code · personal · claude-sonnet-5 · High",
    );
  });

  it("ignores a non-effort option entirely", () => {
    expect(modelPillLabel(INSTANCE, "claude-sonnet-5", [THINKING], { thinking: false })).toBe(
      "Claude Code · personal · claude-sonnet-5",
    );
  });

  it("reads a boolean-kind effort option as on/off", () => {
    const boolEffort: ModelOption = {
      id: "effort",
      label: "Reasoning effort",
      kind: "boolean",
      default: false,
    };
    expect(modelPillLabel(INSTANCE, "claude-sonnet-5", [boolEffort], { effort: true })).toBe(
      "Claude Code · personal · claude-sonnet-5 · on",
    );
  });
});
