/** Tests walking the board with the keys, over what is on screen. */
import { describe, expect, it } from "vitest";
import { walkBoard, type BoardWalk, type ShownBoard } from "./walk";

/**
 * Three lanes of five columns (Exploring to Landed).
 *
 *   lane 0:  [a1 a2 a3] [ ]      [b1]      [ ]  [ ]
 *   lane 1:  [ ]        [ ]      [ ]       [ ]  [ ]      (folded)
 *   lane 2:  [c1]       [c2 c3]  [ ]       [ ]  [d1 d2]
 */
const SHOWN: ShownBoard = [
  [["a1", "a2", "a3"], [], ["b1"], [], []],
  [[], [], [], [], []],
  [["c1"], ["c2", "c3"], [], [], ["d1", "d2"]],
];

describe("walkBoard", () => {
  it.each<[string, string, BoardWalk, string | undefined]>([
    ["down inside a column", "a1", "down", "a2"],
    ["up inside a column", "a3", "up", "a2"],
    ["up from the top of a column with nothing above", "a1", "up", undefined],
    ["down from the bottom of a column, skipping the folded lane", "a3", "down", "c1"],
    ["up from the top of a column, skipping the folded lane", "c1", "up", "a3"],
    ["down from the last card of the last lane", "c3", "down", undefined],
    ["down from a column that no lane below has a card in", "b1", "down", undefined],
    ["right skips empty columns, to the same row", "a2", "right", "b1"],
    ["right lands on the last row when the next column is shorter", "a3", "right", "b1"],
    ["left lands on the nearest row", "d2", "left", "c3"],
    ["left from the first column stays", "a1", "left", undefined],
    ["right from the last column stays", "d1", "right", undefined],
    ["right never leaves the lane", "b1", "right", undefined],
    ["next lane goes to the first card, skipping a folded lane", "a2", "nextLane", "c1"],
    ["previous lane goes to the first card, skipping a folded lane", "d2", "previousLane", "a1"],
    ["next lane from the last lane stays", "c2", "nextLane", undefined],
    ["previous lane from the first lane stays", "b1", "previousLane", undefined],
  ])("%s", (_, from, walk, expected) => {
    expect(walkBoard(SHOWN, from, walk)).toBe(expected);
  });

  it("starts at the first card when nothing, or a card not shown, has focus", () => {
    expect(walkBoard(SHOWN, undefined, "down")).toBe("a1");
    expect(walkBoard(SHOWN, "gone", "previousLane")).toBe("a1");
  });

  it("goes nowhere on a board with no card", () => {
    expect(walkBoard([[[], [], [], [], []]], undefined, "down")).toBeUndefined();
  });
});
