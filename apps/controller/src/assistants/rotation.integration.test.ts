/**
 * Tests the rotation of an assistant's conversation against a real
 * controller and a fake runner: the request, the flush turn it queues, the
 * stop of the rotated session, and the successor session the next owner
 * message places.
 *
 * The daily rotation timer is not here: the Scheduler owns it and has its own
 * suite. The fake runner never exits a session by itself.
 */
import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
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

/** Reads `sessions.rotated_at` of one session, which no API field shows. */
const readRotatedAt = async (arranged: Arranged, sessionId: string): Promise<string | null> => {
  const rows = await Effect.runPromise(
    Effect.orDie(
      arranged.harness.sql<{ rotated_at: string | null }>`
        SELECT rotated_at FROM sessions WHERE id = unhex(replace(${sessionId}, '-', ''))`,
    ),
  );
  return rows[0]!.rotated_at;
};

const waitForRotated = (arranged: Arranged, sessionId: string) =>
  waitUntil("rotated the session", async () =>
    (await readRotatedAt(arranged, sessionId)) === null ? undefined : true,
  );

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

  it("queues the flush turn, rotates and stops the session when it ends, and stores no reply", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversationId, sessionId, nextSeq } = await arrangeIdleSession(arranged);
      const before = (await listMessages(arranged, conversationId)).items.length;

      const response = await rotate(arranged, conversationId);
      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toEqual({});

      await waitUntil("sent the flush turn", () =>
        listFlushFrames(arranged).length > 0 ? true : undefined,
      );
      const inputs = await listInputs(arranged, sessionId);
      expect(inputs.filter((one) => one.source === "rotation")).toHaveLength(1);
      expect(await readRotatedAt(arranged, sessionId)).toBeNull();
      expect(listFrames<SessionStop>(arranged.wire, "sessionStop")).toHaveLength(0);

      await runTurn(arranged, sessionId, nextSeq, "flush", ["Saved to memory."]);

      await waitForRotated(arranged, sessionId);
      const stops = await waitForFrames<SessionStop>(arranged.wire, "sessionStop", 1);
      expect(stops[0]!.sessionId).toBe(sessionId);
      // No request is behind the stop, so the audit log names the system.
      expect(await arranged.harness.audit("session.stopped")).toEqual([
        expect.objectContaining({ actor: "system" }),
      ]);
      expect((await listMessages(arranged, conversationId)).items).toHaveLength(before);
    });
  });

  it("places a new session with the owner's next message", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversationId, sessionId, nextSeq } = await arrangeIdleSession(arranged);
      expect((await rotate(arranged, conversationId)).status).toBe(200);
      await runTurn(arranged, sessionId, nextSeq, "flush", []);
      await waitForRotated(arranged, sessionId);

      await sendMessage(arranged, conversationId, "good morning");

      const [newest, older] = await waitForConversationSessions(arranged, conversationId, 2);
      expect(newest!.id).not.toBe(sessionId);
      expect(older!.id).toBe(sessionId);
      const [start] = await waitForStartFrames(arranged, newest!.id, 1);
      expect(start!.input.text).toBe("good morning");
    });
  });

  it("carries a message sent during the flush turn to the successor instead of steering it", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversationId, sessionId, nextSeq } = await arrangeIdleSession(arranged);
      expect((await rotate(arranged, conversationId)).status).toBe(200);
      await waitUntil("sent the flush turn", () =>
        listFlushFrames(arranged).length > 0 ? true : undefined,
      );
      reportEvent(arranged.wire, nextSeq, {
        eventId: crypto.randomUUID(),
        sessionId,
        at,
        _tag: "turn.started",
        turnId: "flush",
      });
      await waitForSession(arranged, sessionId, (one) => one.status === "busy");

      expect((await requestSend(arranged, conversationId, "one more thing")).status).toBe(200);
      await settle();
      const steered = listFrames<SessionInput>(arranged.wire, "sessionInput").filter(
        (frame) => frame.input.text === "one more thing",
      );
      expect(steered).toEqual([]);

      reportEvent(arranged.wire, nextSeq + 1, {
        eventId: crypto.randomUUID(),
        sessionId,
        at,
        _tag: "turn.completed",
        turnId: "flush",
        state: "completed",
      });
      await waitForRotated(arranged, sessionId);
      const [newest] = await waitForConversationSessions(arranged, conversationId, 2);
      expect(newest!.id).not.toBe(sessionId);
      const [start] = await waitForStartFrames(arranged, newest!.id, 1);
      expect(start!.input.text).toBe("one more thing");
    });
  });

  it("completes the rotation when an input was steered into the flush turn", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversationId, sessionId, nextSeq } = await arrangeIdleSession(arranged);
      expect((await rotate(arranged, conversationId)).status).toBe(200);
      await waitUntil("sent the flush turn", () =>
        listFlushFrames(arranged).length > 0 ? true : undefined,
      );
      reportEvent(arranged.wire, nextSeq, {
        eventId: crypto.randomUUID(),
        sessionId,
        at,
        _tag: "turn.started",
        turnId: "flush",
      });
      await waitForSession(arranged, sessionId, (one) => one.status === "busy");
      // Another input joins the running turn, and is delivered after the flush.
      await Effect.runPromise(
        Effect.orDie(
          arranged.harness.sql`
            INSERT INTO session_inputs
              (id, session_id, source, actor, text, status, delivery, created_at, delivered_at)
            VALUES (randomblob(16), unhex(replace(${sessionId}, '-', '')), 'user', 'user',
                    'one more thing', 'delivered', 'steered', ${at}, '2099-01-01T00:00:00.000Z')`,
        ),
      );
      reportEvent(arranged.wire, nextSeq + 1, {
        eventId: crypto.randomUUID(),
        sessionId,
        at,
        _tag: "turn.completed",
        turnId: "flush",
        state: "completed",
      });
      await waitForRotated(arranged, sessionId);
    });
  });

  it("moves a subscription of the rotated session to the successor", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversationId, sessionId, nextSeq } = await arrangeIdleSession(arranged);
      const [start] = await waitForStartFrames(arranged, sessionId, 1);
      const created = await post(
        arranged.harness.base,
        "/api/v1/subscriptions",
        { target: { kind: "ref", ref: "github:pr:o/r#87" } },
        readSessionToken(start!),
      );
      expect(created.status, await created.clone().text()).toBe(200);
      const { subscriptionId } = (await created.json()) as { subscriptionId: string };

      expect((await rotate(arranged, conversationId)).status).toBe(200);
      await runTurn(arranged, sessionId, nextSeq, "flush", []);
      await waitForRotated(arranged, sessionId);
      await sendMessage(arranged, conversationId, "good morning");
      const [newest] = await waitForConversationSessions(arranged, conversationId, 2);

      const rows = await Effect.runPromise(
        Effect.orDie(
          arranged.harness.sql<{ holder_id: string }>`
            SELECT lower(hex(holder_id)) AS holder_id FROM subscriptions
            WHERE id = unhex(replace(${subscriptionId}, '-', ''))`,
        ),
      );
      expect(rows[0]!.holder_id).toBe(newest!.id.replaceAll("-", ""));
    });
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
});

