/**
 * Tests that taint passes on (spec 13 section 10): a session that a tainted
 * session starts, a fork of a tainted session, and a session that a tainted
 * session puts text into all become tainted, and the same actions by a clean
 * caller taint nothing.
 *
 * A test taints a session through `markTainted`, the one function that taints
 * from nothing, and reads the result through `isCallerTainted`, so the flag
 * stays out of the public session record.
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { Profile, Session } from "@hercule/contract";
import { CurrentActor } from "../actor";
import { withTransaction } from "../db";
import { post, send } from "../http/testing";
import { sessionTaint } from "../taint";
import {
  at,
  createProfile,
  reportEvent,
  spawnThreadUnder,
  spawnThreadWithGrants,
  waitForSession,
  withAgentFleet,
  type Arranged,
  type SpawnedThread,
} from "./testing";

/** Taints a session, as the core does when it delivers a third-party line. */
const taint = (arranged: Arranged, sessionId: string): Promise<void> =>
  Effect.runPromise(
    Effect.flatMap(sessionTaint, (it) =>
      withTransaction(arranged.harness.sql, it.markTainted(sessionId)),
    ).pipe(Effect.provideService(SqlClient.SqlClient, arranged.harness.sql)),
  );

/** Reads whether a session is tainted, as a caller who is that session. */
const isTainted = (arranged: Arranged, sessionId: string): Promise<boolean> =>
  Effect.runPromise(
    Effect.flatMap(sessionTaint, (it) => it.isCallerTainted).pipe(
      Effect.provideService(CurrentActor, {
        _tag: "session",
        sessionId,
        profileId: "",
        grants: [],
        profileGrants: [],
        assistantId: null,
        agentId: null,
      }),
      Effect.provideService(SqlClient.SqlClient, arranged.harness.sql),
    ),
  );

const CALLER_GRANTS = ["session.spawn", "session.steer", "thread.start"] as const;

/** A Thread that may spawn, fork and steer, tainted when `tainted` is set. */
const startCaller = async (arranged: Arranged, tainted: boolean): Promise<SpawnedThread> => {
  const caller = await spawnThreadWithGrants(arranged, "caller", CALLER_GRANTS);
  if (tainted) await taint(arranged, caller.session.id);
  return caller;
};

/** A Thread the user started, with a turn running. */
const startTarget = async (arranged: Arranged): Promise<Session> => {
  const { session } = await spawnThreadWithGrants(arranged, "target", []);
  reportEvent(arranged.wire, 2, {
    eventId: crypto.randomUUID(),
    sessionId: session.id,
    at,
    _tag: "turn.started",
    turnId: "t1",
  });
  return await waitForSession(arranged, session.id, (one) => one.status === "busy");
};

/** Ends a started Thread, which leaves a parent a fork can use. */
const endThread = async (arranged: Arranged, session: Session): Promise<void> => {
  arranged.wire.send({
    _tag: "sessionsReport",
    sessions: [
      {
        sessionId: session.id,
        nativeSessionId: "native-1",
        providerAccountId: session.providerAccountId,
      },
    ],
  });
  await waitForSession(arranged, session.id, (one) => one.nativeSessionId !== null);
  reportEvent(arranged.wire, 2, {
    eventId: crypto.randomUUID(),
    sessionId: session.id,
    at,
    _tag: "session.exited",
    reason: "stopped",
  });
  await waitForSession(arranged, session.id, (one) => one.status === "exited");
};

/** Starts and ends a Thread on `profile`, tainted when `tainted` is set. */
const startEndedParent = async (
  arranged: Arranged,
  profile: Profile,
  tainted: boolean,
): Promise<Session> => {
  const { session } = await spawnThreadUnder(arranged, profile);
  await endThread(arranged, session);
  if (tainted) await taint(arranged, session.id);
  return session;
};

