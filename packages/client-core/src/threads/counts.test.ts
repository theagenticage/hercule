/**
 * Tests `countThreadsByPose`, which counts the threads for the line at the
 * foot of the sidebar.
 */
import { describe, expect, it } from "vitest";
import { countThreadsByPose } from "./counts";

describe("countThreadsByPose", () => {
  it("counts the working, waiting and idle threads", () => {
    expect(
      countThreadsByPose(["working", "waiting", "idle", "working", "idle", "idle", "waiting"]),
    ).toEqual({ working: 2, waiting: 2, idle: 3 });
  });

  it("does not count asleep or away threads", () => {
    expect(countThreadsByPose(["asleep", "away", "asleep", "idle"])).toEqual({
      working: 0,
      waiting: 0,
      idle: 1,
    });
  });

  it("returns zero for every part when there are no threads", () => {
    expect(countThreadsByPose([])).toEqual({ working: 0, waiting: 0, idle: 0 });
  });
});
