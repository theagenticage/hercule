import { describe, expect, it } from "vitest";
import { computeTaskPaneRect } from "./task-pane-rect";

describe("computeTaskPaneRect", () => {
  it("is 468 wide, 14 from the right, from 58 down to 14 from the bottom, in window pixels", () => {
    expect(computeTaskPaneRect({ left: 271, top: 0, width: 1169, height: 900 })).toEqual({
      left: 271 + 1169 - 468 - 14,
      top: 58,
      width: 468,
      height: 900 - 58 - 14,
    });
  });

  it("leaves 40 beside a desk too narrow for it", () => {
    expect(computeTaskPaneRect({ left: 0, top: 0, width: 400, height: 700 })).toMatchObject({
      left: 400 - 360 - 14,
      width: 360,
    });
  });
});
