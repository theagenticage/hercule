/**
 * Tests the rotation of an assistant's conversation against a real
 * controller and a fake runner: the request that retires the session and
 * queues its flush turn, the stop after the flush, and the next session that
 * takes over the input that waited.
 *
 * The daily rotation timer is not here: the Scheduler owns it and has its own
 * suite. The fake runner never exits a session by itself, so a test reports
 * the exit a stop would cause.
 */
import { describe, expect, it, vi } from "vitest";
import { Duration, Effect } from "effect";
import { github } from "@hercule/plugin-github";
import type { SessionInput, SessionStop } from "@hercule/protocol";
import { post, readErrorBody, send } from "../http/testing";
import {
  WAIT_DEADLINE_MS,
  at,
  listFrames,
  listInputs,
  readSessionToken,
  reportEvent,
  spawnThreadWithGrants,
  waitForFrames,
  waitForSession,
  waitForStartFrames,
  waitUntil,
  withAgentFleet,
  type Arranged,
} from "../sessions/testing";
import {
  listConversationSessions,
  listMessages,
  readDefaultConversation,
  requestSend,
  runTurn,
  sendMessage,
  startConversationSession,
  waitForConversationSessions,
} from "../conversations/testing";
import { Live } from "../daemon/sessions/live";
import {
  emitManualEvent,
  readMatchedInputRows,
  readSubscriptionRow,
  REF,
  waitForMatchedInputRows,
} from "../daemon/testing";
import { FLUSH_TEXT } from "./delivery";

vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 3 + 10_000 });

/** An idle conversation session that has had one turn, and the next free sequence number. */
interface Arrangement {
  readonly assistantId: string;
  readonly conversationId: string;
  readonly sessionId: string;
  readonly nextSeq: number;
}

/** Starts the default conversation's session with one answered turn, so it is idle and can rotate. */
const arrangeIdleSession = async (arranged: Arranged): Promise<Arrangement> => {
  const { assistant, conversation } = await readDefaultConversation(arranged);
  const session = await startConversationSession(arranged, conversation.id, "hello");
  const nextSeq = await runTurn(arranged, session.id, 2, "t1", ["Hi."]);
  return {
    assistantId: assistant.id,
    conversationId: conversation.id,
    sessionId: session.id,
    nextSeq,
  };
};

const rotate = (arranged: Arranged, conversationId: string, token = arranged.token) =>
  post(arranged.harness.base, `/api/v1/conversations/${conversationId}/rotate`, {}, token);

/** Fleet options for a test that emits events: a fast pipeline tick, and the plugin whose event kind the tests emit. */
const WITH_EVENTS = { plugins: [github], eventRoutingInterval: Duration.millis(10) };

/** Creates a subscription on `REF` with the token of the session, and returns its id. */
const subscribeFromSession = async (arranged: Arranged, sessionId: string): Promise<string> => {
  const [start] = await waitForStartFrames(arranged, sessionId, 1);
  const created = await post(
    arranged.harness.base,
    "/api/v1/subscriptions",
    { target: { kind: "ref", ref: REF } },
    readSessionToken(start!),
  );
  expect(created.status, await created.clone().text()).toBe(200);
  return ((await created.json()) as { subscriptionId: string }).subscriptionId;
};

/** Reads who holds a subscription, which only the table shows for sure. */
const readHolder = async (
  arranged: Arranged,
  subscriptionId: string,
): Promise<{ kind: string; id: string }> => {
  const rows = await Effect.runPromise(
    Effect.orDie(
      arranged.harness.sql<{ kind: string; id: string }>`
        SELECT holder_kind AS kind, lower(hex(holder_id)) AS id FROM subscriptions
        WHERE id = unhex(replace(${subscriptionId}, '-', ''))`,
    ),
  );
  const row = rows[0]!;
  // The table stores the id as 32 hex digits, the API as a dashed UUID.
  return {
    kind: row.kind,
    id: row.id.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5"),
  };
};

/** Reads `sessions.retired_at` of one session, which no API field shows. */
const readRetiredAt = async (arranged: Arranged, sessionId: string): Promise<string | null> => {
  const rows = await Effect.runPromise(
    Effect.orDie(
      arranged.harness.sql<{ retired_at: string | null }>`
        SELECT retired_at FROM sessions WHERE id = unhex(replace(${sessionId}, '-', ''))`,
    ),
  );
  return rows[0]!.retired_at;
};

