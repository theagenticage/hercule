/**
 * Tests the rotation of an assistant's conversation against a real
 * controller and a fake runner: the request that retires the session and
 * queues its flush turn, and the next session that takes over the input that
 * waited.
 *
 * The daily rotation timer is not here: the Scheduler owns it and has its own
 * suite. A real runner ends the session after the flush turn; the fake runner
 * never exits a session by itself, so a test reports that exit.
 */
import { describe, expect, it, vi } from "vitest";
import { Duration, Effect } from "effect";
import { github } from "@hercule/plugin-github";
import type {
  FrameCarryingInput,
  ProviderEvent,
  SessionInput,
  SessionStart,
  SessionStop,
} from "@hercule/protocol";
import { SYSTEM_ACTOR } from "../actor";
import { post, readErrorBody, send } from "../http/testing";
import {
  WAIT_DEADLINE_MS,
  at,
  carriesInput,
  readCarriedInputId,
  findInstanceId,
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
  type TurnEnding,
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

/**
 * Reports an assistant text that completes inside a turn already started,
 * and then the turn's end with `ending`, and waits until the session is not
 * busy. Returns the next free sequence number.
 */
const reportTextAndTurnEnd = async (
  arranged: Arranged,
  sessionId: string,
  seq: number,
  turnId: string,
  text: string,
  ending: TurnEnding,
): Promise<number> => {
  const base = () => ({ eventId: crypto.randomUUID(), sessionId, at });
  const itemId = `${turnId}-item`;
  const events: ReadonlyArray<ProviderEvent> = [
    { ...base(), _tag: "item.started", turnId, itemId, kind: "assistant_message" },
    {
      ...base(),
      _tag: "content.delta",
      turnId,
      itemId,
      streamKind: "assistant_text",
      delta: text,
    },
    {
      ...base(),
      _tag: "item.completed",
      turnId,
      itemId,
      kind: "assistant_message",
      status: "completed",
    },
    {
      ...base(),
      _tag: "turn.completed",
      turnId,
      state: ending.state,
      ...(ending.error === undefined ? {} : { error: ending.error }),
    },
  ];
  events.forEach((event, index) => reportEvent(arranged.wire, seq + index, event));
  await waitForSession(arranged, sessionId, (one) => one.status !== "busy");
  return seq + events.length;
};

/** Lists what the conversation holds that the owner did not write, oldest first. */
const listAnswers = async (arranged: Arranged, conversationId: string) =>
  (await listMessages(arranged, conversationId, "sort=position:asc")).items.filter(
    (one) => one.senderRole !== "owner",
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

  it("retires the session when asked, and sends the flush as the input that ends the session, storing no reply", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversationId, sessionId, nextSeq } = await arrangeIdleSession(arranged);
      const before = (await listMessages(arranged, conversationId)).items.length;

      const response = await rotate(arranged, conversationId);
      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toEqual({});

      // Retired by the request itself, before the flush turn ran.
      expect(await readRetiredAt(arranged, sessionId)).not.toBeNull();
      const [flush] = await waitUntil("sent the flush turn", () => {
        const frames = listFlushFrames(arranged);
        return frames.length > 0 ? frames : undefined;
      });
      // The runner ends the session after this turn; the controller sends no stop.
      expect(flush!.input.endsSession).toBe(true);
      const inputs = await listInputs(arranged, sessionId);
      expect(inputs.filter((one) => one.source === "rotation")).toHaveLength(1);

      await runTurn(arranged, sessionId, nextSeq, "flush", ["Saved to memory."]);
      await settle();
      expect(listFrames<SessionStop>(arranged.wire, "sessionStop")).toEqual([]);
      expect((await listMessages(arranged, conversationId)).items).toHaveLength(before);
    });
  });

  it("sends the flush only once the turn running at the rotation has ended", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversationId, sessionId, nextSeq } = await arrangeIdleSession(arranged);
      await reportTurnStarted(arranged, sessionId, nextSeq, "t2");
      expect((await rotate(arranged, conversationId)).status).toBe(200);
      await settle();
      expect(listFlushFrames(arranged)).toEqual([]);

      await reportTurnCompleted(arranged, sessionId, nextSeq + 1, "t2");
      await waitUntil("sent the flush turn", () =>
        listFlushFrames(arranged).length > 0 ? true : undefined,
      );
    });
  });

  it("writes nothing for a flush turn that ends before the runner answers the flush, nor for the exit after the late answer", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversationId, sessionId, nextSeq } = await arrangeIdleSession(arranged);
      const before = (await listMessages(arranged, conversationId)).items.length;
      arranged.wire.answering(() => undefined);
      expect((await rotate(arranged, conversationId)).status).toBe(200);
      await waitUntil("sent the flush turn", () =>
        listFlushFrames(arranged).length > 0 ? true : undefined,
      );

      // The flush turn runs and ends while its answer is still on the way.
      // The late answer reads as a turn that opened, and the runner's exit
      // then lands during it.
      await reportTurnStarted(arranged, sessionId, nextSeq, "flush");
      await reportTurnCompleted(arranged, sessionId, nextSeq + 1, "flush");
      arranged.wire.release("opened");
      await reportStoppedExit(arranged, sessionId, nextSeq + 2);

      await settle();
      expect((await listMessages(arranged, conversationId)).items).toHaveLength(before);
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

  it("gives the message that waited to the next session once the runner ends the session after a cancelled flush", async () => {
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
        await waitUntil("cancelled the flush", async () =>
          (await listInputs(arranged, sessionId)).find(
            (one) => one.source === "rotation" && one.status === "cancelled",
          ),
        );

        await reportStoppedExit(arranged, sessionId, nextSeq);

        const [newest] = await waitForConversationSessions(arranged, conversationId, 2);
        expect(newest!.id).not.toBe(sessionId);
        const [start] = await waitForStartFrames(arranged, newest!.id, 1);
        expect(start!.input.text).toBe("while you were away");
      },
      { inputDeadline: Duration.millis(300) },
    );
  });

  it("stops a retired session the runner reports alive after its flush, and the exit hands the waiting message to the next session", async () => {
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

        // The runner drops off with the flush unanswered, so the flush frame
        // may never have reached it, and nothing tells it to end the session.
        arranged.wire.close();
        await waitUntil("cancelled the flush", async () =>
          (await listInputs(arranged, sessionId)).find(
            (one) => one.source === "rotation" && one.status === "cancelled",
          ),
        );

        // It comes back still holding the session, and is told to stop it.
        const wire = await arranged.reconnect();
        wire.send({
          _tag: "sessionsReport",
          sessions: [
            {
              sessionId,
              nativeSessionId: "native-1",
              instanceId: findInstanceId(arranged, "full-provider"),
            },
          ],
        });
        const stops = await waitForFrames<SessionStop>(wire, "sessionStop", 1);
        expect(stops[0]!.sessionId).toBe(sessionId);

        await reportStoppedExit({ ...arranged, wire }, sessionId, nextSeq);
        const [newest] = await waitForConversationSessions(arranged, conversationId, 2);
        expect(newest!.id).not.toBe(sessionId);
        const [start] = await waitForStartFrames({ ...arranged, wire }, newest!.id, 1);
        expect(start!.input.text).toBe("while you were away");
      },
      { inputDeadline: Duration.millis(5_000) },
    );
  });

  it("places a new session with the owner's next message once the retired session has exited", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversationId, sessionId, nextSeq } = await arrangeIdleSession(arranged);
      expect((await rotate(arranged, conversationId)).status).toBe(200);
      const after = await runTurn(arranged, sessionId, nextSeq, "flush", []);
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

