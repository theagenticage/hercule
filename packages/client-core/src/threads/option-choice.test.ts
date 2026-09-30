/**
 * Tests `parseOptionChoice(row, choice)`, which turns a choice made in the
 * options menu into the value the thread's picks hold: a boolean for an
 * off/on option, and the choice as it is for any other option.
 */
import { describe, expect, it } from "vitest";
import type { ModelOptionRow } from "./options-menu";
import { parseOptionChoice } from "./option-choice";

const EFFORT: ModelOptionRow = {
  id: "effort",
  label: "Reasoning effort",
  choices: [
    { value: "low", label: "Low" },
    { value: "high", label: "High" },
  ],
  value: "low",
  boolean: false,
};

const THINKING: ModelOptionRow = {
  id: "thinking",
  label: "Extended thinking",
  choices: [
    { value: "off", label: "off" },
    { value: "on", label: "on" },
  ],
  value: "off",
  boolean: true,
};

describe("parseOptionChoice", () => {
  it("picks a boolean option's switch as a boolean", () => {
    expect(parseOptionChoice(THINKING, "on")).toBe(true);
    expect(parseOptionChoice(THINKING, "off")).toBe(false);
  });

  it("picks any other option's choice as it is", () => {
    expect(parseOptionChoice(EFFORT, "high")).toBe("high");
  });
});
