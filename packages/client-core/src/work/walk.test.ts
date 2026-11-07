/** Tests walking the board with the keys, over what is on screen. */
import { describe, expect, it } from "vitest";
import { walkBoard, type BoardWalk, type ShownBoard, type WalkStop } from "./walk";

/**
 * Four lanes of five columns (Exploring to Landed).
 *
 *   storefront:  [a1 a2 a3] [ ]      [b1]      [ ]  [ ]
 *   billing:     [ ]        [ ]      [ ]       [ ]  [ ]      (folded)
 *   support:     [c1]       [c2 c3]  [ ]       [ ]  [d1 d2]
 *   archive:     [ ]        [ ]      [ ]       [ ]  [ ]      (open, no card)
 */
const SHOWN: ShownBoard = [
  { id: "storefront", isFolded: false, columns: [["a1", "a2", "a3"], [], ["b1"], [], []] },
  { id: "billing", isFolded: true, columns: [[], [], [], [], []] },
  { id: "support", isFolded: false, columns: [["c1"], ["c2", "c3"], [], [], ["d1", "d2"]] },
  { id: "archive", isFolded: false, columns: [[], [], [], [], []] },
];

const card = (cardId: string): WalkStop => ({ kind: "card", cardId });
const head = (laneId: string): WalkStop => ({ kind: "lane", laneId });

describe("walkBoard", () => {
  it.each<[string, WalkStop, BoardWalk, WalkStop | undefined]>([
    ["down inside a column", card("a1"), "down", card("a2")],
    ["up inside a column", card("a3"), "up", card("a2")],
    ["up from the top of a column with nothing above", card("a1"), "up", undefined],
    [
      "down from the bottom of a column, passing over the folded lane",
      card("a3"),
      "down",
      card("c1"),
    ],
    ["up from the top of a column, passing over the folded lane", card("c1"), "up", card("a3")],
    ["down from the last card of the last lane with cards", card("c3"), "down", undefined],
    ["down from a column that no lane below has a card in", card("b1"), "down", undefined],
    ["right skips empty columns, to the same row", card("a2"), "right", card("b1")],
    [
      "right lands on the last row when the next column is shorter",
      card("a3"),
      "right",
      card("b1"),
    ],
    ["left lands on the nearest row", card("d2"), "left", card("c3")],
    ["left from the first column stays", card("a1"), "left", undefined],
    ["right from the last column stays", card("d1"), "right", undefined],
    ["right never leaves the lane", card("b1"), "right", undefined],
    ["next lane stops on a folded lane", card("a2"), "nextLane", head("billing")],
    [
      "next lane from a folded lane goes to the first card of the lane below",
      head("billing"),
      "nextLane",
      card("c1"),
    ],
    ["previous lane stops on a folded lane", card("c2"), "previousLane", head("billing")],
    [
      "previous lane from a folded lane goes to the first card above",
      head("billing"),
      "previousLane",
      card("a1"),
    ],
    [
      "next lane from the last lane with cards stays, passing over an empty open lane",
      card("c2"),
      "nextLane",
      undefined,
    ],
    ["previous lane from the first lane stays", card("b1"), "previousLane", undefined],
    ["a folded lane head has no card to go down from", head("billing"), "down", undefined],
  ])("%s", (_, from, walk, expected) => {
    expect(walkBoard(SHOWN, from, walk)).toEqual(expected);
  });

  it("starts at the first card when nothing, or a card not shown, has focus", () => {
    expect(walkBoard(SHOWN, undefined, "down")).toEqual(card("a1"));
    expect(walkBoard(SHOWN, card("gone"), "left")).toEqual(card("a1"));
  });

  it("starts a lane walk at the first stop, which may be a folded lane", () => {
    const foldedFirst: ShownBoard = [SHOWN[1]!, SHOWN[0]!];

    expect(walkBoard(foldedFirst, undefined, "nextLane")).toEqual(head("billing"));
  });

  it("goes nowhere on a board with no card", () => {
    expect(walkBoard([SHOWN[3]!], undefined, "down")).toBeUndefined();
  });
});