describe("what a retired session's turns write to the conversation", () => {
  // The controller keeps a text it streamed in memory until the item ends, and
  // loses it when the report arrives after the session exited, unless it is
  // long enough to have been stored on its own. These tests report events
  // after an exit, so their text is longer than that.
  const LATE_TEXT = `The answer. ${"x".repeat(5_000)}`;

  it("writes nothing for the flush turn when the runner's answer to the flush has not arrived", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversationId, sessionId, nextSeq } = await arrangeIdleSession(arranged);
      const before = await listAnswers(arranged, conversationId);
      arranged.wire.answering(() => undefined);
      expect((await rotate(arranged, conversationId)).status).toBe(200);
      await waitUntil("sent the flush turn", () =>
        listFlushFrames(arranged).length > 0 ? true : undefined,
      );

      // The flush turn runs and fails before its answer is on the way.
      await reportTurnStarted(arranged, sessionId, nextSeq, "flush");
      await reportTextAndTurnEnd(arranged, sessionId, nextSeq + 1, "flush", "Saved to memory.", {
        state: "failed",
        error: "boom",
      });
      await settle();

      expect(await listAnswers(arranged, conversationId)).toEqual(before);
    });
  });

  it("writes nothing for the flush turn of a flush that was cancelled unanswered", async () => {
    await withAgentFleet(
      async (arranged) => {
        const { conversationId, sessionId, nextSeq } = await arrangeIdleSession(arranged);
        const before = await listAnswers(arranged, conversationId);
        arranged.wire.answering(() => undefined);
        expect((await rotate(arranged, conversationId)).status).toBe(200);
        await waitUntil("cancelled the flush", async () =>
          (await listInputs(arranged, sessionId)).find(
            (one) => one.source === "rotation" && one.status === "cancelled",
          ),
        );

        // The runner ran the flush anyway: its turn ends in a failure, and
        // the next one is cut short by the exit.
        await reportTurnStarted(arranged, sessionId, nextSeq, "flush");
        const after = await reportTextAndTurnEnd(
          arranged,
          sessionId,
          nextSeq + 1,
          "flush",
          "Saved to memory.",
          { state: "failed", error: "boom" },
        );
        await reportTurnStarted(arranged, sessionId, after, "again");
        await reportStoppedExit(arranged, sessionId, after + 1, "crash");
        await settle();

        expect(await listAnswers(arranged, conversationId)).toEqual(before);
      },
      { inputDeadline: Duration.millis(300) },
    );
  });

  it("writes the owner's reply of the turn that was running at the rotation when it arrives after the session exited and its unsent flush was cancelled", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversationId, sessionId, nextSeq } = await arrangeIdleSession(arranged);
      await reportTurnStarted(arranged, sessionId, nextSeq, "t2");
      // The flush waits behind the running turn, and the exit cancels it.
      expect((await rotate(arranged, conversationId)).status).toBe(200);
      reportEvent(arranged.wire, nextSeq + 1, {
        eventId: crypto.randomUUID(),
        sessionId,
        at,
        _tag: "session.exited",
        reason: "crash",
      });
      await waitForSession(arranged, sessionId, (one) => one.status === "exited");
      const flush = (await listInputs(arranged, sessionId)).find(
        (one) => one.source === "rotation",
      );
      expect(flush?.status).toBe("cancelled");

      // The reply the runner had buffered before it went away arrives late.
      await reportTextAndTurnEnd(arranged, sessionId, nextSeq + 2, "t2", LATE_TEXT, {
        state: "completed",
      });
      await settle();

      const replies = (await listAnswers(arranged, conversationId)).filter(
        (one) => one.senderRole === "assistant",
      );
      expect(replies.at(-1)?.text).toBe(LATE_TEXT);
    });
  });

  it("writes nothing for the late events of a flush turn whose flush was sent and then cancelled by the exit", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversationId, sessionId, nextSeq } = await arrangeIdleSession(arranged);
      const before = await listAnswers(arranged, conversationId);
      arranged.wire.answering(() => undefined);
      expect((await rotate(arranged, conversationId)).status).toBe(200);
      await waitUntil("sent the flush turn", () =>
        listFlushFrames(arranged).length > 0 ? true : undefined,
      );
      reportEvent(arranged.wire, nextSeq, {
        eventId: crypto.randomUUID(),
        sessionId,
        at,
        _tag: "session.exited",
        reason: "crash",
      });
      await waitForSession(arranged, sessionId, (one) => one.status === "exited");
      const flush = (await listInputs(arranged, sessionId)).find(
        (one) => one.source === "rotation",
      );
      expect(flush?.status).toBe("cancelled");

      // The runner ran the flush before it went away, and its events arrive late.
      await reportTextAndTurnEnd(arranged, sessionId, nextSeq + 1, "flush", LATE_TEXT, {
        state: "failed",
        error: "boom",
      });
      await settle();

      expect(await listAnswers(arranged, conversationId)).toEqual(before);
    });
  });

  it("writes the owner's reply and the failure notice of the turn that was running at the rotation", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversationId, sessionId, nextSeq } = await arrangeIdleSession(arranged);
      await reportTurnStarted(arranged, sessionId, nextSeq, "t2");
      expect((await rotate(arranged, conversationId)).status).toBe(200);
      expect(listFlushFrames(arranged)).toEqual([]);

      await reportTextAndTurnEnd(arranged, sessionId, nextSeq + 1, "t2", "Half an answer.", {
        state: "failed",
        error: "boom",
      });

      const answers = await listAnswers(arranged, conversationId);
      const [reply, notice] = answers.slice(-2);
      expect([reply?.senderRole, reply?.text]).toEqual(["assistant", "Half an answer."]);
      expect(notice?.senderRole).toBe("notice");
      expect(notice?.text).toContain("interrupted");
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

  it("writes the interrupted notice when it exits during the turn that was running at the rotation", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversationId, sessionId, nextSeq } = await arrangeIdleSession(arranged);
      await reportTurnStarted(arranged, sessionId, nextSeq, "t2");
      expect((await rotate(arranged, conversationId)).status).toBe(200);

      await exitCrashed(arranged, sessionId, nextSeq + 1);

      const notice = (await listAnswers(arranged, conversationId)).at(-1);
      expect(notice?.senderRole).toBe("notice");
      expect(notice?.text).toContain("interrupted");
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

