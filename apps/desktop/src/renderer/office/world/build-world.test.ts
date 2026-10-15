/**
 * Tests the world the Office draws. The tests check that:
 *
 * - the Lounge holds the idle threads, and no working or waiting one;
 * - the work with no project sits in the café, piece by piece, and rests
 *   there rather than in the Lounge;
 * - a run's session wears the visor, and an Agent's session the flat cap;
 * - the queue holds the threads with an open Request, the longest waiting
 *   first, even when they waited less than a minute apart;
 * - a thread that changes pose keeps the desk key, so the Office plays the
 *   change on the built office instead of rebuilding it;
 * - a new thread changes the desk key, so the Office is rebuilt, and so does
 *   a session that arrives in the café;
 * - a colleague's state counts as changed when any field of its request
 *   changed, so the Office never keeps showing an older request;
 * - each assistant becomes a colleague in the Secretariat's order, wearing
 *   its assistant look, with its row's pose and its session's runner,
 *   model and last activity;
 * - an assistant that changes pose or moves to a new session on another
 *   runner keeps the desk key, and adding, removing or renaming one
 *   changes it.
 */
import { describe, expect, it } from "vitest";
import { buildAssistantRows, type AssistantRow } from "@hercule/client-core";
import type { OpenRequest, RunSummary, Session } from "@hercule/contract";
import {
  COVE,
  MOSS,
  OPS_PROJECT,
  PRIMARY,
  THREAD_3F1,
  WEBSHOP_PROJECT,
  buildSession,
} from "@hercule/client-core/threads/testing";
import { buildAssistantLook } from "../../faces/look";
import { buildWorld, computeDeskKey, isSameColleagueState } from "./build-world";
import type { Colleague, OfficeRequest } from "./types";

const REQUEST: OpenRequest = {
  requestId: "req-1",
  itemId: "tool-1",
  kind: "command_approval",
  decisions: ["allow", "deny"],
  detail: { command: "git push" },
};

/** A running run, started from the workflow Review. */
const RUN: RunSummary = {
  id: "run-1",
  workflowId: "wf-review",
  workflowName: "Review",
  origin: { kind: "manual", actor: "user" },
  createdAt: "2026-09-10T09:00:00.000Z",
  status: "running",
  startedAt: "2026-09-10T09:00:00.000Z",
  activeStepIds: ["review"],
  awaitedSignalIds: [],
};

/** Returns the world for `sessions` and `assistants` in the fixture fleet, with `RUN` live. */
const build = (sessions: readonly Session[], assistants: readonly AssistantRow[] = []) =>
  buildWorld({
    liveRuns: [RUN],
    resources: [],
    sessions,
    projects: [WEBSHOP_PROJECT, OPS_PROJECT],
    workspaces: [PRIMARY, THREAD_3F1],
    runners: [MOSS, COVE],
    assistants,
    localRunnerId: MOSS.id,
  });

const ADA = { id: "a-ada", name: "Ada" };
const BEA = { id: "a-bea", name: "Bea" };

/** Returns the current session of Ada's main conversation. */
const buildAdaSession = (over: Partial<Session> = {}): Session =>
  buildSession({
    id: "s-ada",
    agentId: ADA.id,
    conversationId: "c-ada",
    status: "busy",
    runnerId: MOSS.id,
    lastActivityAt: "2026-10-04T09:00:00.000Z",
    ...over,
  });

/** Returns the rows of Ada, with `adaSession` as her current session, and of Bea, with none. */
const buildRows = (
  adaSession: Session = buildAdaSession(),
  assistants: ReadonlyArray<{ id: string; name: string }> = [ADA, BEA],
): AssistantRow[] => buildAssistantRows(assistants, new Map([[ADA.id, adaSession]]), [MOSS, COVE]);

/** Returns a thread of the project webshop on moss. */
const buildThread = (over: Partial<Session> & { id: string }): Session =>
  buildSession({ runnerId: MOSS.id, projectId: WEBSHOP_PROJECT.id, ...over });