/** Reports the exit a stop causes, which the fake runner never does by itself, and waits until it is applied. */
const reportStoppedExit = async (
  arranged: Arranged,
  sessionId: string,
  seq: number,
): Promise<void> => {
  reportEvent(arranged.wire, seq, {
    eventId: crypto.randomUUID(),
    sessionId,
    at,
    _tag: "session.exited",
    reason: "stopped",
  });
  await waitForSession(arranged, sessionId, (one) => one.status === "exited");
};

/** Reports the start of a turn, and waits until the session is busy. */
const reportTurnStarted = async (
  arranged: Arranged,
  sessionId: string,
  seq: number,
  turnId: string,
): Promise<void> => {
  reportEvent(arranged.wire, seq, {
    eventId: crypto.randomUUID(),
    sessionId,
    at,
    _tag: "turn.started",
    turnId,
  });
  await waitForSession(arranged, sessionId, (one) => one.status === "busy");
};

/** Reports the end of a turn that produced nothing to store, and waits until the session is not busy. */
const reportTurnCompleted = async (
  arranged: Arranged,
  sessionId: string,
  seq: number,
  turnId: string,
): Promise<void> => {
  reportEvent(arranged.wire, seq, {
    eventId: crypto.randomUUID(),
    sessionId,
    at,
    _tag: "turn.completed",
    turnId,
    state: "completed",
  });
  await waitForSession(arranged, sessionId, (one) => one.status !== "busy");
};

/** The frames that carry the rotation's flush text, sent to the runner. */
const listFlushFrames = (arranged: Arranged): ReadonlyArray<SessionInput> =>
  listFrames<SessionInput>(arranged.wire, "sessionInput").filter(
    (frame) => frame.input.text === FLUSH_TEXT,
  );

/** Runs a turn that reports `context` when it ends, without any assistant text, and waits until it is idle. */
const runTurnWithContext = async (
  arranged: Arranged,
  sessionId: string,
  seq: number,
  turnId: string,
  context: { readonly tokens: number; readonly windowTokens?: number },
): Promise<number> => {
  const base = () => ({ eventId: crypto.randomUUID(), sessionId, at });
  reportEvent(arranged.wire, seq, { ...base(), _tag: "turn.started", turnId });
  await waitForSession(arranged, sessionId, (one) => one.status === "busy");
  reportEvent(arranged.wire, seq + 1, {
    ...base(),
    _tag: "turn.completed",
    turnId,
    state: "completed",
    context,
  });
  await waitForSession(arranged, sessionId, (one) => one.status !== "busy");
  return seq + 2;
};

const setRotation = async (
  arranged: Arranged,
  assistantId: string,
  rotation: { contextFraction: number; maxContextTokens: number },
): Promise<void> => {
  const response = await send("PATCH", arranged.harness.base, `/api/v1/assistants/${assistantId}`, {
    body: { rotation: { ...rotation, dailyAt: "04:00" } },
    token: arranged.token,
  });
  expect(response.status, await response.clone().text()).toBe(200);
};

