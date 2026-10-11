import { describe, expect, it } from "vitest";
import { pickSelectionAfterMove } from "./pick-selection-after-move";

describe("pickSelectionAfterMove", () => {
  const listed = ["a", "b", "c", "d"];

  it("keeps the selected row when it stays", () => {
    expect(pickSelectionAfterMove(listed, "b", ["c"])).toBe("b");
  });

  it("selects the first row after it that stays", () => {
    expect(pickSelectionAfterMove(listed, "b", ["b", "c"])).toBe("d");
  });

  it("selects the last row before it that stays when none after it does", () => {
    expect(pickSelectionAfterMove(listed, "c", ["b", "c", "d"])).toBe("a");
  });

  it("selects nothing when no row stays", () => {
    expect(pickSelectionAfterMove(listed, "a", listed)).toBeNull();
  });

  it("selects nothing when nothing was selected, or the selected row is not listed", () => {
    expect(pickSelectionAfterMove(listed, null, ["a"])).toBeNull();
    expect(pickSelectionAfterMove(listed, "z", ["z"])).toBeNull();
  });
});