const working = buildThread({ id: "s-working", status: "busy" });
const idle = buildThread({ id: "s-idle", status: "idle" });

describe("buildWorld", () => {
  it("seats the idle threads in the Lounge, and no working or waiting one", () => {
    const waiting = buildThread({ id: "s-waiting", status: "busy", openRequests: [REQUEST] });

    expect(build([working, idle, waiting]).lounge).toEqual(["s-idle"]);
  });

  it("seats the sessions with no project in the café, where they rest instead of the Lounge", () => {
    const loose = buildSession({ id: "s-loose", status: "idle", runnerId: MOSS.id });
    const looseStep = buildSession({
      id: "s-loose-step",
      status: "exited",
      agentId: "a-reviewer",
      runId: RUN.id,
      stepId: "review",
      runnerId: MOSS.id,
    });

    const world = build([idle, loose, looseStep]);

    expect(world.cafe.map((piece) => [piece.kind, piece.id])).toEqual([
      // Both started at nine; ids decide.
      ["run", RUN.id],
      ["thread", "s-loose"],
    ]);
    expect(world.rooms.map((room) => room.projectId)).toEqual([WEBSHOP_PROJECT.id]);
    expect(world.lounge).toEqual(["s-idle"]);
  });

  it("dresses each kind of session: a visor for a run's, a flat cap for another Agent's", () => {
    const step = buildThread({
      id: "s-step",
      status: "busy",
      agentId: "a-reviewer",
      runId: RUN.id,
      stepId: "review",
    });
    const agent = buildThread({ id: "s-agent", status: "busy", agentId: "a-triage" });

    const colleagues = new Map(
      build([working, step, agent]).colleagues.map((colleague) => [colleague.id, colleague]),
    );

    expect(colleagues.get("s-working")?.kind).toBe("thread");
    expect(colleagues.get("s-step")?.kind).toBe("run");
    expect(colleagues.get("s-step")?.look.headwear).toBe("visor");
    expect(colleagues.get("s-agent")?.kind).toBe("agent");
    expect(colleagues.get("s-agent")?.look.headwear).toBe("flat-cap");
  });

  it("queues the threads with an open Request, the longest waiting first", () => {
    /** Returns a thread that has waited on `REQUEST` since `lastActivityAt`. */
    const buildAsking = (id: string, lastActivityAt: string): Session =>
      buildThread({ id, status: "busy", openRequests: [REQUEST], lastActivityAt });

    const world = build([
      buildAsking("s-later", "2026-09-10T09:59:40.000Z"),
      working,
      buildAsking("s-earlier", "2026-09-10T09:59:10.000Z"),
    ]);

    expect(world.queue).toEqual(["s-earlier", "s-later"]);
  });
});

describe("buildWorld with assistants", () => {
  it("turns each assistant into a colleague in the Secretariat's order", () => {
    const world = build([working], buildRows());

    expect(world.secretariat).toEqual(["a-ada", "a-bea"]);
    expect(world.colleagues.map((colleague) => [colleague.kind, colleague.id])).toEqual([
      ["thread", "s-working"],
      ["assistant", "a-ada"],
      ["assistant", "a-bea"],
    ]);
  });

  it("draws an assistant with its look, its row's pose, and its session's runner, model and last activity", () => {
    const ada = build([], buildRows()).colleagues.find((colleague) => colleague.id === ADA.id);

    expect(ada).toEqual({
      kind: "assistant",
      id: "a-ada",
      sessionId: buildAdaSession().id,
      name: "Ada",
      look: buildAssistantLook("a-ada"),
      pose: "working",
      stateLabel: "working",
      runnerId: MOSS.id,
      model: "claude-sonnet-5",
      request: null,
      oldestRequest: null,
      lastActivityAt: "2026-10-04T09:00:00.000Z",
    });
    expect(ada?.look.headwear).not.toBeNull();
  });

  it("draws an assistant with no session as idle, with no session, runner, model or last activity", () => {
    const bea = build([], buildRows()).colleagues.find((colleague) => colleague.id === BEA.id);

    expect(bea).toMatchObject({
      kind: "assistant",
      pose: "idle",
      stateLabel: "idle",
      sessionId: null,
      runnerId: null,
      model: null,
      request: null,
      lastActivityAt: null,
    });
  });
});