/** The unanswered send is given up on after this, so the next session can take its input over. */
const SHORT_DEADLINE = {
  inputDeadline: Duration.seconds(2),
  eventRoutingInterval: Duration.millis(20),
};

describe("a late answer to the send of an input that another session took over", () => {
  /**
   * Leaves the owner's message unanswered on the session, and returns the
   * frame that carries it.
   */
  const leaveMessageUnanswered = async (arranged: Arranged, conversationId: string) => {
    arranged.wire.answering(() => undefined);
    // The send waits for the runner's answer, so the test does not await it.
    void requestSend(arranged, conversationId, "an unanswered message");
    return waitUntil("sent the message", () =>
      listFrames<SessionInput>(arranged.wire, "sessionInput").find(
        (frame) => frame.input.text === "an unanswered message",
      ),
    );
  };

  /** The frames sent to the runner that carry the unanswered message, oldest first. */
  const listCarrying = (arranged: Arranged): ReadonlyArray<FrameCarryingInput> =>
    arranged.wire.frames.filter(
      (frame): frame is FrameCarryingInput =>
        carriesInput(frame) && frame.input.text === "an unanswered message",
    );

  /**
   * Delivers the old session's late success, then the successor's refusal,
   * and checks that the success changed nothing and the refusal put the input
   * back to wait.
   */
  const expectOnlyTheSuccessorsAnswerCounts = async (
    arranged: Arranged,
    successorId: string,
    lateFrame: SessionInput,
  ) => {
    const [start] = await waitForStartFrames(arranged, successorId, 1);
    expect(start!.input.text).toBe("an unanswered message");
    expect(start!.requestId).not.toBe(lateFrame.requestId);
    const readInput = async () =>
      (await listInputs(arranged, successorId)).find((one) => one.text === "an unanswered message");

    arranged.wire.send({
      _tag: "sessionInputResult",
      requestId: lateFrame.requestId,
      ok: true,
      delivery: "steered",
    });
    await settle();
    // Still claimed by the successor's start, not delivered.
    const held = await readInput();
    expect(held).toMatchObject({ status: "queued", delivery: null });
    expect(held?.sentAt).not.toBeNull();

    arranged.wire.send({
      _tag: "sessionInputResult",
      requestId: start!.requestId,
      ok: false,
      message: "the harness refused the start",
    });
    const refused = await waitUntil("recorded the refusal", async () => {
      const found = await readInput();
      return found?.reason === null || found === undefined ? undefined : found;
    });
    // Waiting again, not delivered, and sent a third time.
    expect(refused.status).toBe("queued");
    expect(refused.reason).toContain("the harness refused the start");
    // A runner that refused a start reports the session's exit. The runner
    // takes the input this time.
    arranged.wire.answering(() => "opened");
    await reportStoppedExit(arranged, successorId, 1, "crash");
    const again = await waitUntil("sent the input again", () => {
      const carrying = listCarrying(arranged);
      return carrying.length > 2 ? carrying : undefined;
    });
    expect(again[2]!.requestId).not.toBe(start!.requestId);
    expect(readCarriedInputId(again[2]!)).toBe(readCarriedInputId(start!));
  };

  it("does not deliver the input the next session starts with, after a rotation", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversationId, sessionId, nextSeq } = await arrangeIdleSession(arranged);
      const late = await leaveMessageUnanswered(arranged, conversationId);
      expect((await rotate(arranged, conversationId)).status).toBe(200);
      await reportStoppedExit(arranged, sessionId, nextSeq, "crash");

      const [newest] = await waitForConversationSessions(arranged, conversationId, 2);
      await expectOnlyTheSuccessorsAnswerCounts(arranged, newest!.id, late);
    }, SHORT_DEADLINE);
  });

  it("does not deliver the input the next session starts with, after an exit that cannot be resumed", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversationId, sessionId: older, nextSeq } = await arrangeIdleSession(arranged);
      expect((await rotate(arranged, conversationId)).status).toBe(200);
      const afterFlush = await runTurn(arranged, older, nextSeq, "flush", []);
      await reportStoppedExit(arranged, older, afterFlush);
      await sendMessage(arranged, conversationId, "first");
      const [newest] = await waitForConversationSessions(arranged, conversationId, 2);
      const afterTurn = await runTurn(arranged, newest!.id, 2, "t1", ["ok"]);
      const late = await leaveMessageUnanswered(arranged, conversationId);
      // The newest session never reported a native session, so it cannot be
      // resumed: a third session takes its input over.
      await reportStoppedExit(arranged, newest!.id, afterTurn, "crash");

      const [third] = await waitForConversationSessions(arranged, conversationId, 3);
      expect(third!.id).not.toBe(newest!.id);
      await expectOnlyTheSuccessorsAnswerCounts(arranged, third!.id, late);
    }, SHORT_DEADLINE);
  });
});

describe("input left on an older session of the conversation", () => {
  it("is taken over by the delivery pass, which places a session when the newest cannot be resumed", async () => {
    await withAgentFleet(
      async (arranged) => {
        const { conversationId, sessionId: older, nextSeq } = await arrangeIdleSession(arranged);
        expect((await rotate(arranged, conversationId)).status).toBe(200);
        const afterFlush = await runTurn(arranged, older, nextSeq, "flush", []);
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