describe("a session that exits during its rotation", () => {
  /** Reports the session's exit and waits until it is rotated. */
  const exitRotated = async (arranged: Arranged, sessionId: string, seq: number) => {
    reportEvent(arranged.wire, seq, {
      eventId: crypto.randomUUID(),
      sessionId,
      at,
      _tag: "session.exited",
      reason: "crash",
    });
    await waitForRotated(arranged, sessionId);
    await settle();
  };

  it("cancels a flush that never ran and places no empty successor", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversationId, sessionId, nextSeq } = await arrangeIdleSession(arranged);
      // A turn is running, so the flush waits behind it.
      reportEvent(arranged.wire, nextSeq, {
        eventId: crypto.randomUUID(),
        sessionId,
        at,
        _tag: "turn.started",
        turnId: "t2",
      });
      await waitForSession(arranged, sessionId, (one) => one.status === "busy");
      expect((await rotate(arranged, conversationId)).status).toBe(200);
      expect(listFlushFrames(arranged)).toEqual([]);

      await exitRotated(arranged, sessionId, nextSeq + 1);

      const flush = (await listInputs(arranged, sessionId)).find(
        (one) => one.source === "rotation",
      );
      expect(flush?.status).toBe("cancelled");
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
      reportEvent(arranged.wire, nextSeq, {
        eventId: crypto.randomUUID(),
        sessionId,
        at,
        _tag: "turn.started",
        turnId: "flush",
      });
      await waitForSession(arranged, sessionId, (one) => one.status === "busy");

      await exitRotated(arranged, sessionId, nextSeq + 1);

      expect(await listConversationSessions(arranged, conversationId)).toHaveLength(1);
      expect((await listMessages(arranged, conversationId)).items).toHaveLength(before);
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
  const retireWithOwnerMessage = async (arranged: Arranged, rotating: boolean) => {
    const { conversationId, sessionId, nextSeq } = await arrangeIdleSession(arranged);
    reportEvent(arranged.wire, nextSeq, {
      eventId: crypto.randomUUID(),
      sessionId,
      at,
      _tag: "turn.started",
      turnId: "t2",
    });
    await waitForSession(arranged, sessionId, (one) => one.status === "busy");
    if (rotating) expect((await rotate(arranged, conversationId)).status).toBe(200);
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

  it("completes the rotation and keeps the owner message for the successor", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversationId, sessionId } = await retireWithOwnerMessage(arranged, true);
      expect(await readRotatedAt(arranged, sessionId)).not.toBeNull();
      const inputs = await listInputs(arranged, sessionId);
      expect(inputs.find((one) => one.source === "rotation")?.status).toBe("cancelled");
      expect(inputs.find((one) => one.text === "carry this through")?.status).not.toBe("cancelled");
      expect(await listConversationSessions(arranged, conversationId)).toHaveLength(2);
    });
  });

  it("keeps the owner message for a resume when no rotation is underway", async () => {
    await withAgentFleet(async (arranged) => {
      const { sessionId } = await retireWithOwnerMessage(arranged, false);
      const inputs = await listInputs(arranged, sessionId);
      expect(inputs.find((one) => one.text === "carry this through")?.status).not.toBe("cancelled");
    });
  });
});
