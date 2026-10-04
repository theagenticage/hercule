/**
 * Tests where threads sit in the Office. The tests check that:
 *
 * - each project with threads has a room, in the order of the project list,
 *   and the threads with no project share the last room;
 * - a thread whose project is not in the project list sits in the room of
 *   the threads with no project;
 * - an Agent's sessions have no desk;
 * - desks are grouped by workspace, worktrees before the main workspace
 *   before the threads with no workspace, and oldest thread first inside a
 *   workspace;
 * - the queue holds the threads with an open Request, waiting longest first;
 * - the Lounge holds the idle threads;
 * - each desk's pose comes from `decideThreadPose`, with the thread's runner;
 * - asleep and away threads have no desk, so a project whose threads are all
 *   asleep has no room, but a waiting thread on an offline runner is seated.
 */
import { describe, expect, it } from "vitest";
import type { OpenRequest, Session } from "@hercule/contract";
import { POSES } from "../threads/pose";
import { decideOfficeSeating, isSeatedPose } from "./seating";
import {
  MOSS,
  OPS_PROJECT,
  PRIMARY,
  THREAD_3F1,
  WEBSHOP_PROJECT,
  buildRunner,
  buildSession,
} from "../threads/workspaces.testing";

const REQUEST: OpenRequest = {
  requestId: "req-1",
  itemId: "tool-1",
  kind: "command_approval",
  decisions: ["allow", "deny"],
  detail: { command: "git push" },
};

const buildTimestamp = (minute: number): string => `2026-09-10T09:0${String(minute)}:00.000Z`;

/** Returns the seating of `sessions` in the fixture world, with webshop listed before ops. */
const seat = (sessions: readonly Session[], runners = [MOSS]) =>
  decideOfficeSeating({
    sessions,
    projects: [WEBSHOP_PROJECT, OPS_PROJECT],
    workspaces: [PRIMARY, THREAD_3F1],
    runners,
  });

/** Returns each room's project id and the ids of its desks, in order. */
const listRooms = (sessions: readonly Session[]) =>
  seat(sessions).rooms.map((room) => ({
    projectId: room.projectId,
    name: room.name,
    desks: room.desks.map((desk) => desk.session.id),
  }));

describe("decideOfficeSeating", () => {
  it("gives each project with threads a room in project-list order, and the threads with no project the last room", () => {
    const rooms = listRooms([
      buildSession({ id: "s-loose" }),
      buildSession({ id: "s-keys", projectId: OPS_PROJECT.id, lastActivityAt: buildTimestamp(9) }),
      buildSession({ id: "s-bun", projectId: WEBSHOP_PROJECT.id }),
    ]);

    expect(rooms).toEqual([
      { projectId: WEBSHOP_PROJECT.id, name: "webshop", desks: ["s-bun"] },
      { projectId: OPS_PROJECT.id, name: "ops", desks: ["s-keys"] },
      { projectId: null, name: "No project", desks: ["s-loose"] },
    ]);
  });

  it("seats a thread whose project is not listed with the threads that have no project", () => {
    const rooms = listRooms([buildSession({ id: "s-orphan", projectId: "p-gone" })]);

    expect(rooms).toEqual([{ projectId: null, name: "No project", desks: ["s-orphan"] }]);
  });

  it("gives an Agent's sessions no desk", () => {
    const rooms = listRooms([
      buildSession({ id: "s-thread" }),
      buildSession({ id: "s-agent", agentId: "a-triage" }),
    ]);

    expect(rooms).toEqual([{ projectId: null, name: "No project", desks: ["s-thread"] }]);
  });

  it("groups desks by workspace in the sidebar's order, oldest thread first inside a workspace", () => {
    const inWebshop = (id: string, workspaceId: string | null, minute: number) =>
      buildSession({
        id,
        projectId: WEBSHOP_PROJECT.id,
        workspaceId,
        createdAt: buildTimestamp(minute),
      });
    const rooms = listRooms([
      inWebshop("s-no-workspace", null, 0),
      inWebshop("s-primary-new", PRIMARY.id, 4),
      inWebshop("s-primary-old", PRIMARY.id, 1),
      inWebshop("s-worktree-new", THREAD_3F1.id, 3),
      inWebshop("s-worktree-old", THREAD_3F1.id, 2),
    ]);

    expect(rooms[0]?.desks).toEqual([
      "s-worktree-old",
      "s-worktree-new",
      "s-primary-old",
      "s-primary-new",
      "s-no-workspace",
    ]);
  });

  it("queues the threads with an open Request, waiting longest first", () => {
    const { queue } = seat([
      buildSession({ id: "s-recent", openRequest: REQUEST, lastActivityAt: buildTimestamp(5) }),
      buildSession({ id: "s-calm", lastActivityAt: buildTimestamp(0) }),
      buildSession({ id: "s-long", openRequest: REQUEST, lastActivityAt: buildTimestamp(1) }),
    ]);

    expect(queue).toEqual(["s-long", "s-recent"]);
  });

  it("sends the idle threads to the Lounge, and they keep their desks", () => {
    const sessions = [
      buildSession({ id: "s-idle", status: "idle" }),
      buildSession({ id: "s-busy", status: "busy" }),
    ];

    const { lounge, rooms } = seat(sessions);

    expect(lounge).toEqual(["s-idle"]);
    expect(rooms[0]?.desks.map((desk) => desk.session.id)).toEqual(["s-busy", "s-idle"]);
  });

  it("takes each desk's pose from decideThreadPose, and seats no asleep or away thread", () => {
    const cove = { ...buildRunner("r-cove", "cove"), connectivity: "offline" as const };
    const { rooms, queue, lounge } = seat(
      [
        buildSession({ id: "s-asking", status: "busy", openRequest: REQUEST, runnerId: cove.id }),
        buildSession({ id: "s-asleep", status: "exited", resumable: true }),
        buildSession({ id: "s-away", status: "idle", runnerId: cove.id }),
        buildSession({ id: "s-busy", status: "busy" }),
      ],
      [MOSS, cove],
    );

    expect(rooms[0]?.desks.map((desk) => [desk.session.id, desk.pose])).toEqual([
      ["s-asking", "waiting"],
      ["s-busy", "working"],
    ]);
    expect(queue).toEqual(["s-asking"]);
    expect(lounge).toEqual([]);
  });

  it("gives no room to a project whose threads are all asleep", () => {
    const rooms = listRooms([
      buildSession({ id: "s-bun", projectId: WEBSHOP_PROJECT.id, status: "busy" }),
      buildSession({ id: "s-keys", projectId: OPS_PROJECT.id, status: "exited", resumable: true }),
    ]);

    expect(rooms).toEqual([{ projectId: WEBSHOP_PROJECT.id, name: "webshop", desks: ["s-bun"] }]);
  });
});

describe("isSeatedPose", () => {
  it("seats the working, waiting and idle poses, and no other", () => {
    expect(POSES.filter(isSeatedPose)).toEqual(["working", "waiting", "idle"]);
  });
});
