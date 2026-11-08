/**
 * Tests the route of the line from a blocked card to its blocker on a board of
 * cards 200 wide and 100 high, in columns 240 apart and rows 120 apart.
 */
import { describe, expect, it } from "vitest";
import { buildRoundedPath, routeBlockerLine, type Box } from "./blocker-line-geometry";

const card = (column: number, row: number): Box => ({
  left: column * 240,
  top: row * 120,
  right: column * 240 + 200,
  bottom: row * 120 + 100,
});

describe("the route of a line to a blocker", () => {
  it("leaves the bottom of the card and enters the left side of a blocker lower and to the right", () => {
    expect(routeBlockerLine(card(0, 0), card(1, 1))).toEqual([
      [100, 100],
      [100, 111],
      [233, 111],
      [233, 170],
      [240, 170],
    ]);
  });

  it("enters the right side of a blocker that lies wholly to the left", () => {
    expect(routeBlockerLine(card(2, 0), card(0, 1))).toEqual([
      [580, 100],
      [580, 111],
      [207, 111],
      [207, 170],
      [200, 170],
    ]);
  });

  it("leaves the top of the card when the blocker is not lower", () => {
    expect(routeBlockerLine(card(0, 1), card(1, 1))).toEqual([
      [100, 120],
      [100, 109],
      [233, 109],
      [233, 170],
      [240, 170],
    ]);
  });

  it("enters the left side of a blocker in the same column", () => {
    const route = routeBlockerLine(card(0, 0), card(0, 2));
    expect(route.at(-1)).toEqual([0, 290]);
    expect(route.at(-2)).toEqual([-7, 290]);
  });

  it("keeps every run in the gap of a row or the gutter of a column", () => {
    const route = routeBlockerLine(card(0, 0), card(1, 1));
    const [start, down, along, up, end] = route;
    expect(start![0]).toBe(down![0]);
    expect(down![1]).toBe(along![1]);
    expect(along![0]).toBe(up![0]);
    expect(up![1]).toBe(end![1]);
  });
});

describe("a rounded path", () => {
  it("rounds each corner with a curve that starts and ends on its two runs", () => {
    expect(
      buildRoundedPath(
        [
          [0, 0],
          [0, 20],
          [30, 20],
        ],
        6,
      ),
    ).toBe("M0 0L0 14Q0 20 6 20L30 20");
  });

  it("rounds a corner by at most half the shorter run", () => {
    expect(
      buildRoundedPath(
        [
          [0, 0],
          [0, 4],
          [30, 4],
        ],
        6,
      ),
    ).toBe("M0 0L0 2Q0 4 6 4L30 4");
  });

  it("draws a straight line through two points", () => {
    expect(
      buildRoundedPath(
        [
          [1, 2],
          [3, 4],
        ],
        6,
      ),
    ).toBe("M1 2L3 4");
  });
});
