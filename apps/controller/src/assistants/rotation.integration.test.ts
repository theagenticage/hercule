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
import type { SessionInput, SessionStart, SessionStop } from "@hercule/protocol";
import { SYSTEM_ACTOR } from "../actor";
import { post, readErrorBody, send } from "../http/testing";
import {
  WAIT_DEADLINE_MS,
  at,
  listFrames,
  listInputs,
  readSession,
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
import { mintUuid, uuidFromString } from "../db";
import { Live } from "../daemon/sessions/live";
import {
  emitManualEvent,
  OTHER_REF,
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

/** Creates a subscription on `ref` with the token of the session, and returns its id. */
const subscribeFromSession = async (
  arranged: Arranged,
  sessionId: string,
  ref = REF,
): Promise<string> => {
  const [start] = await waitForStartFrames(arranged, sessionId, 1);
  const created = await post(
    arranged.harness.base,
    "/api/v1/subscriptions",
    { target: { kind: "ref", ref } },
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

/**
 * Reports the exit a stop causes, or the exit for `reason`, which the fake
 * runner never does by itself, and waits until it is applied.
 */
const reportStoppedExit = async (
  arranged: Arranged,
  sessionId: string,
  seq: number,
  reason: "stopped" | "idle_unload" | "crash" = "stopped",
): Promise<void> => {
  reportEvent(arranged.wire, seq, {
    eventId: crypto.randomUUID(),
    sessionId,
    at,
    _tag: "session.exited",
    reason,
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

  it("stops the session when the flush turn ends before the runner answers the flush, and a late answer does not reopen a turn", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversationId, sessionId, nextSeq } = await arrangeIdleSession(arranged);
      arranged.wire.answering(() => undefined);
      expect((await rotate(arranged, conversationId)).status).toBe(200);
      await waitUntil("sent the flush turn", () =>
        listFlushFrames(arranged).length > 0 ? true : undefined,
      );

      // The flush turn runs and ends while its answer is still on the way.
      await reportTurnStarted(arranged, sessionId, nextSeq, "flush");
      await reportTurnCompleted(arranged, sessionId, nextSeq + 1, "flush");
      await waitForFrames<SessionStop>(arranged.wire, "sessionStop", 1);

      arranged.wire.release("opened");
      await settle();
      expect((await readSession(arranged, sessionId)).status).not.toBe("busy");
      expect(listFrames<SessionStop>(arranged.wire, "sessionStop")).toHaveLength(1);
      const flush = (await listInputs(arranged, sessionId)).find(
        (one) => one.source === "rotation",
      );
      expect(flush?.status).toBe("delivered");
    });
  });

  it("cancels a flush the runner never answered, and does not send it a second time", async () => {
    await withAgentFleet(
      async (arranged) => {
        const { conversationId, sessionId } = await arrangeIdleSession(arranged);
        arranged.wire.answering(() => undefined);
        expect((await rotate(arranged, conversationId)).status).toBe(200);
        await waitUntil("sent the flush turn", () =>
          listFlushFrames(arranged).length > 0 ? true : undefined,
        );

        // The runner may have run the flush, so the controller gives up on it
        // after the deadline instead of queueing it to run again.
        const flush = await waitUntil("cancelled the flush", async () => {
          const found = (await listInputs(arranged, sessionId)).find(
            (one) => one.source === "rotation",
          );
          return found?.status === "cancelled" ? found : undefined;
        });
        expect(flush.reason).toContain("not sent again");
        await settle();
        expect(listFlushFrames(arranged)).toHaveLength(1);
      },
      { inputDeadline: Duration.millis(300) },
    );
  });

  it("stops the session when its flush is cancelled, and gives the message that waited to the next session", async () => {
    await withAgentFleet(
      async (arranged) => {
        const { conversationId, sessionId, nextSeq } = await arrangeIdleSession(arranged);
        arranged.wire.answering(() => undefined);
        expect((await rotate(arranged, conversationId)).status).toBe(200);
        await waitUntil("sent the flush turn", () =>
          listFlushFrames(arranged).length > 0 ? true : undefined,
        );
        expect((await requestSend(arranged, conversationId, "while you were away")).status).toBe(
          200,
        );

        await waitForFrames<SessionStop>(arranged.wire, "sessionStop", 1);
        await reportStoppedExit(arranged, sessionId, nextSeq);

        const [newest] = await waitForConversationSessions(arranged, conversationId, 2);
        expect(newest!.id).not.toBe(sessionId);
        const [start] = await waitForStartFrames(arranged, newest!.id, 1);
        expect(start!.input.text).toBe("while you were away");
      },
      { inputDeadline: Duration.millis(300) },
    );
  });

  it("stops the session at the end of the turn that was open when its flush was cancelled", async () => {
    await withAgentFleet(
      async (arranged) => {
        const { conversationId, sessionId, nextSeq } = await arrangeIdleSession(arranged);
        arranged.wire.answering(() => undefined);
        expect((await rotate(arranged, conversationId)).status).toBe(200);
        await waitUntil("sent the flush turn", () =>
          listFlushFrames(arranged).length > 0 ? true : undefined,
        );
        // The turn opens, but the answer to the flush never comes.
        await reportTurnStarted(arranged, sessionId, nextSeq, "flush");
        await waitUntil("cancelled the flush", async () =>
          (await listInputs(arranged, sessionId)).find(
            (one) => one.source === "rotation" && one.status !== "queued",
          ),
        );
        await settle();
        expect(listFrames<SessionStop>(arranged.wire, "sessionStop")).toHaveLength(0);

        await reportTurnCompleted(arranged, sessionId, nextSeq + 1, "flush");
        await waitForFrames<SessionStop>(arranged.wire, "sessionStop", 1);
      },
      { inputDeadline: Duration.millis(300) },
    );
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

describe("input left on an older session of the conversation", () => {
  it("is taken over by the delivery pass, which places a session when the newest cannot be resumed", async () => {
    await withAgentFleet(
      async (arranged) => {
        const { conversationId, sessionId: older, nextSeq } = await arrangeIdleSession(arranged);
        expect((await rotate(arranged, conversationId)).status).toBe(200);
        const afterFlush = await runTurn(arranged, older, nextSeq, "flush", []);
        await waitForFrames<SessionStop>(arranged.wire, "sessionStop", 1);
        await reportStoppedExit(arranged, older, afterFlush);
        await sendMessage(arranged, conversationId, "first");
        const [newest] = await waitForConversationSessions(arranged, conversationId, 2);
        const newestId = newest!.id;
        const afterTurn = await runTurn(arranged, newestId, 2, "t1", ["ok"]);
        await reportStoppedExit(arranged, newestId, afterTurn);

        // No send writes to an older session any more, so the row is written
        // directly, as an earlier version of the controller left it.
        await Effect.runPromise(
          Effect.orDie(
            arranged.harness.sql`
              INSERT INTO session_inputs (id, session_id, source, actor, text, status, created_at)
              VALUES (${mintUuid()}, ${uuidFromString(older)}, 'user', 'user',
                      'left behind', 'queued', ${at})`,
          ),
        );

        // The newest session never reported a native session, so it cannot
        // be resumed: a third session takes the input over and starts with it.
        const [third] = await waitForConversationSessions(arranged, conversationId, 3);
        expect(third!.id).not.toBe(newestId);
        const [start] = await waitForStartFrames(arranged, third!.id, 1);
        expect(start!.input.text).toBe("left behind");
        expect(
          (await listInputs(arranged, older)).filter((one) => one.text === "left behind"),
        ).toEqual([]);
      },
      { eventRoutingInterval: Duration.millis(20) },
    );
  });
});

describe("a conversation whose next session cannot be placed", () => {
  const UNPLACEABLE = "A conversation's next session could not be placed";

  it("logs the failure once, however many delivery passes try again, and places the session when it can", async () => {
    const warnings: Array<string> = [];
    const log = vi.spyOn(console, "log").mockImplementation((...parts: ReadonlyArray<unknown>) => {
      const line = parts.map(String).join(" ");
      if (line.includes(UNPLACEABLE)) warnings.push(line);
    });
    try {
      await withAgentFleet(
        async (arranged) => {
          const { conversationId, sessionId, nextSeq } = await arrangeIdleSession(arranged);
          expect((await rotate(arranged, conversationId)).status).toBe(200);
          const afterFlush = await runTurn(arranged, sessionId, nextSeq, "flush", []);
          await waitForFrames<SessionStop>(arranged.wire, "sessionStop", 1);
          // The one runner is reserved, so no runner can take the next session.
          const setReserved = (reserved: 0 | 1) =>
            Effect.runPromise(
              Effect.orDie(
                arranged.harness.sql`
                  UPDATE runners SET reserved = ${reserved}
                  WHERE id = unhex(replace(${arranged.runnerId}, '-', ''))`,
              ),
            );
          await setReserved(1);
          // The message waits on the retired session until it has exited.
          expect((await requestSend(arranged, conversationId, "waiting")).status).toBe(200);
          await reportStoppedExit(arranged, sessionId, afterFlush);

          await waitUntil("logged the failure", () => (warnings.length > 0 ? true : undefined));
          // Many passes run in this time, at one every 20 milliseconds.
          await settle();
          expect(warnings).toHaveLength(1);
          expect(await listConversationSessions(arranged, conversationId)).toHaveLength(1);

          await setReserved(0);
          const [newest] = await waitForConversationSessions(arranged, conversationId, 2);
          const [start] = await waitForStartFrames(arranged, newest!.id, 1);
          expect(start!.input.text).toBe("waiting");
        },
        { eventRoutingInterval: Duration.millis(20) },
      );
    } finally {
      log.mockRestore();
    }
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

/** Reads who stored each input of a session, in the order they were stored. */
const readInputActors = async (
  arranged: Arranged,
  sessionId: string,
): Promise<ReadonlyArray<{ readonly text: string; readonly actor: string }>> =>
  Effect.runPromise(
    Effect.orDie(
      arranged.harness.sql<{ text: string; actor: string }>`
        SELECT text, actor FROM session_inputs
        WHERE session_id = unhex(replace(${sessionId}, '-', ''))
        ORDER BY created_at, id`,
    ),
  );

describe("a subscription match for a conversation", () => {
  it("waits on the retired session while no runner can place the next one, and goes to the session a runner that joins starts", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversationId, sessionId, nextSeq } = await arrangeIdleSession(arranged);
      const subscriptionId = await subscribeFromSession(arranged, sessionId);
      expect((await rotate(arranged, conversationId)).status).toBe(200);
      const after = await runTurn(arranged, sessionId, nextSeq, "flush", []);
      await waitForFrames<SessionStop>(arranged.wire, "sessionStop", 1);
      await reportStoppedExit(arranged, sessionId, after);
      // The only runner goes away, so the conversation's next session has
      // nowhere to run.
      arranged.wire.close();

      await emitManualEvent(arranged, [REF], "while no runner is there");

      // The match is stored, not lost: its input waits on the newest session.
      const waiting = await waitForMatchedInputRows(
        arranged.harness,
        subscriptionId,
        (rows) => rows.length === 1,
      );
      expect(waiting[0]!.session).toBe(sessionId.replaceAll("-", ""));
      expect(waiting[0]!.status).toBe("queued");
      await settle();
      expect(await listConversationSessions(arranged, conversationId)).toHaveLength(1);
      expect((await readSubscriptionRow(arranged.harness, subscriptionId))!.ended_at).toBeNull();

      const other = await arranged.enlist();
      const [newest] = await waitForConversationSessions(arranged, conversationId, 2);
      const [start] = await waitForFrames<SessionStart>(other.wire, "sessionStart", 1);
      expect(start!.sessionId).toBe(newest!.id);
      expect(start!.input.text).toContain("while no runner is there");
      const rows = await readMatchedInputRows(arranged.harness, subscriptionId);
      expect(rows.map((row) => row.session)).toEqual([newest!.id.replaceAll("-", "")]);
    }, WITH_EVENTS);
  });

  it("is stored as the system's input when an enrichment makes the event match", async () => {
    await withAgentFleet(async (arranged) => {
      const { sessionId } = await arrangeIdleSession(arranged);
      const subscriptionId = await subscribeFromSession(arranged, sessionId, OTHER_REF);
      const eventId = await emitManualEvent(arranged, [REF], "enriched into a match");
      await settle();
      expect(await readMatchedInputRows(arranged.harness, subscriptionId)).toEqual([]);

      const response = await post(
        arranged.harness.base,
        `/api/v1/events/${String(eventId)}/enrich`,
        { refs: [OTHER_REF] },
        arranged.token,
      );
      expect(response.status, await response.clone().text()).toBe(200);

      await waitForMatchedInputRows(arranged.harness, subscriptionId, (rows) => rows.length === 1);
      // The enrichment was the user's request, but the match is the
      // controller's own work, as it is for a match the pipeline finds.
      const stored = (await readInputActors(arranged, sessionId)).find((one) =>
        one.text.includes("enriched into a match"),
      );
      expect(stored?.actor).toBe(SYSTEM_ACTOR);
    }, WITH_EVENTS);
  });

  it("does not lift the crash-loop guard of a held session, and the owner's next message resumes it for all the input that waits", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversationId, sessionId, nextSeq } = await arrangeIdleSession(arranged);
      const subscriptionId = await subscribeFromSession(arranged, sessionId);
      await reportStoppedExit(arranged, sessionId, nextSeq, "idle_unload");
      // The runner refuses the resume's start, and the session exits before
      // it starts a turn: the crash-loop guard now holds the session.
      arranged.wire.answering(() => ({ message: "the harness crashed" }));
      await sendMessage(arranged, conversationId, "are you there?");
      await waitForStartFrames(arranged, sessionId, 2);
      await waitUntil("recorded the refusal", async () =>
        (await listInputs(arranged, sessionId)).find(
          (one) => one.text === "are you there?" && one.reason !== null,
        ),
      );
      arranged.wire.answering(() => "opened");
      // The resumed process numbers its events from 1 again.
      await reportStoppedExit(arranged, sessionId, 1, "crash");
      await waitForSession(arranged, sessionId, (one) => one.resumeHeld);

      await emitManualEvent(arranged, [REF], "while the session is held");

      await waitForMatchedInputRows(arranged.harness, subscriptionId, (rows) => rows.length === 1);
      await settle();
      expect((await readSession(arranged, sessionId)).resumeHeld).toBe(true);
      expect(listFrames<SessionStart>(arranged.wire, "sessionStart")).toHaveLength(2);

      await sendMessage(arranged, conversationId, "and now?");

      const starts = await waitForStartFrames(arranged, sessionId, 3);
      expect(starts[2]!.input.text).toBe("are you there?");
      // The rest of what waited goes out one input per turn, after the start.
      const waiting = (await listInputs(arranged, sessionId)).filter(
        (one) => one.status === "queued",
      );
      expect(waiting.map((one) => one.text)).toContain("and now?");
      expect(waiting.some((one) => one.text.includes("while the session is held"))).toBe(true);
      expect(await listConversationSessions(arranged, conversationId)).toHaveLength(1);
    }, WITH_EVENTS);
  });
});