/** Lets the controller finish the work a report started, which no response shows. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 500));

describe("conversation.rotate", () => {
  it("refuses with 409 when the conversation has no session", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversation } = await readDefaultConversation(arranged);
      const response = await rotate(arranged, conversation.id);
      expect(response.status).toBe(409);
      expect((await readErrorBody(response)).code).toBe("invalid_state");
    });
  });

  it("refuses with 409 when the newest session has had no turn", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversation } = await readDefaultConversation(arranged);
      // The runner never answers the start frame, so the first input is not delivered.
      arranged.wire.answering(() => undefined);
      const message = await sendMessage(arranged, conversation.id, "hello");
      expect(message.text).toBe("hello");
      const [session] = await waitForConversationSessions(arranged, conversation.id, 1);
      await waitForStartFrames(arranged, session!.id, 1);
      const response = await rotate(arranged, conversation.id);
      expect(response.status).toBe(409);
      expect((await readErrorBody(response)).code).toBe("invalid_state");
    });
  });

  it("refuses a session token with 403", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversation } = await readDefaultConversation(arranged);
      await arrangeIdleSession(arranged);
      const thread = await spawnThreadWithGrants(arranged, "rotators", ["agent.write"]);
      const response = await rotate(arranged, conversation.id, thread.token);
      expect(response.status).toBe(403);
    });
  });

  it("retires the session when asked, and stops it when the flush turn ends, storing no reply", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversationId, sessionId, nextSeq } = await arrangeIdleSession(arranged);
      const before = (await listMessages(arranged, conversationId)).items.length;

      const response = await rotate(arranged, conversationId);
      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toEqual({});

      // Retired by the request itself, before the flush turn ran.
      expect(await readRetiredAt(arranged, sessionId)).not.toBeNull();
      await waitUntil("sent the flush turn", () =>
        listFlushFrames(arranged).length > 0 ? true : undefined,
      );
      const inputs = await listInputs(arranged, sessionId);
      expect(inputs.filter((one) => one.source === "rotation")).toHaveLength(1);
      expect(listFrames<SessionStop>(arranged.wire, "sessionStop")).toHaveLength(0);

      await runTurn(arranged, sessionId, nextSeq, "flush", ["Saved to memory."]);

      const stops = await waitForFrames<SessionStop>(arranged.wire, "sessionStop", 1);
      expect(stops[0]!.sessionId).toBe(sessionId);
      // No request is behind the stop, so the audit log names the system.
      expect(await arranged.harness.audit("session.stopped")).toEqual([
        expect.objectContaining({ actor: "system" }),
      ]);
      expect((await listMessages(arranged, conversationId)).items).toHaveLength(before);
    });
  });

  it("does not stop the session while its flush waits behind a running turn", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversationId, sessionId, nextSeq } = await arrangeIdleSession(arranged);
      await reportTurnStarted(arranged, sessionId, nextSeq, "t2");
      expect((await rotate(arranged, conversationId)).status).toBe(200);
      expect(listFlushFrames(arranged)).toEqual([]);

      // The turn that was running ends, which is not the flush turn.
      await reportTurnCompleted(arranged, sessionId, nextSeq + 1, "t2");
      await waitUntil("sent the flush turn", () =>
        listFlushFrames(arranged).length > 0 ? true : undefined,
      );
      await settle();
      expect(listFrames<SessionStop>(arranged.wire, "sessionStop")).toHaveLength(0);

      await runTurn(arranged, sessionId, nextSeq + 2, "flush", []);
      await waitForFrames<SessionStop>(arranged.wire, "sessionStop", 1);
    });
  });

  it("places a new session with the owner's next message once the retired session has exited", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversationId, sessionId, nextSeq } = await arrangeIdleSession(arranged);
      expect((await rotate(arranged, conversationId)).status).toBe(200);
      const after = await runTurn(arranged, sessionId, nextSeq, "flush", []);
      await waitForFrames<SessionStop>(arranged.wire, "sessionStop", 1);
      await reportStoppedExit(arranged, sessionId, after);

      await sendMessage(arranged, conversationId, "good morning");

      const [newest, older] = await waitForConversationSessions(arranged, conversationId, 2);
      expect(newest!.id).not.toBe(sessionId);
      expect(older!.id).toBe(sessionId);
      const [start] = await waitForStartFrames(arranged, newest!.id, 1);
      expect(start!.input.text).toBe("good morning");
    });
  });

  it("keeps a message sent while the retired session lives, and gives it to the next session as its first input", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversationId, sessionId, nextSeq } = await arrangeIdleSession(arranged);
      expect((await rotate(arranged, conversationId)).status).toBe(200);
      await waitUntil("sent the flush turn", () =>
        listFlushFrames(arranged).length > 0 ? true : undefined,
      );
      await reportTurnStarted(arranged, sessionId, nextSeq, "flush");

      expect((await requestSend(arranged, conversationId, "one more thing")).status).toBe(200);
      await settle();
      // Neither steered into the flush turn nor given to a second session.
      const steered = listFrames<SessionInput>(arranged.wire, "sessionInput").filter(
        (frame) => frame.input.text === "one more thing",
      );
      expect(steered).toEqual([]);
      expect(await listConversationSessions(arranged, conversationId)).toHaveLength(1);
      const waiting = (await listInputs(arranged, sessionId)).find(
        (one) => one.text === "one more thing",
      );
      expect(waiting?.status).toBe("queued");

      await reportTurnCompleted(arranged, sessionId, nextSeq + 1, "flush");
      await waitForFrames<SessionStop>(arranged.wire, "sessionStop", 1);
      // The next session is placed when the retired one has exited, with no
      // new message: it starts with the one that waited.
      await reportStoppedExit(arranged, sessionId, nextSeq + 2);
      const [newest] = await waitForConversationSessions(arranged, conversationId, 2);
      expect(newest!.id).not.toBe(sessionId);
      const [start] = await waitForStartFrames(arranged, newest!.id, 1);
      expect(start!.input.text).toBe("one more thing");
      const left = (await listInputs(arranged, sessionId)).filter(
        (one) => one.status === "queued" || one.status === "sent",
      );
      expect(left).toEqual([]);
    });
  });

  it("keeps a subscription across a rotation, and a match after it reaches the next session", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversationId, sessionId, nextSeq } = await arrangeIdleSession(arranged);
      const subscriptionId = await subscribeFromSession(arranged, sessionId);
      expect(await readHolder(arranged, subscriptionId)).toEqual({
        kind: "conversation",
        id: conversationId,
      });

      expect((await rotate(arranged, conversationId)).status).toBe(200);
      const after = await runTurn(arranged, sessionId, nextSeq, "flush", []);
      await waitForFrames<SessionStop>(arranged.wire, "sessionStop", 1);
      await reportStoppedExit(arranged, sessionId, after);

      await emitManualEvent(arranged, [REF], "after the rotation");

      const [newest] = await waitForConversationSessions(arranged, conversationId, 2);
      expect(newest!.id).not.toBe(sessionId);
      const [start] = await waitForStartFrames(arranged, newest!.id, 1);
      expect(start!.input.text).toContain("after the rotation");
      // The rotation touched nothing of the subscription.
      expect(await readHolder(arranged, subscriptionId)).toEqual({
        kind: "conversation",
        id: conversationId,
      });
      expect((await readSubscriptionRow(arranged.harness, subscriptionId))!.ended_at).toBeNull();
      const rows = await readMatchedInputRows(arranged.harness, subscriptionId);
      expect(rows.map((row) => row.session)).toEqual([newest!.id.replaceAll("-", "")]);
    }, WITH_EVENTS);
  });

  it("keeps a match that arrives while the retired session lives, and gives it to the next session", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversationId, sessionId, nextSeq } = await arrangeIdleSession(arranged);
      const subscriptionId = await subscribeFromSession(arranged, sessionId);
      expect((await rotate(arranged, conversationId)).status).toBe(200);
      await waitUntil("sent the flush turn", () =>
        listFlushFrames(arranged).length > 0 ? true : undefined,
      );
      await reportTurnStarted(arranged, sessionId, nextSeq, "flush");

      await emitManualEvent(arranged, [REF], "during the flush");

      const waiting = await waitForMatchedInputRows(
        arranged.harness,
        subscriptionId,
        (rows) => rows.length === 1,
      );
      // Stored on the retired session, not steered into its turn and not
      // given to a second session.
      expect(waiting[0]!.session).toBe(sessionId.replaceAll("-", ""));
      expect(waiting[0]!.status).toBe("queued");
      expect(await listConversationSessions(arranged, conversationId)).toHaveLength(1);

      await reportTurnCompleted(arranged, sessionId, nextSeq + 1, "flush");
      await waitForFrames<SessionStop>(arranged.wire, "sessionStop", 1);
      await reportStoppedExit(arranged, sessionId, nextSeq + 2);

      const [newest] = await waitForConversationSessions(arranged, conversationId, 2);
      const [start] = await waitForStartFrames(arranged, newest!.id, 1);
      expect(start!.input.text).toContain("during the flush");
      const rows = await readMatchedInputRows(arranged.harness, subscriptionId);
      expect(rows.map((row) => row.session)).toEqual([newest!.id.replaceAll("-", "")]);
    }, WITH_EVENTS);
  });

  it("queues one rotation input when asked twice", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversationId, sessionId } = await arrangeIdleSession(arranged);
      expect((await rotate(arranged, conversationId)).status).toBe(200);
      const again = await rotate(arranged, conversationId);
      expect(again.status, await again.clone().text()).toBe(200);
      expect(await again.json()).toEqual({});
      await settle();
      const inputs = await listInputs(arranged, sessionId);
      expect(inputs.filter((one) => one.source === "rotation")).toHaveLength(1);
      expect(listFlushFrames(arranged)).toHaveLength(1);
    });
  });

  it("resumes an exited session for the flush, then retires it", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversationId, sessionId, nextSeq } = await arrangeIdleSession(arranged);
      reportEvent(arranged.wire, nextSeq, {
        eventId: crypto.randomUUID(),
        sessionId,
        at,
        _tag: "session.exited",
        reason: "idle_unload",
      });
      await waitForSession(arranged, sessionId, (one) => one.status === "exited");

      expect((await rotate(arranged, conversationId)).status).toBe(200);

      const frames = await waitForStartFrames(arranged, sessionId, 2);
      expect(frames[1]!.spec.continue).toEqual({ mode: "resume", nativeSessionId: "native-1" });
      expect(frames[1]!.input.text).toBe(FLUSH_TEXT);
      expect(await readRetiredAt(arranged, sessionId)).not.toBeNull();
    });
  });

  it("retires a session that cannot be resumed without a flush, and places no session", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversationId, sessionId } = await arrangeIdleSession(arranged);
      const other = await arranged.enlist();
      try {
        const retiredRunner = await post(
          arranged.harness.base,
          `/api/v1/runners/${arranged.runnerId}/retire`,
          { force: true },
          arranged.token,
        );
        expect(retiredRunner.status).toBe(200);
        await waitForSession(arranged, sessionId, (one) => one.status === "exited");

        expect((await rotate(arranged, conversationId)).status).toBe(200);

        expect(await readRetiredAt(arranged, sessionId)).not.toBeNull();
        expect(
          (await listInputs(arranged, sessionId)).filter((one) => one.source === "rotation"),
        ).toEqual([]);
        await settle();
        expect(await listConversationSessions(arranged, conversationId)).toHaveLength(1);
      } finally {
        other.wire.close();
      }
    });
  });
});

describe("a session that exits during its rotation", () => {
  /** Reports the session's exit and gives the controller time to finish what follows. */
  const exitCrashed = async (arranged: Arranged, sessionId: string, seq: number) => {
    reportEvent(arranged.wire, seq, {
      eventId: crypto.randomUUID(),
      sessionId,
      at,
      _tag: "session.exited",
      reason: "crash",
    });
    await waitForSession(arranged, sessionId, (one) => one.status === "exited");
    await settle();
  };

  it("cancels a flush that never ran and places no empty successor", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversationId, sessionId, nextSeq } = await arrangeIdleSession(arranged);
      // A turn is running, so the flush waits behind it.
      await reportTurnStarted(arranged, sessionId, nextSeq, "t2");
      expect((await rotate(arranged, conversationId)).status).toBe(200);
      expect(listFlushFrames(arranged)).toEqual([]);

      await exitCrashed(arranged, sessionId, nextSeq + 1);

      const flush = (await listInputs(arranged, sessionId)).find(
        (one) => one.source === "rotation",
      );
      expect(flush?.status).toBe("cancelled");
      expect(await readRetiredAt(arranged, sessionId)).not.toBeNull();
      expect(await listConversationSessions(arranged, conversationId)).toHaveLength(1);
    });
  });

  it("places no successor and writes no notice when it exits during the flush turn", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversationId, sessionId, nextSeq } = await arrangeIdleSession(arranged);
      const before = (await listMessages(arranged, conversationId)).items.length;
      expect((await rotate(arranged, conversationId)).status).toBe(200);
      await waitUntil("sent the flush turn", () =>
        listFlushFrames(arranged).length > 0 ? true : undefined,
      );
      await reportTurnStarted(arranged, sessionId, nextSeq, "flush");

      await exitCrashed(arranged, sessionId, nextSeq + 1);

      expect(await listConversationSessions(arranged, conversationId)).toHaveLength(1);
      expect((await listMessages(arranged, conversationId)).items).toHaveLength(before);
    });
  });

  it("gives the message that waited behind the flush to the next session, and not the flush", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversationId, sessionId, nextSeq } = await arrangeIdleSession(arranged);
      await reportTurnStarted(arranged, sessionId, nextSeq, "t2");
      expect((await rotate(arranged, conversationId)).status).toBe(200);
      await sendMessage(arranged, conversationId, "carry this through");

      await exitCrashed(arranged, sessionId, nextSeq + 1);

      const [newest] = await waitForConversationSessions(arranged, conversationId, 2);
      const [start] = await waitForStartFrames(arranged, newest!.id, 1);
      // The successor never starts with "record what is durable".
      expect(start!.input.text).toBe("carry this through");
    });
  });
});

