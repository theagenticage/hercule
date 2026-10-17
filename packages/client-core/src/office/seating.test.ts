/**
 * Tests where the work in progress and the assistants sit in the Office.
 * The tests check that:
 *
 * - each project with work has a room, in the order of the project list,
 *   and the work with no project shares the last room;
 * - a thread whose project is not in the project list sits in the room of
 *   the work with no project;
 * - work in the same working copy sits side by side, worktrees before the
 *   main workspace before the work with no workspace, and oldest first
 *   inside a working copy, a run's sessions together;
 * - the queue holds the sessions with an open Request, waiting longest
 *   first, a run's sessions among them;
 * - the Lounge holds the resting sessions, idle or done;
 * - an asleep thread keeps its desk and stays out of the Lounge;
 * - every assistant has a corner in the Secretariat in every pose, even with
 *   no session, in the sidebar's order whatever order the rows come in, and
 *   never joins a room or the Lounge;
 * - a waiting assistant queues by its own id, among the waiting threads,
 *   waiting longest first.
 */
import { describe, expect, it } from "vitest";
import type { RunSummary, Session } from "@hercule/contract";
import { buildAssistantRows, type AssistantRow } from "../assistants/rows";
import { decideOfficeSeating, type OfficeRoom } from "./seating";
import type { Worker } from "./work";
import {
  MOSS,
  OPS_PROJECT,
  PRIMARY,
  THREAD_3F1,
  WEBSHOP_PROJECT,
  buildRunner,
  buildSession,
} from "../threads/workspaces.testing";
import {
  OFFICE_WORKSPACES,
  REQUEST,
  buildAssistantSession,
  buildRun,
  buildStepSession,
  buildTimestamp,
  listFixtureWork,
} from "./work.testing";

/** Returns the seating of `sessions` in the fixture world, with webshop listed before ops. */
const seat = (
  sessions: readonly Session[],
  runners = [MOSS],
  assistants: readonly AssistantRow[] = [],
  liveRuns: readonly RunSummary[] = [],
) =>
  decideOfficeSeating({
    work: listFixtureWork(sessions, liveRuns, runners),
    projects: [WEBSHOP_PROJECT, OPS_PROJECT],
    workspaces: OFFICE_WORKSPACES,
    assistants,
  });

/** Returns every session at work in a room, piece of work after piece of work. */
const listDesks = (room: OfficeRoom | undefined): readonly Worker[] =>
  room?.work.flatMap((piece) => piece.workers) ?? [];

/** Returns each room's project id and the ids of its sessions, in order. */
const listRooms = (sessions: readonly Session[]) =>
  seat(sessions).rooms.map((room) => ({
    projectId: room.projectId,
    name: room.name,
    desks: listDesks(room).map((desk) => desk.session.id),
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

  it("groups work by working copy in the sidebar's order, oldest first inside a working copy", () => {
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
      buildSession({ id: "s-recent", openRequests: [REQUEST], lastActivityAt: buildTimestamp(5) }),
      buildSession({ id: "s-calm", lastActivityAt: buildTimestamp(0) }),
      buildSession({ id: "s-long", openRequests: [REQUEST], lastActivityAt: buildTimestamp(1) }),
    ]);

    expect(queue).toEqual(["s-long", "s-recent"]);
  });

  it("queues a thread whose only open Request a subagent asked, in its place, with the waiting pose", () => {
    const { queue, rooms } = seat([
      buildSession({ id: "s-recent", openRequests: [REQUEST], lastActivityAt: buildTimestamp(5) }),
      buildSession({
        id: "s-subagent",
        status: "busy",
        openRequests: [{ ...REQUEST, requestId: "req-2", subagentId: "agent-1" }],
        lastActivityAt: buildTimestamp(3),
      }),
      buildSession({ id: "s-long", openRequests: [REQUEST], lastActivityAt: buildTimestamp(1) }),
    ]);

    expect(queue).toEqual(["s-long", "s-subagent", "s-recent"]);
    expect(rooms.flatMap(listDesks).find((desk) => desk.session.id === "s-subagent")?.pose).toBe(
      "waiting",
    );
  });

  it("sends the idle threads to the Lounge, and they keep their desks", () => {
    const sessions = [
      buildSession({ id: "s-idle", status: "idle" }),
      buildSession({ id: "s-busy", status: "busy" }),
    ];

    const { lounge, rooms } = seat(sessions);

    expect(lounge).toEqual(["s-idle"]);
    expect(listDesks(rooms[0]).map((desk) => desk.session.id)).toEqual(["s-busy", "s-idle"]);
  });

  it("seats an asleep thread at its desk, not in the Lounge", () => {
    const sessions = [
      buildSession({ id: "s-bun", projectId: WEBSHOP_PROJECT.id, status: "busy" }),
      buildSession({ id: "s-keys", projectId: OPS_PROJECT.id, status: "exited", resumable: true }),
    ];

    expect(listRooms(sessions)).toEqual([
      { projectId: WEBSHOP_PROJECT.id, name: "webshop", desks: ["s-bun"] },
      { projectId: OPS_PROJECT.id, name: "ops", desks: ["s-keys"] },
    ]);
    expect(seat(sessions).lounge).toEqual([]);
  });
});

