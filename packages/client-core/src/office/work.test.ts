/**
 * Tests the work in progress the Office draws. The tests check that:
 *
 * - a Thread is work in every pose, asleep and away included, until it is
 *   marked Done, unless it waits on the user;
 * - a live Run is one piece of work with every session of its agent steps,
 *   in any pose, a finished one `done`, and is gone once the run ends;
 * - an Agent's session outside a run is work while it is at work, and not
 *   once it has exited;
 * - an assistant's session is no work;
 * - work is listed oldest first, whatever the order of the sessions;
 * - a run's work belongs to the project all its workspace's repos share, the
 *   first listed when several do, and to none otherwise.
 */
import { describe, expect, it } from "vitest";
import type { Session } from "@hercule/contract";
import { POSES } from "../threads/pose";
import {
  AT,
  INFRA,
  MOSS,
  OPS_PROJECT,
  WEBSHOP_PROJECT,
  buildRunner,
  buildSession,
} from "../threads/workspaces.testing";
import {
  MIXED_RUN_WORKSPACE,
  OPS_RUN_WORKSPACE,
  REQUEST,
  buildAssistantSession,
  buildRun,
  buildRunWorkspace,
  buildStepSession,
  buildTimestamp,
  listFixtureWork,
} from "./work.testing";
import { isThreadSeated, listLiveWork } from "./work";

/** Returns each piece of work as its kind, its id, and its workers' ids and poses. */
const describeWork = (
  sessions: readonly Session[],
  ...rest: Parameters<typeof listFixtureWork> extends [unknown, ...infer R] ? R : never
) =>
  listFixtureWork(sessions, ...rest).map((piece) => [
    piece.kind,
    piece.id,
    piece.workers.map((worker) => [worker.session.id, worker.pose]),
  ]);

const cove = { ...buildRunner("r-cove", "cove"), connectivity: "offline" as const };

describe("listLiveWork with Threads", () => {
  it("lists a Thread in every pose, asleep and away included", () => {
    expect(
      describeWork(
        [
          buildSession({ id: "s-busy", status: "busy" }),
          buildSession({
            id: "s-asking",
            status: "busy",
            openRequests: [REQUEST],
            runnerId: cove.id,
          }),
          buildSession({ id: "s-idle", status: "idle" }),
          buildSession({ id: "s-asleep", status: "exited", resumable: true }),
          buildSession({ id: "s-away", status: "idle", runnerId: cove.id }),
        ],
        [],
        [MOSS, cove],
      ),
    ).toEqual([
      ["thread", "s-asking", [["s-asking", "waiting"]]],
      ["thread", "s-asleep", [["s-asleep", "asleep"]]],
      ["thread", "s-away", [["s-away", "away"]]],
      ["thread", "s-busy", [["s-busy", "working"]]],
      ["thread", "s-idle", [["s-idle", "idle"]]],
    ]);
  });

  it("lists no Thread marked Done, unless it waits on the user", () => {
    const done = { at: AT, by: "user" as const };

    expect(
      describeWork([
        buildSession({ id: "s-done-idle", status: "idle", done }),
        buildSession({ id: "s-done-busy", status: "busy", done }),
        buildSession({ id: "s-done-asking", status: "busy", openRequests: [REQUEST], done }),
      ]).map(([, id]) => id),
    ).toEqual(["s-done-asking"]);
  });
});

