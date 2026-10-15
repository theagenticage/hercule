/**
 * Tests where sessions sit in the Office. The tests check that:
 *
 * - each project with threads has a room, in the order of the project list,
 *   and the threads with no project share the last room;
 * - a thread whose project is not in the project list sits in the room of
 *   the threads with no project;
 * - an assistant's session has no desk;
 * - desks are grouped by workspace, worktrees before the main workspace
 *   before the threads with no workspace, and oldest thread first inside a
 *   workspace;
 * - the queue holds the threads with an open Request, waiting longest first;
 * - the Lounge holds the idle threads;
 * - each desk's pose comes from `decideThreadPose`, with the thread's runner;
 * - asleep and away threads have no desk, so a project whose threads are all
 *   asleep has no room, but a waiting thread on an offline runner is seated;
 * - every assistant has a corner in the Secretariat in every pose, even with
 *   no session, in the sidebar's order whatever order the rows come in, and
 *   never joins a room or the Lounge;
 * - a waiting assistant queues by its own id, among the waiting threads,
 *   waiting longest first;
 * - a thread marked Done leaves, unless it waits on the user;
 * - an agent step's session sits in its project's room, on the agent steps'
 *   aisle beside its run's other sessions, in any pose while its run is
 *   live, rests in the Lounge once its step is done, and leaves with its
 *   run;
 * - another Agent's session sits on the agents' aisle while it is at work;
 * - a session with no project of its own sits in the room of the project
 *   all its workspace's repos share, the first listed when several do.
 */
import { describe, expect, it } from "vitest";
import type { OpenRequest, RunSummary, Session } from "@hercule/contract";
import { buildAssistantRows, type AssistantRow } from "../assistants/rows";
import { POSES } from "../threads/pose";
import {
  decideAgentStepPose,
  decideOfficeSeating,
  isThreadSeated,
  type OfficeDesk,
  type OfficeRoom,
} from "./seating";
import {
  AT,
  INFRA,
  MOSS,
  OPS_PROJECT,
  PRIMARY,
  RUNBOOKS,
  THREAD_3F1,
  WEBSHOP,
  WEBSHOP_PROJECT,
  buildCheckout,
  buildRunner,
  buildSession,
  buildWorkspace,
} from "../threads/workspaces.testing";

const REQUEST: OpenRequest = {
  requestId: "req-1",
  itemId: "tool-1",
  kind: "command_approval",
  decisions: ["allow", "deny"],
  detail: { command: "git push" },
};

const buildTimestamp = (minute: number): string => `2026-09-10T09:0${String(minute)}:00.000Z`;

/** A workspace of a run with a checkout of each of `resourceIds`. */
const buildRunWorkspace = (id: string, resourceIds: readonly string[]) =>
  buildWorkspace({
    id,
    kind: "ephemeral",
    checkouts: resourceIds.map((resourceId) => buildCheckout(resourceId, `run/${id}`)),
  });

/** A run's workspace with webshop checked out, so its sessions sit in webshop's room. */
const WEBSHOP_RUN_WORKSPACE = buildRunWorkspace("ws-run-webshop", [WEBSHOP.id]);
/** A run's workspace with both of ops' repos checked out. */
const OPS_RUN_WORKSPACE = buildRunWorkspace("ws-run-ops", [INFRA.id, RUNBOOKS.id]);
/** A run's workspace with a repo of webshop and a repo of ops, which share no project. */
const MIXED_RUN_WORKSPACE = buildRunWorkspace("ws-run-mixed", [WEBSHOP.id, INFRA.id]);

/** Returns a running run created at `minute`. */
const buildRun = (id: string, minute = 0): RunSummary => ({
  id,
  workflowId: "wf-review",
  workflowName: "Review",
  origin: { kind: "manual", actor: "user" },
  createdAt: buildTimestamp(minute),
  status: "running",
  startedAt: buildTimestamp(minute),
  activeStepIds: [],
  awaitedSignalIds: [],
});

/** Returns the session of the agent step `stepId` of the run `runId`. */
const buildStepSession = (id: string, runId: string, over: Partial<Session> = {}): Session =>
  buildSession({
    id,
    agentId: "a-reviewer",
    runId,
    stepId: "review",
    workspaceId: WEBSHOP_RUN_WORKSPACE.id,
    ...over,
  });

/** Returns the seating of `sessions` in the fixture world, with webshop listed before ops. */
const seat = (
  sessions: readonly Session[],
  runners = [MOSS],
  assistants: readonly AssistantRow[] = [],
  liveRuns: readonly RunSummary[] = [],
) =>
  decideOfficeSeating({
    sessions,
    liveRuns,
    projects: [WEBSHOP_PROJECT, OPS_PROJECT],
    workspaces: [
      PRIMARY,
      THREAD_3F1,
      WEBSHOP_RUN_WORKSPACE,
      OPS_RUN_WORKSPACE,
      MIXED_RUN_WORKSPACE,
    ],
    resources: [WEBSHOP, INFRA, RUNBOOKS],
    runners,
    assistants,
  });