describe("decideOfficeSeating with assistants", () => {
  const cove = { ...buildRunner("r-cove", "cove"), connectivity: "offline" as const };
  const ASSISTANTS = [
    { id: "a-working", name: "Wren" },
    { id: "a-waiting", name: "Ada" },
    { id: "a-idle", name: "Otto" },
    { id: "a-asleep", name: "Mila" },
    { id: "a-away", name: "Bea" },
    { id: "a-new", name: "Cleo" },
  ];
  const sessions = [
    buildAssistantSession("a-working", { status: "busy" }),
    buildAssistantSession("a-waiting", { status: "busy", openRequests: [REQUEST] }),
    buildAssistantSession("a-idle", { status: "idle" }),
    buildAssistantSession("a-asleep", { status: "exited", resumable: true }),
    buildAssistantSession("a-away", { status: "idle", runnerId: cove.id }),
  ];
  const rows = buildAssistantRows(
    ASSISTANTS,
    new Map(sessions.map((session) => [session.agentId!, session])),
    [MOSS, cove],
  );

  it("gives every assistant a corner in the Secretariat in every pose, in the sidebar's order", () => {
    const { secretariat } = seat(sessions, [MOSS, cove], [...rows].reverse());

    expect(secretariat.map((row) => [row.id, row.pose])).toEqual([
      ["a-waiting", "waiting"],
      ["a-away", "away"],
      ["a-new", "idle"],
      ["a-asleep", "asleep"],
      ["a-idle", "idle"],
      ["a-working", "working"],
    ]);
  });

  it("seats an assistant with no session yet as idle, and does not queue it", () => {
    const { secretariat, queue } = seat(
      [],
      [MOSS],
      buildAssistantRows(ASSISTANTS.slice(-1), new Map(), [MOSS]),
    );

    expect(secretariat).toEqual([{ id: "a-new", name: "Cleo", pose: "idle", session: null }]);
    expect(queue).toEqual([]);
  });

  it("gives an assistant no room and no place in the Lounge, whatever its pose", () => {
    const { rooms, lounge } = seat(sessions, [MOSS, cove], rows);

    expect(rooms).toEqual([]);
    expect(lounge).toEqual([]);
  });

  it("queues a waiting assistant by its own id, among the waiting threads, waiting longest first", () => {
    const assistantRows = buildAssistantRows(
      [
        { id: "a-ada", name: "Ada" },
        { id: "a-bea", name: "Bea" },
      ],
      new Map([
        [
          "a-ada",
          buildAssistantSession("a-ada", {
            openRequests: [REQUEST],
            lastActivityAt: buildTimestamp(2),
          }),
        ],
        [
          "a-bea",
          buildAssistantSession("a-bea", {
            openRequests: [REQUEST],
            lastActivityAt: buildTimestamp(1),
          }),
        ],
      ]),
      [MOSS],
    );

    const { queue } = seat(
      [
        buildSession({
          id: "s-recent",
          openRequests: [REQUEST],
          lastActivityAt: buildTimestamp(3),
        }),
        buildSession({ id: "s-long", openRequests: [REQUEST], lastActivityAt: buildTimestamp(0) }),
        buildSession({ id: "s-tie", openRequests: [REQUEST], lastActivityAt: buildTimestamp(1) }),
      ],
      [MOSS],
      assistantRows,
    );

    // The thread s-tie and the assistant a-bea waited equally long, so ids decide.
    expect(queue).toEqual(["s-long", "a-bea", "s-tie", "a-ada", "s-recent"]);
  });
});

describe("decideOfficeSeating with runs", () => {
  it("seats a run's sessions together, beside the threads of other working copies", () => {
    const { rooms, queue, lounge } = seat(
      [
        buildSession({ id: "s-thread", projectId: WEBSHOP_PROJECT.id, workspaceId: PRIMARY.id }),
        buildStepSession("s-review", "run-1", {
          status: "busy",
          openRequests: [REQUEST],
          createdAt: buildTimestamp(2),
        }),
        buildStepSession("s-plan", "run-1", { status: "exited", createdAt: buildTimestamp(1) }),
      ],
      [MOSS],
      [],
      [buildRun("run-1")],
    );

    expect(rooms.map((room) => room.work.map((piece) => piece.id))).toEqual([
      ["run-1", "s-thread"],
    ]);
    expect(listDesks(rooms[0]).map((desk) => desk.session.id)).toEqual([
      "s-plan",
      "s-review",
      "s-thread",
    ]);
    expect(queue).toEqual(["s-review"]);
    expect(lounge).toEqual(["s-plan", "s-thread"]);
  });
});
