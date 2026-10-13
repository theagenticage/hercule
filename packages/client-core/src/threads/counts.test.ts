/**
 * Tests `countThreadsByPose`, which counts the threads for the line at the
 * foot of the sidebar.
 */
import { describe, expect, it } from "vitest";
import type { Session } from "@hercule/contract";
import { countThreadsByPose } from "./counts";
import type { Pose } from "./pose";
import { buildSession } from "./workspaces.testing";

/** Returns one thread per pose, with ids `t0`, `t1` and so on, and the poses by id. */
const buildThreads = (
  poses: readonly Pose[],
  over: (index: number) => Partial<Session> = () => ({}),
): { threads: readonly Session[]; poses: ReadonlyMap<string, Pose> } => ({
  threads: poses.map((_, index) => buildSession({ id: `t${String(index)}`, ...over(index) })),
  poses: new Map(poses.map((pose, index) => [`t${String(index)}`, pose])),
});

describe("countThreadsByPose", () => {
  it("counts the working, waiting and idle threads", () => {
    const { threads, poses } = buildThreads([
      "working",
      "waiting",
      "idle",
      "working",
      "idle",
      "idle",
      "waiting",
    ]);
    expect(countThreadsByPose(threads, poses)).toEqual({ working: 2, waiting: 2, idle: 3 });
  });

  it("does not count asleep or away threads", () => {
    const { threads, poses } = buildThreads(["asleep", "away", "asleep", "idle"]);
    expect(countThreadsByPose(threads, poses)).toEqual({ working: 0, waiting: 0, idle: 1 });
  });

  it("does not count threads marked Done, even one that waits", () => {
    const done = { done: { at: "2026-10-13T09:00:00.000Z", by: "user" } } as const;
    const { threads, poses } = buildThreads(["idle", "waiting", "idle", "working"], (index) =>
      index < 2 ? done : {},
    );
    expect(countThreadsByPose(threads, poses)).toEqual({ working: 1, waiting: 0, idle: 1 });
  });

  it("returns zero for every part when there are no threads", () => {
    expect(countThreadsByPose([], new Map())).toEqual({ working: 0, waiting: 0, idle: 0 });
  });
});
