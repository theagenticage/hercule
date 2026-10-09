/**
 * Tests the order in which the Office walks through its colleagues. The
 * tests check that:
 *
 * - the colleagues in a pose come in the world's order;
 * - the waiting colleagues come in the queue's order, the longest waiting
 *   first, whatever the order of their desks, with waiting assistants among
 *   the threads;
 * - the pose the sim holds now wins over the world's;
 * - a step wraps at both ends, and starts at an end when nothing is selected.
 */
import { describe, expect, it } from "vitest";
import type { OpenRequest, Session } from "@hercule/contract";
import { MOSS, buildSession } from "@hercule/client-core/threads/testing";
import type { ColleagueState } from "../engine/contracts";
import { buildWorld } from "../world/build-world";
import { findNextColleagueId, listColleaguesInPose } from "./office-keys";

const REQUEST: OpenRequest = {
  requestId: "req-1",
  itemId: "tool-1",
  kind: "command_approval",
  decisions: ["allow", "deny"],
  detail: { command: "git push" },
};

/** Returns a thread on moss with id `id` and the fields in `over`. */
const buildThread = (id: string, over: Partial<Session> = {}): Session =>
  buildSession({ id, runnerId: MOSS.id, ...over });

/** Returns a thread that has waited on `REQUEST` since `lastActivityAt`. */
const buildAsking = (id: string, lastActivityAt: string): Session =>
  buildThread(id, { status: "busy", openRequests: [REQUEST], lastActivityAt });

// Desks are in creation order, then by id, so s-a's desk comes first. s-b
// started waiting first, so it queues first.
const WORLD = buildWorld({
  sessions: [
    buildAsking("s-a", "2026-09-10T10:00:00.000Z"),
    buildAsking("s-b", "2026-09-10T09:00:00.000Z"),
    buildThread("s-c", { status: "busy" }),
    buildThread("s-d", { status: "busy" }),
  ],
  projects: [],
  workspaces: [],
  runners: [MOSS],
  assistants: [],
  localRunnerId: MOSS.id,
});

/** Returns the ids of `colleagues`, in order. */
const listIds = (colleagues: ReadonlyArray<{ readonly id: string }>) =>
  colleagues.map((colleague) => colleague.id);

describe("listColleaguesInPose", () => {
  it("returns the colleagues in a pose in the world's order", () => {
    expect(listIds(listColleaguesInPose(WORLD, new Map(), "working"))).toEqual(["s-c", "s-d"]);
  });

  it("returns the waiting colleagues in the queue's order, the longest waiting first", () => {
    expect(listIds(listColleaguesInPose(WORLD, new Map(), "waiting"))).toEqual(["s-b", "s-a"]);
  });

  it("puts a waiting assistant among the waiting threads, by how long it has waited", () => {
    const world = buildWorld({
      sessions: [
        buildAsking("s-a", "2026-09-10T10:00:00.000Z"),
        buildAsking("s-b", "2026-09-10T09:00:00.000Z"),
      ],
      projects: [],
      workspaces: [],
      runners: [MOSS],
      assistants: [
        {
          id: "a-1",
          name: "Ada",
          pose: "waiting",
          session: buildAsking("s-ada", "2026-09-10T09:30:00.000Z"),
        },
      ],
      localRunnerId: MOSS.id,
    });

    expect(listIds(listColleaguesInPose(world, new Map(), "waiting"))).toEqual([
      "s-b",
      "a-1",
      "s-a",
    ]);
  });

  it("takes the pose the sim holds now, and puts a waiting colleague the queue lacks last", () => {
    const states = new Map<string, ColleagueState>([
      ["s-c", { pose: "waiting", stateLabel: "waiting on you", request: null }],
    ]);

    expect(listIds(listColleaguesInPose(WORLD, states, "waiting"))).toEqual(["s-b", "s-a", "s-c"]);
    expect(listIds(listColleaguesInPose(WORLD, states, "working"))).toEqual(["s-d"]);
  });
});

describe("findNextColleagueId", () => {
  const colleagues = WORLD.colleagues;

  it("steps forward and back, wrapping at both ends", () => {
    expect(listIds(colleagues)).toEqual(["s-a", "s-b", "s-c", "s-d"]);
    expect(findNextColleagueId(colleagues, "s-a", 1)).toBe("s-b");
    expect(findNextColleagueId(colleagues, "s-d", 1)).toBe("s-a");
    expect(findNextColleagueId(colleagues, "s-a", -1)).toBe("s-d");
  });

  it("starts at the first going forward and the last going back when nothing is selected", () => {
    expect(findNextColleagueId(colleagues, null, 1)).toBe("s-a");
    expect(findNextColleagueId(colleagues, null, -1)).toBe("s-d");
  });

  it("returns null when there is nobody to step to", () => {
    expect(findNextColleagueId([], null, 1)).toBeNull();
  });
});