describe("rotation when a turn fills the context", () => {
  /** Runs one turn that reports `context` and returns whether a rotation input was queued. */
  const rotatesAfter = async (
    rotation: { contextFraction: number; maxContextTokens: number },
    context: { tokens: number; windowTokens?: number },
  ): Promise<boolean> => {
    let queued = false;
    await withAgentFleet(async (arranged) => {
      const { assistantId, sessionId, nextSeq } = await arrangeIdleSession(arranged);
      await setRotation(arranged, assistantId, rotation);
      await runTurnWithContext(arranged, sessionId, nextSeq, "t2", context);
      await settle();
      const inputs = await listInputs(arranged, sessionId);
      queued = inputs.some((one) => one.source === "rotation");
    });
    return queued;
  };

  it("rotates when the tokens reach the fraction of the window", async () => {
    expect(
      await rotatesAfter(
        { contextFraction: 0.5, maxContextTokens: 1_000_000 },
        { tokens: 5_000, windowTokens: 10_000 },
      ),
    ).toBe(true);
  });

  it("does not rotate below the fraction of the window", async () => {
    expect(
      await rotatesAfter(
        { contextFraction: 0.5, maxContextTokens: 1_000_000 },
        { tokens: 4_999, windowTokens: 10_000 },
      ),
    ).toBe(false);
  });

  it("rotates at the maximum even below the fraction", async () => {
    expect(
      await rotatesAfter(
        { contextFraction: 0.9, maxContextTokens: 3_000 },
        { tokens: 3_000, windowTokens: 100_000 },
      ),
    ).toBe(true);
  });

  it("applies only the maximum when the harness reports no window", async () => {
    expect(
      await rotatesAfter({ contextFraction: 0.5, maxContextTokens: 3_000 }, { tokens: 2_999 }),
    ).toBe(false);
    expect(
      await rotatesAfter({ contextFraction: 0.5, maxContextTokens: 3_000 }, { tokens: 3_000 }),
    ).toBe(true);
  });

  it("does not rotate a conversation again whose rotation is underway", async () => {
    await withAgentFleet(async (arranged) => {
      const { assistantId, conversationId, sessionId, nextSeq } =
        await arrangeIdleSession(arranged);
      await setRotation(arranged, assistantId, { contextFraction: 0.5, maxContextTokens: 1_000 });
      await runTurnWithContext(arranged, sessionId, nextSeq, "t2", { tokens: 2_000 });
      await waitUntil("sent the flush turn", () =>
        listFlushFrames(arranged).length > 0 ? true : undefined,
      );
      expect((await rotate(arranged, conversationId)).status).toBe(200);
      await settle();
      const inputs = await listInputs(arranged, sessionId);
      expect(inputs.filter((one) => one.source === "rotation")).toHaveLength(1);
      expect(await listConversationSessions(arranged, conversationId)).toHaveLength(1);
    });
  });
});

