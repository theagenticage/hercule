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
 *   first listed when several do, and to none otherwise;
 * - with `endedSince`, the work also lists a Thread from when it was marked
 *   Done, a Run from when it finished, and an Agent's session from when it
 *   exited, each only since that time, and a run read both live and
 *   finished counts as finished;
 * - a session comes into the Office when it was created, or when a Thread
 *   was last reopened.
 */
import { describe, expect, it } from "vitest";
import type { RunSummary, Session } from "@hercule/contract";
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
import { decideArrivedAt, isThreadSeated, listWork } from "./work";

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

describe("listWork with Threads", () => {
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

describe("listWork with Runs", () => {
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

describe("listWork with Agents and assistants", () => {
  it("lists an Agent's session outside a run while it is at work, and not once it has exited", () => {
    expect(
      describeWork([
        buildSession({ id: "s-at-work", agentId: "a-triage", status: "idle" }),
        buildSession({ id: "s-exited", agentId: "a-triage", status: "exited", resumable: true }),
      ]),
    ).toEqual([["agent", "s-at-work", [["s-at-work", "idle"]]]]);
  });

  it("lists a Thread that a run's step started as a Thread, because only its kind says what it is", () => {
    expect(
      describeWork([
        buildSession({ id: "s-from-step", kind: "thread", runId: "run-1", status: "busy" }),
      ]),
    ).toEqual([["thread", "s-from-step", [["s-from-step", "working"]]]]);
  });

  it("lists no assistant's session", () => {
    expect(describeWork([buildAssistantSession("a-wren", { status: "busy" })])).toEqual([]);
  });
});

describe("listWork's order and projects", () => {
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
    const work = listWork({
      sessions: [buildStepSession("s-shared", "run-1", { workspaceId: "ws-shared" })],
      runs: [buildRun("run-1")],
      endedSince: null,
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

/**
 * Returns each piece of work that ended since `endedSince` as its kind, its
 * id, its end and its workers' ids and poses. The work in progress is left out.
 */
const describeEndedWork = (
  sessions: readonly Session[],
  runs: readonly RunSummary[],
  endedSince: string,
) =>
  listWork({
    sessions,
    runs,
    endedSince,
    projects: [WEBSHOP_PROJECT, OPS_PROJECT],
    workspaces: [OPS_RUN_WORKSPACE],
    resources: [INFRA],
    runners: [MOSS],
  })
    .filter((piece) => piece.endedAt !== null)
    .map((piece) => [
      piece.kind,
      piece.id,
      piece.endedAt,
      piece.workers.map((worker) => [worker.session.id, worker.pose]),
    ]);

describe("listWork with endedSince", () => {
  it("lists a Thread from when it was marked Done, unless it waits on the user or is not Done", () => {
    const done = { at: buildTimestamp(5), by: "user" as const };

    expect(
      describeEndedWork(
        [
          buildSession({ id: "s-done", status: "idle", done }),
          buildSession({ id: "s-done-asking", status: "busy", openRequests: [REQUEST], done }),
          buildSession({ id: "s-open", status: "idle" }),
        ],
        [],
        buildTimestamp(4),
      ),
    ).toEqual([["thread", "s-done", buildTimestamp(5), [["s-done", "idle"]]]]);
  });

  it("lists a finished run with all its sessions from when it finished, and no live run", () => {
    const finished: RunSummary = {
      id: "run-done",
      workflowId: "wf-review",
      workflowName: "Review",
      origin: { kind: "manual", actor: "user" },
      createdAt: buildTimestamp(0),
      status: "completed",
      startedAt: buildTimestamp(0),
      finishedAt: buildTimestamp(6),
    };

    expect(
      describeEndedWork(
        [
          buildStepSession("s-step-2", "run-done", {
            status: "exited",
            createdAt: buildTimestamp(2),
          }),
          buildStepSession("s-step-1", "run-done", {
            status: "exited",
            createdAt: buildTimestamp(1),
          }),
          buildStepSession("s-live", "run-live", { status: "busy" }),
        ],
        [finished, buildRun("run-live")],
        buildTimestamp(4),
      ),
    ).toEqual([
      [
        "run",
        "run-done",
        buildTimestamp(6),
        [
          ["s-step-1", "done"],
          ["s-step-2", "done"],
        ],
      ],
    ]);
  });

  it.each([
    ["first", true],
    ["last", false],
  ])(
    "counts a run read both live and finished as finished, with the finished record %s",
    (_, first) => {
      const live = buildRun("run-1");
      const finished: RunSummary = {
        id: "run-1",
        workflowId: "wf-review",
        workflowName: "Review",
        origin: { kind: "manual", actor: "user" },
        createdAt: buildTimestamp(0),
        status: "completed",
        startedAt: buildTimestamp(0),
        finishedAt: buildTimestamp(6),
      };
      const work = listWork({
        sessions: [buildStepSession("s-step", "run-1", { status: "exited" })],
        runs: first ? [finished, live] : [live, finished],
        endedSince: buildTimestamp(4),
        projects: [],
        workspaces: [],
        resources: [],
        runners: [MOSS],
      });

      expect(work.map((piece) => [piece.id, piece.endedAt])).toEqual([
        ["run-1", buildTimestamp(6)],
      ]);
    },
  );

  it("lists an Agent's session from when it exited, as idle, and none still at work", () => {
    expect(
      describeEndedWork(
        [
          buildSession({
            id: "s-exited",
            agentId: "a-triage",
            status: "exited",
            exitedAt: buildTimestamp(7),
          }),
          buildSession({ id: "s-at-work", agentId: "a-triage", status: "busy" }),
          buildAssistantSession("a-wren", { status: "exited", exitedAt: buildTimestamp(7) }),
        ],
        [],
        buildTimestamp(4),
      ),
    ).toEqual([["agent", "s-exited", buildTimestamp(7), [["s-exited", "idle"]]]]);
  });

  it("lists nothing that ended before the time asked for", () => {
    const done = { at: buildTimestamp(3), by: "user" as const };

    expect(
      describeEndedWork(
        [
          buildSession({ id: "s-done", status: "idle", done }),
          buildSession({
            id: "s-exited",
            agentId: "a-triage",
            status: "exited",
            exitedAt: buildTimestamp(3),
          }),
        ],
        [],
        buildTimestamp(4),
      ),
    ).toEqual([]);
  });
});

describe("decideArrivedAt", () => {
  it("takes a session's creation, or a Thread's last reopening", () => {
    expect(decideArrivedAt(buildSession({ id: "s-new", createdAt: buildTimestamp(1) }))).toBe(
      buildTimestamp(1),
    );
    expect(
      decideArrivedAt(
        buildSession({
          id: "s-reopened",
          createdAt: buildTimestamp(1),
          reopenedAt: buildTimestamp(8),
        }),
      ),
    ).toBe(buildTimestamp(8));
  });
});
