/** Tests `addStoredChoice(choices, stored)`, which keeps a stored value among a select's choices. */
import { describe, expect, it } from "vitest";
import { addStoredChoice } from "./choices";

describe("addStoredChoice", () => {
  it("returns the choices themselves when they hold the stored value", () => {
    const choices = [1, 2, 3];
    expect(addStoredChoice(choices, 2)).toBe(choices);
  });

  it("adds a stored value the choices lack, in ascending order", () => {
    expect(addStoredChoice([1, 2, 4], 3)).toEqual([1, 2, 3, 4]);
  });
});