describe("a runner retired while a conversation session waits", () => {
  /**
   * Starts a conversation session with a turn running, queues an owner message
   * behind it, and force-retires the runner with another runner available.
   * Returns the session, then runs one delivery pass for the exited session.
   */
  const retireWithOwnerMessage = async (arranged: Arranged) => {
    const { conversationId, sessionId, nextSeq } = await arrangeIdleSession(arranged);
    reportEvent(arranged.wire, nextSeq, {
      eventId: crypto.randomUUID(),
      sessionId,
      at,
      _tag: "turn.started",
      turnId: "t2",
    });
    await waitForSession(arranged, sessionId, (one) => one.status === "busy");
    expect((await rotate(arranged, conversationId)).status).toBe(200);
    await sendMessage(arranged, conversationId, "carry this through");
    const other = await arranged.enlist();
    try {
      const retired = await post(
        arranged.harness.base,
        `/api/v1/runners/${arranged.runnerId}/retire`,
        { force: true },
        arranged.token,
      );
      expect(retired.status).toBe(200);
      await waitForSession(arranged, sessionId, (one) => one.status === "exited");
      const delivered = await arranged.harness.runWithLiveSessions(
        Effect.flatMap(Live, (live) => live.deliverQueuedInput(sessionId)),
      );
      expect(delivered._tag).toBe("Success");
      return { conversationId, sessionId };
    } finally {
      other.wire.close();
    }
  };

  it("keeps the owner message for the next session, and cancels the flush", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversationId, sessionId } = await retireWithOwnerMessage(arranged);
      expect(await readRetiredAt(arranged, sessionId)).not.toBeNull();
      const inputs = await listInputs(arranged, sessionId);
      expect(inputs.find((one) => one.source === "rotation")?.status).toBe("cancelled");
      expect(inputs.find((one) => one.text === "carry this through")?.status).not.toBe("cancelled");
      expect(await listConversationSessions(arranged, conversationId)).toHaveLength(2);
    });
  });
});
