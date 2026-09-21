/**
 * `optionsMenu(descriptors, selected)` is what the model options selector
 * draws. What matters: a boolean descriptor declares no choices of its own,
 * so the menu gives it the two-way switch and says its pick goes back as a
 * boolean, and a value nobody picked reads as the descriptor's own default.
 */
import { describe, expect, it } from "vitest";
import type { ModelOption } from "@hercule/contract";
import { optionsMenu } from "./options-menu";

const EFFORT: ModelOption = {
  id: "effort",
  label: "Reasoning effort",
  kind: "select",
  choices: [
    { value: "low", label: "Low" },
    { value: "high", label: "High" },
  ],
  default: "low",
};

const THINKING: ModelOption = {
  id: "thinking",
  label: "Extended thinking",
  kind: "boolean",
  default: false,
};

describe("optionsMenu", () => {
  it("carries a select's own choices, and the value picked under it", () => {
    expect(optionsMenu([EFFORT], { effort: "high" })).toEqual([
      {
        id: "effort",
        label: "Reasoning effort",
        choices: [
          { value: "low", label: "Low" },
          { value: "high", label: "High" },
        ],
        value: "high",
        boolean: false,
      },
    ]);
  });

  it("reads a boolean as an off/on switch, on the value it is set to", () => {
    expect(optionsMenu([THINKING], { thinking: true })).toEqual([
      {
        id: "thinking",
        label: "Extended thinking",
        choices: [
          { value: "off", label: "off" },
          { value: "on", label: "on" },
        ],
        value: "on",
        boolean: true,
      },
    ]);
  });

  it("falls back to each descriptor's own default where nothing was picked", () => {
    expect(optionsMenu([EFFORT, THINKING], {}).map((row) => row.value)).toEqual(["low", "off"]);
  });
});
