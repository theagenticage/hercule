/** Tests which rows of Intake's list leave, arrive and slide when the list changes. */
import { describe, expect, it } from "vitest";
import { listLeavingRows, planRowMoves, type RowPlace } from "./use-row-motion";

/** The list's viewport: 400px tall, from 100px under the window's top. */
const VIEWPORT: RowPlace = { top: 100, bottom: 500 };

/** Returns the place of a 50px row whose top is `top`. */
const placeRow = (top: number): RowPlace => ({ top, bottom: top + 50 });

describe("listLeavingRows", () => {
  it("lists the rows on screen that leave, and leaves out the rows out of view", () => {
    const places = new Map([
      ["a", placeRow(100)],
      ["b", placeRow(150)],
      ["c", placeRow(600)],
    ]);
    expect(listLeavingRows(places, new Set(["b"]), VIEWPORT)).toEqual(["a"]);
  });
});

describe("planRowMoves", () => {
  it("slides the rows that stay into the gap a row left", () => {
    const before = new Map([
      ["a", placeRow(100)],
      ["b", placeRow(150)],
    ]);
    const after = new Map([["b", placeRow(100)]]);
    expect(planRowMoves(new Set(["a", "b"]), before, after, VIEWPORT)).toEqual([
      { key: "b", kind: "slide", offset: 50 },
    ]);
  });

  it("brings in every new row on screen at once, and pushes the rows below down", () => {
    const before = new Map([["a", placeRow(100)]]);
    const after = new Map([
      ["x", placeRow(100)],
      ["y", placeRow(150)],
      ["a", placeRow(200)],
    ]);
    expect(planRowMoves(new Set(["a"]), before, after, VIEWPORT)).toEqual([
      { key: "x", kind: "arrive" },
      { key: "y", kind: "arrive" },
      { key: "a", kind: "slide", offset: -100 },
    ]);
  });

  it("moves nothing out of view, and nothing that did not move or was not drawn before", () => {
    const before = new Map([
      ["a", placeRow(100)],
      ["far", placeRow(900)],
    ]);
    const after = new Map([
      ["a", placeRow(100)],
      ["far", placeRow(950)],
      ["undrawn", placeRow(150)],
      ["new-below", placeRow(700)],
    ]);
    expect(planRowMoves(new Set(["a", "far", "undrawn"]), before, after, VIEWPORT)).toEqual([]);
  });
});