describe("computeDeskKey", () => {
  it("keeps the key when a thread only changes pose, so the Office does not rebuild", () => {
    const before = build([working, idle]);
    const after = build([
      { ...working, openRequests: [REQUEST] },
      { ...idle, status: "busy" },
    ]);

    // Desks are in creation order, then by id: s-idle before s-working.
    expect(after.colleagues.map((colleague) => colleague.pose)).toEqual(["working", "waiting"]);
    expect(computeDeskKey(after)).toBe(computeDeskKey(before));
  });

  it("keeps the key when an assistant changes pose or starts a new session on another runner", () => {
    const before = build([working], buildRows());
    const asleep = build(
      [working],
      buildRows(buildAdaSession({ status: "exited", resumable: true })),
    );
    const elsewhere = build(
      [working],
      buildRows(buildAdaSession({ id: "s-ada-2", runnerId: COVE.id, openRequests: [REQUEST] })),
    );

    expect(asleep.colleagues[1]?.pose).toBe("asleep");
    expect(elsewhere.colleagues[1]?.pose).toBe("waiting");
    expect(computeDeskKey(asleep)).toBe(computeDeskKey(before));
    expect(computeDeskKey(elsewhere)).toBe(computeDeskKey(before));
  });

  it("changes the key when an assistant is added, removed or renamed", () => {
    const key = computeDeskKey(build([working], buildRows()));

    expect(computeDeskKey(build([working], buildRows(undefined, [ADA])))).not.toBe(key);
    expect(
      computeDeskKey(
        build([working], buildRows(undefined, [ADA, BEA, { id: "a-cleo", name: "Cleo" }])),
      ),
    ).not.toBe(key);
    expect(
      computeDeskKey(build([working], buildRows(undefined, [ADA, { ...BEA, name: "Beatrix" }]))),
    ).not.toBe(key);
  });

  it("changes the key when a thread gets a desk", () => {
    const another = buildThread({ id: "s-another", status: "busy" });

    expect(computeDeskKey(build([working, idle, another]))).not.toBe(
      computeDeskKey(build([working, idle])),
    );
  });

  it("changes the key when a session sits down in the café", () => {
    const loose = buildSession({ id: "s-loose", status: "busy", runnerId: MOSS.id });

    expect(computeDeskKey(build([working, loose]))).not.toBe(computeDeskKey(build([working])));
  });
});

describe("isSameColleagueState", () => {
  const asking = buildThread({
    id: "s-asking",
    status: "busy",
    openRequests: [REQUEST],
    lastActivityAt: "2026-10-04T09:00:00.000Z",
  });
  /** Returns the colleague the world draws for `session`. */
  const buildColleagueFor = (session: Session): Colleague => build([session]).colleagues[0]!;

  it("keeps a colleague whose thread changed nothing the Office shows", () => {
    expect(isSameColleagueState(buildColleagueFor(asking), buildColleagueFor(asking))).toBe(true);
  });

  it("tells a newer Request for the same command apart by when it started waiting", () => {
    const newer = { ...asking, lastActivityAt: "2026-10-04T09:05:00.000Z" };

    expect(isSameColleagueState(buildColleagueFor(asking), buildColleagueFor(newer))).toBe(false);
  });

  it("tells apart a change to any field of the request", () => {
    const colleague = buildColleagueFor(asking);
    const request = colleague.request!;
    const changes: { [Field in keyof OfficeRequest]-?: OfficeRequest[Field] } = {
      kind: "question",
      short: "Run git pull?",
      prompt: "git pull",
      answers: ["Deny", "Allow"],
      waitingSince: "2026-10-04T09:05:00.000Z",
    };

    for (const field of Object.keys(request) as Array<keyof OfficeRequest>) {
      const changed = { ...colleague, request: { ...request, [field]: changes[field] } };
      expect(isSameColleagueState(colleague, changed), field).toBe(false);
    }
  });
});