/** Returns every desk of a room, aisle after aisle. */
const listDesks = (room: OfficeRoom | undefined): readonly OfficeDesk[] =>
  room?.aisles.flatMap((aisle) => aisle.desks) ?? [];

/** Returns the current session of the main conversation of the assistant `assistantId`. */
const buildAssistantSession = (assistantId: string, over: Partial<Session> = {}): Session =>
  buildSession({
    id: `s-${assistantId}`,
    agentId: assistantId,
    conversationId: `c-${assistantId}`,
    ...over,
  });

/** Returns each room's project id and the ids of its desks, in order. */
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

  it("gives an assistant's session no desk", () => {
    const rooms = listRooms([
      buildSession({ id: "s-thread" }),
      buildAssistantSession("a-wren", { status: "busy" }),
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

  it("takes each desk's pose from decideThreadPose, and seats no asleep or away thread", () => {
    const cove = { ...buildRunner("r-cove", "cove"), connectivity: "offline" as const };
    const { rooms, queue, lounge } = seat(
      [
        buildSession({
          id: "s-asking",
          status: "busy",
          openRequests: [REQUEST],
          runnerId: cove.id,
        }),
        buildSession({ id: "s-asleep", status: "exited", resumable: true }),
        buildSession({ id: "s-away", status: "idle", runnerId: cove.id }),
        buildSession({ id: "s-busy", status: "busy" }),
      ],
      [MOSS, cove],
    );

    expect(listDesks(rooms[0]).map((desk) => [desk.session.id, desk.pose])).toEqual([
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

describe("decideOfficeSeating with Done threads", () => {
  const done = { at: AT, by: "user" as const };

  it("seats no thread marked Done, unless it waits on the user", () => {
    const { rooms, queue } = seat([
      buildSession({ id: "s-done-idle", status: "idle", done }),
      buildSession({ id: "s-done-busy", status: "busy", done }),
      buildSession({ id: "s-done-asking", status: "busy", openRequests: [REQUEST], done }),
      buildSession({ id: "s-open", status: "idle" }),
    ]);

    expect(listDesks(rooms[0]).map((desk) => desk.session.id)).toEqual(["s-done-asking", "s-open"]);
    expect(queue).toEqual(["s-done-asking"]);
  });
});

describe("isThreadSeated", () => {
  it("seats a thread working, waiting or idle, and no other pose", () => {
    expect(POSES.filter((pose) => isThreadSeated(pose, false))).toEqual([
      "working",
      "waiting",
      "idle",
    ]);
  });

  it("seats a thread marked Done only while it waits on the user", () => {
    expect(POSES.filter((pose) => isThreadSeated(pose, true))).toEqual(["waiting"]);
  });
});

describe("decideOfficeSeating with the sessions of runs", () => {
  const cove = { ...buildRunner("r-cove", "cove"), connectivity: "offline" as const };

  it("seats each session of a live run in any pose, and rests a finished step in the Lounge", () => {
    const { rooms, queue, lounge } = seat(
      [
        buildStepSession("s-busy", "run-1", { status: "busy", createdAt: buildTimestamp(1) }),
        buildStepSession("s-asking", "run-1", {
          status: "busy",
          openRequests: [REQUEST],
          createdAt: buildTimestamp(2),
        }),
        buildStepSession("s-finished", "run-1", {
          status: "exited",
          createdAt: buildTimestamp(3),
        }),
        buildStepSession("s-offline", "run-1", {
          status: "idle",
          runnerId: cove.id,
          createdAt: buildTimestamp(4),
        }),
      ],
      [MOSS, cove],
      [],
      [buildRun("run-1")],
    );

    expect(rooms.map((room) => room.projectId)).toEqual([WEBSHOP_PROJECT.id]);
    expect(listDesks(rooms[0]).map((desk) => [desk.session.id, desk.kind, desk.pose])).toEqual([
      ["s-busy", "agent-step", "working"],
      ["s-asking", "agent-step", "waiting"],
      ["s-finished", "agent-step", "done"],
      ["s-offline", "agent-step", "away"],
    ]);
    expect(queue).toEqual(["s-asking"]);
    expect(lounge).toEqual(["s-finished"]);
  });

  it("seats no session of a run that is not live, so a run's sessions leave together", () => {
    const { rooms } = seat(
      [
        buildStepSession("s-ended-run", "run-ended", { status: "busy" }),
        buildStepSession("s-live-run", "run-live", { status: "busy" }),
      ],
      [MOSS],
      [],
      [buildRun("run-live")],
    );

    expect(rooms.flatMap(listDesks).map((desk) => desk.session.id)).toEqual(["s-live-run"]);
  });

  it("seats each run's sessions side by side, the oldest run first", () => {
    const { rooms } = seat(
      [
        buildStepSession("s-new-run-a", "run-new", { createdAt: buildTimestamp(1) }),
        buildStepSession("s-old-run-b", "run-old", { createdAt: buildTimestamp(3) }),
        buildStepSession("s-new-run-b", "run-new", { createdAt: buildTimestamp(4) }),
        buildStepSession("s-old-run-a", "run-old", { createdAt: buildTimestamp(2) }),
      ],
      [MOSS],
      [],
      [buildRun("run-new", 1), buildRun("run-old", 0)],
    );

    expect(listDesks(rooms[0]).map((desk) => desk.session.id)).toEqual([
      "s-old-run-a",
      "s-old-run-b",
      "s-new-run-a",
      "s-new-run-b",
    ]);
  });

  it("splits a room into aisles: threads, then agent steps, then other Agents' sessions", () => {
    const { rooms } = seat(
      [
        buildSession({
          id: "s-agent",
          agentId: "a-triage",
          projectId: WEBSHOP_PROJECT.id,
          status: "busy",
        }),
        buildStepSession("s-step", "run-1", { status: "busy" }),
        buildSession({ id: "s-thread", projectId: WEBSHOP_PROJECT.id, status: "busy" }),
      ],
      [MOSS],
      [],
      [buildRun("run-1")],
    );

    expect(
      rooms[0]?.aisles.map((aisle) => [aisle.kind, aisle.desks.map((desk) => desk.session.id)]),
    ).toEqual([
      ["thread", ["s-thread"]],
      ["agent-step", ["s-step"]],
      ["agent", ["s-agent"]],
    ]);
  });

  it("seats another Agent's session while it is at work, and not once it has exited", () => {
    const { rooms, lounge } = seat([
      buildSession({ id: "s-at-work", agentId: "a-triage", status: "idle" }),
      buildSession({ id: "s-exited", agentId: "a-triage", status: "exited", resumable: true }),
    ]);

    expect(listDesks(rooms[0]).map((desk) => [desk.session.id, desk.kind])).toEqual([
      ["s-at-work", "agent"],
    ]);
    expect(lounge).toEqual(["s-at-work"]);
  });

  it("seats a session with no project in the room of the project its workspace's repos share", () => {
    const { rooms } = seat(
      [
        buildStepSession("s-ops", "run-1", { workspaceId: OPS_RUN_WORKSPACE.id }),
        buildStepSession("s-mixed", "run-1", { workspaceId: MIXED_RUN_WORKSPACE.id }),
        buildStepSession("s-scratch", "run-1", { workspaceId: null }),
        buildStepSession("s-unknown", "run-1", { workspaceId: "ws-not-read-yet" }),
      ],
      [MOSS],
      [],
      [buildRun("run-1")],
    );

    expect(
      rooms.map((room) => [room.projectId, listDesks(room).map((desk) => desk.session.id)]),
    ).toEqual([
      [OPS_PROJECT.id, ["s-ops"]],
      [null, ["s-mixed", "s-scratch", "s-unknown"]],
    ]);
  });

  it("seats a session whose repos are in several projects in the first project listed", () => {
    const sharedRepo = { ...INFRA, projectIds: [OPS_PROJECT.id, WEBSHOP_PROJECT.id] };
    const { rooms } = decideOfficeSeating({
      sessions: [buildStepSession("s-shared", "run-1", { workspaceId: OPS_RUN_WORKSPACE.id })],
      liveRuns: [buildRun("run-1")],
      projects: [WEBSHOP_PROJECT, OPS_PROJECT],
      workspaces: [buildRunWorkspace(OPS_RUN_WORKSPACE.id, [sharedRepo.id])],
      resources: [sharedRepo],
      runners: [MOSS],
      assistants: [],
    });

    expect(rooms.map((room) => room.projectId)).toEqual([WEBSHOP_PROJECT.id]);
  });
});

describe("decideAgentStepPose", () => {
  it("is waiting with an open Request, done once exited, and a thread's pose otherwise", () => {
    const pose = (over: Partial<Session>) =>
      decideAgentStepPose(buildStepSession("s-step", "run-1", over), MOSS);

    expect(pose({ status: "busy", openRequests: [REQUEST] })).toBe("waiting");
    expect(pose({ status: "exited", resumable: true })).toBe("done");
    expect(pose({ status: "exited" })).toBe("done");
    expect(pose({ status: "busy" })).toBe("working");
    expect(pose({ status: "idle" })).toBe("idle");
  });
});