const spawnFrom = async (
  arranged: Arranged,
  token: string,
  profileId: string,
): Promise<Session> => {
  const response = await post(
    arranged.harness.base,
    "/api/v1/sessions",
    { prompt: "hello", permissionProfileId: profileId },
    token,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Session;
};

const forkFrom = async (arranged: Arranged, token: string, parentId: string): Promise<Session> => {
  const response = await post(
    arranged.harness.base,
    `/api/v1/sessions/${parentId}/continue`,
    { mode: "fork", prompt: "more" },
    token,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Session;
};

const sendInput = async (
  arranged: Arranged,
  token: string,
  targetId: string,
  body: Record<string, unknown>,
): Promise<{ readonly inputId: string }> => {
  const response = await post(
    arranged.harness.base,
    `/api/v1/sessions/${targetId}/input`,
    body,
    token,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as { inputId: string };
};

describe("taint passes on: session.spawn", () => {
  it("starts a Thread tainted when a tainted session spawns it", async () => {
    await withAgentFleet(async (arranged) => {
      const caller = await startCaller(arranged, true);

      const child = await spawnFrom(arranged, caller.token, caller.session.permissionProfileId);

      expect(await isTainted(arranged, child.id)).toBe(true);
    });
  });

  it("starts a Thread clean when a clean session spawns it", async () => {
    await withAgentFleet(async (arranged) => {
      const caller = await startCaller(arranged, false);

      const child = await spawnFrom(arranged, caller.token, caller.session.permissionProfileId);

      expect(await isTainted(arranged, child.id)).toBe(false);
    });
  });
});

describe("taint passes on: session.continue", () => {
  it("starts a fork tainted when a tainted session forks a clean parent", async () => {
    await withAgentFleet(async (arranged) => {
      // The parent ends first: a runner's session report that leaves the
      // caller out would otherwise end the caller too.
      const profile = await createProfile(arranged, "caller", CALLER_GRANTS);
      const parent = await startEndedParent(arranged, profile, false);
      const caller = await spawnThreadUnder(arranged, profile);
      await taint(arranged, caller.session.id);

      const fork = await forkFrom(arranged, caller.token, parent.id);

      expect(await isTainted(arranged, fork.id)).toBe(true);
      expect(await isTainted(arranged, parent.id)).toBe(false);
    });
  });

  it("starts a fork tainted when the user forks a tainted parent", async () => {
    await withAgentFleet(async (arranged) => {
      const profile = await createProfile(arranged, "forked", []);
      const parent = await startEndedParent(arranged, profile, true);

      const fork = await forkFrom(arranged, arranged.token, parent.id);

      expect(await isTainted(arranged, fork.id)).toBe(true);
    });
  });

  it("starts a fork clean when the user forks a clean parent", async () => {
    await withAgentFleet(async (arranged) => {
      const profile = await createProfile(arranged, "forked", []);
      const parent = await startEndedParent(arranged, profile, false);

      const fork = await forkFrom(arranged, arranged.token, parent.id);

      expect(await isTainted(arranged, fork.id)).toBe(false);
    });
  });
});

describe("taint passes on: session.input", () => {
  it("taints the target when a tainted session steers input into it", async () => {
    await withAgentFleet(async (arranged) => {
      const caller = await startCaller(arranged, true);
      const target = await startTarget(arranged);
      arranged.wire.answering(() => "steered");

      await sendInput(arranged, caller.token, target.id, { text: "do this" });

      expect(await isTainted(arranged, target.id)).toBe(true);
    });
  });

  it("taints the target when a tainted session queues input for it", async () => {
    await withAgentFleet(async (arranged) => {
      const caller = await startCaller(arranged, true);
      const target = await startTarget(arranged);

      await sendInput(arranged, caller.token, target.id, { text: "do this", steer: false });

      expect(await isTainted(arranged, target.id)).toBe(true);
    });
  });

  it("leaves the target clean when a clean session or the user sends input", async () => {
    await withAgentFleet(async (arranged) => {
      const caller = await startCaller(arranged, false);
      const target = await startTarget(arranged);

      await sendInput(arranged, caller.token, target.id, { text: "from a session", steer: false });
      await sendInput(arranged, arranged.token, target.id, { text: "from the user", steer: false });

      expect(await isTainted(arranged, target.id)).toBe(false);
    });
  });

  it("leaves the target clean when the tainted session's input is refused", async () => {
    await withAgentFleet(async (arranged) => {
      const caller = await startCaller(arranged, true);
      const target = await startTarget(arranged);

      const response = await post(
        arranged.harness.base,
        `/api/v1/sessions/${target.id}/input`,
        { text: "" },
        caller.token,
      );

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(await isTainted(arranged, target.id)).toBe(false);
    });
  });
});

describe("taint passes on: input.update", () => {
  it("taints the target when a tainted session rewrites a queued input", async () => {
    await withAgentFleet(async (arranged) => {
      const updater = await startCaller(arranged, true);
      const target = await startTarget(arranged);
      const { inputId } = await sendInput(arranged, arranged.token, target.id, {
        text: "the user's words",
        steer: false,
      });
      expect(await isTainted(arranged, target.id)).toBe(false);

      const response = await send(
        "PATCH",
        arranged.harness.base,
        `/api/v1/sessions/${target.id}/inputs/${inputId}`,
        { body: { text: "the updater's words" }, token: updater.token },
      );

      expect(response.status, await response.clone().text()).toBe(200);
      expect(await isTainted(arranged, target.id)).toBe(true);
    });
  });
});

describe("taint passes on: session.respondToQuestion", () => {
  /** Starts a Thread waiting on one open question, and returns it. */
  const startAsking = async (arranged: Arranged): Promise<Session> => {
    const target = await startTarget(arranged);
    reportEvent(arranged.wire, 3, {
      eventId: crypto.randomUUID(),
      sessionId: target.id,
      at,
      _tag: "request.opened",
      request: {
        requestId: "req-1",
        itemId: "i1",
        kind: "question",
        detail: {
          questions: [
            {
              question: "Which storage?",
              header: "Storage",
              options: [{ label: "sqlite", description: "a file" }],
              multiSelect: false,
            },
          ],
        },
      },
    });
    return await waitForSession(arranged, target.id, (one) => one.openRequests.length > 0);
  };

  const answer = (arranged: Arranged, token: string, id: string): Promise<Response> =>
    post(
      arranged.harness.base,
      `/api/v1/sessions/${id}/respond-to-question`,
      { requestId: "req-1", answers: { Storage: "sqlite" } },
      token,
    );

  it("taints the asking session when a tainted session answers", async () => {
    await withAgentFleet(async (arranged) => {
      const caller = await startCaller(arranged, true);
      const asking = await startAsking(arranged);

      const response = await answer(arranged, caller.token, asking.id);

      expect(response.status, await response.clone().text()).toBe(200);
      expect(await isTainted(arranged, asking.id)).toBe(true);
    });
  });

  it("leaves the asking session clean when the user answers", async () => {
    await withAgentFleet(async (arranged) => {
      const asking = await startAsking(arranged);

      const response = await answer(arranged, arranged.token, asking.id);

      expect(response.status, await response.clone().text()).toBe(200);
      expect(await isTainted(arranged, asking.id)).toBe(false);
    });
  });
});
