import { describe, expect, it } from "vitest";
import { frameShot, isLabelInView } from "./office-room";
import {
  buildMatrix,
  formatPoints,
  frameRegion,
  placeOnFloor,
  projectPoint,
  type Projection,
} from "./projection";

// The expected numbers come from running the Bureau book's office.js, frame()
// and P(), for a 1440 by 900 window: the room is framed 1240 pixels wide, a
// close shot 944, with 56 pixels to spare and a tile of 46 pixels at most.
describe("frameShot", () => {
  it.each([
    ["room", 30.57516931886365, 548.5070422535211, 182.46726845994306],
    ["your-desk", 32.90105657978566, 585.9726027397261, 51.89721538459355],
    ["wing", 46, -19.98902973999992, 67.05000000000001],
    ["triage", 46, 432.1628316, 307.4],
  ] as const)("frames the %s shot as the book does", (shot, tile, originX, originY) => {
    const projection = frameShot(1440, 900, shot);
    expect(projection.tile).toBeCloseTo(tile, 9);
    expect(projection.originX).toBeCloseTo(originX, 9);
    expect(projection.originY).toBeCloseTo(originY, 9);
  });
});

describe("frameRegion", () => {
  it("caps the tile at the largest size it is given", () => {
    const projection = frameRegion(4000, 4000, { x0: 0, x1: 1, y0: 0, y1: 1 }, 0, 46);
    expect(projection.tile).toBe(46);
  });

  it("centres the region on the stage", () => {
    const region = { x0: 2, x1: 6, y0: 1, y1: 3 };
    const projection = frameRegion(800, 600, region, 20, 1000);
    const left = projectPoint(projection, region.x0, region.y1)[0];
    const right = projectPoint(projection, region.x1, region.y0)[0];
    expect((left + right) / 2).toBeCloseTo(400, 9);
  });
});

describe("projectPoint", () => {
  const projection: Projection = { tile: 10, originX: 100, originY: 50 };

  it("lands the plan's origin on the projection's origin", () => {
    expect(projectPoint(projection, 0, 0)).toEqual([100, 50]);
  });

  it("moves a step along x right and down, along y left and down, and up z straight up", () => {
    expect(projectPoint(projection, 1, 0)).toEqual([100 + 8.660254, 55]);
    expect(projectPoint(projection, 0, 1)).toEqual([100 - 8.660254, 55]);
    expect(projectPoint(projection, 0, 0, 1)).toEqual([100, 40]);
  });
});

describe("formatting", () => {
  it("writes points with one decimal each", () => {
    expect(
      formatPoints([
        [1.25, 2],
        [3.04, -4.96],
      ]),
    ).toBe("1.3,2.0 3.0,-5.0");
  });

  it("writes a matrix's numbers rounded to three decimals, with no trailing zeros", () => {
    expect(buildMatrix(0.8660254, 0.5, -0.8660254, 0.5, [12.34567, 8])).toBe(
      "matrix(0.866 0.5 -0.866 0.5 12.346 8)",
    );
  });

  it("lays a drawing on the floor at its plan point", () => {
    const projection: Projection = { tile: 32, originX: 400, originY: 100 };
    expect(placeOnFloor(projection, 2, 1)).toBe("matrix(0.866 0.5 -0.866 0.5 427.713 148)");
  });
});

describe("isLabelInView", () => {
  it("keeps a label clear of the window's edges and of the card", () => {
    expect(isLabelInView(72, 72, 1440, 900)).toBe(true);
    expect(isLabelInView(944, 860, 1440, 900)).toBe(true);
    expect(isLabelInView(71, 400, 1440, 900)).toBe(false);
    expect(isLabelInView(945, 400, 1440, 900)).toBe(false);
    expect(isLabelInView(400, 71, 1440, 900)).toBe(false);
    expect(isLabelInView(400, 861, 1440, 900)).toBe(false);
  });
});
