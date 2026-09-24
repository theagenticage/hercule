/**
 * Tests `buildOptionsMenu(descriptors, selected)`, which builds the rows of the
 * model options selector. A boolean option declares no choices, so the menu
 * gives it an off/on switch and marks it as boolean. An option nobody picked
 * shows its declared default.
 */
import { describe, expect, it } from "vitest";
import type { ModelOption } from "@hercule/contract";
import { buildOptionsMenu } from "./options-menu";

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

describe("buildOptionsMenu", () => {
  it("keeps a select option's choices and its picked value", () => {
    expect(buildOptionsMenu([EFFORT], { effort: "high" })).toEqual([
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

  it("shows a boolean option as an off/on switch with its current value", () => {
    expect(buildOptionsMenu([THINKING], { thinking: true })).toEqual([
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

  it("falls back to each option's declared default when nothing was picked", () => {
    expect(buildOptionsMenu([EFFORT, THINKING], {}).map((row) => row.value)).toEqual([
      "low",
      "off",
    ]);
  });
});
