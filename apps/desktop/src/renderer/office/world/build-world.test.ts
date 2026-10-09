/**
 * Tests the world the Office draws. The tests check that:
 *
 * - the Lounge holds the idle threads, and no working or waiting one;
 * - the queue holds the threads with an open Request, the longest waiting
 *   first, even when they waited less than a minute apart;
 * - a thread that changes pose keeps the desk key, so the Office plays the
 *   change on the built office instead of rebuilding it;
 * - a new thread changes the desk key, so the Office is rebuilt;
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
import type { OpenRequest, Session } from "@hercule/contract";
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

/** Returns the world for `sessions` and `assistants` in the fixture fleet. */
const build = (sessions: readonly Session[], assistants: readonly AssistantRow[] = []) =>
  buildWorld({
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

const working = buildSession({ id: "s-working", status: "busy", runnerId: MOSS.id });
const idle = buildSession({ id: "s-idle", status: "idle", runnerId: MOSS.id });

describe("buildWorld", () => {
  it("seats the idle threads in the Lounge, and no working or waiting one", () => {
    const waiting = buildSession({
      id: "s-waiting",
      status: "busy",
      runnerId: MOSS.id,
      openRequests: [REQUEST],
    });

    expect(build([working, idle, waiting]).lounge).toEqual(["s-idle"]);
  });

  it("queues the threads with an open Request, the longest waiting first", () => {
    /** Returns a thread that has waited on `REQUEST` since `lastActivityAt`. */
    const buildAsking = (id: string, lastActivityAt: string): Session =>
      buildSession({
        id,
        status: "busy",
        runnerId: MOSS.id,
        openRequests: [REQUEST],
        lastActivityAt,
      });

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
      project: null,
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
    const another = buildSession({ id: "s-another", status: "busy", runnerId: MOSS.id });

    expect(computeDeskKey(build([working, idle, another]))).not.toBe(
      computeDeskKey(build([working, idle])),
    );
  });
});

describe("isSameColleagueState", () => {
  const asking = buildSession({
    id: "s-asking",
    status: "busy",
    runnerId: MOSS.id,
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