describe("listLiveWork with Runs", () => {
  it("lists a live run as one piece of work with every session, a finished one done", () => {
    expect(
      describeWork(
        [
          buildStepSession("s-finished", "run-1", {
            status: "exited",
            createdAt: buildTimestamp(1),
          }),
          buildStepSession("s-asking", "run-1", {
            status: "busy",
            openRequests: [REQUEST],
            createdAt: buildTimestamp(3),
          }),
          buildStepSession("s-busy", "run-1", { status: "busy", createdAt: buildTimestamp(2) }),
          buildStepSession("s-offline", "run-1", {
            status: "idle",
            runnerId: cove.id,
            createdAt: buildTimestamp(4),
          }),
        ],
        [buildRun("run-1")],
        [MOSS, cove],
      ),
    ).toEqual([
      [
        "run",
        "run-1",
        [
          ["s-finished", "done"],
          ["s-busy", "working"],
          ["s-asking", "waiting"],
          ["s-offline", "away"],
        ],
      ],
    ]);
  });

  it("lists no session of a run that has ended, so a run's sessions leave together", () => {
    expect(
      describeWork(
        [
          buildStepSession("s-ended-run", "run-ended", { status: "busy" }),
          buildStepSession("s-live-run", "run-live", { status: "busy" }),
        ],
        [buildRun("run-live")],
      ).map(([, id]) => id),
    ).toEqual(["run-live"]);
  });
});

describe("listLiveWork with Agents and assistants", () => {
  it("lists an Agent's session outside a run while it is at work, and not once it has exited", () => {
    expect(
      describeWork([
        buildSession({ id: "s-at-work", agentId: "a-triage", status: "idle" }),
        buildSession({ id: "s-exited", agentId: "a-triage", status: "exited", resumable: true }),
      ]),
    ).toEqual([["agent", "s-at-work", [["s-at-work", "idle"]]]]);
  });

  it("lists no assistant's session", () => {
    expect(describeWork([buildAssistantSession("a-wren", { status: "busy" })])).toEqual([]);
  });
});

describe("listLiveWork's order and projects", () => {
  it("lists work oldest first, whatever the order of the sessions", () => {
    expect(
      describeWork(
        [
          buildSession({ id: "s-new", status: "busy", createdAt: buildTimestamp(5) }),
          buildStepSession("s-step", "run-1", { createdAt: buildTimestamp(9) }),
          buildSession({ id: "s-old", status: "busy", createdAt: buildTimestamp(1) }),
        ],
        [buildRun("run-1", 3)],
      ).map(([, id]) => id),
    ).toEqual(["s-old", "run-1", "s-new"]);
  });

  it("gives a run the project its workspace's repos share, and none when they share none", () => {
    const work = listFixtureWork(
      [
        buildStepSession("s-ops", "run-ops", { workspaceId: OPS_RUN_WORKSPACE.id }),
        buildStepSession("s-mixed", "run-mixed", { workspaceId: MIXED_RUN_WORKSPACE.id }),
        buildStepSession("s-scratch", "run-scratch", { workspaceId: null }),
        buildStepSession("s-unknown", "run-unknown", { workspaceId: "ws-not-read-yet" }),
      ],
      ["run-ops", "run-mixed", "run-scratch", "run-unknown"].map((id) => buildRun(id)),
    );

    expect(work.map((piece) => [piece.id, piece.projectId])).toEqual([
      ["run-mixed", null],
      ["run-ops", OPS_PROJECT.id],
      ["run-scratch", null],
      ["run-unknown", null],
    ]);
  });

  it("gives a run whose repos are in several projects the first project listed", () => {
    const sharedRepo = { ...INFRA, projectIds: [OPS_PROJECT.id, WEBSHOP_PROJECT.id] };
    const work = listLiveWork({
      sessions: [buildStepSession("s-shared", "run-1", { workspaceId: "ws-shared" })],
      liveRuns: [buildRun("run-1")],
      projects: [WEBSHOP_PROJECT, OPS_PROJECT],
      workspaces: [buildRunWorkspace("ws-shared", [sharedRepo.id])],
      resources: [sharedRepo],
      runners: [MOSS],
    });

    expect(work.map((piece) => piece.projectId)).toEqual([WEBSHOP_PROJECT.id]);
  });
});

describe("isThreadSeated", () => {
  it("seats a thread not marked Done in every pose", () => {
    expect(POSES.filter((pose) => isThreadSeated(pose, false))).toEqual(POSES);
  });

  it("seats a thread marked Done only while it waits on the user", () => {
    expect(POSES.filter((pose) => isThreadSeated(pose, true))).toEqual(["waiting"]);
  });
});
