/**
 * Tests the session operations on a session that answers an assistant's
 * conversation, over HTTP against a real controller and one fake runner.
 *
 * `conversation.send` is the only way to give such a session input, so every
 * message the owner sends is stored in the conversation. `session.input` and
 * `session.continue` are refused. The operations that only steer, answer or
 * end what the session is already doing work as they do for a Thread.
 */
import { describe, expect, it, vi } from "vitest";
import type {
  SessionInput,
  SessionInterrupt,
  SessionRespond,
  SessionStop,
} from "@hercule/protocol";
import type { Session } from "@hercule/contract";
import { post, readErrorBody, send } from "../../http/testing";
import {
  WAIT_DEADLINE_MS,
  at,
  listFrames,
  listInputs,
  listSessions,
  reportEvent,
  waitForFrames,
  waitForSession,
  waitUntil,
  withAgentFleet,
  type Arranged,
} from "../../sessions/testing";
import {
  readDefaultConversation,
  sendMessage,
  startConversationSession,
} from "../../conversations/testing";

vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 3 + 10_000 });

/** The refusal of `session.input` on a conversation's session. */
const USE_CONVERSATION_SEND =
  "this session belongs to an assistant's conversation; send the message with conversation.send";

/** The refusal of `session.continue` on a conversation's session. */
const CONVERSATION_FORK_REFUSED =
  "forking a conversation's session is not supported; " +
  "to branch off, spawn a Thread with `session.spawn` and give it the context it needs";

/** The request the busy session in these tests is parked on. */
const REQUEST_ID = "req-1";

/**
 * Starts the default assistant's conversation session and has it run a turn,
 * so it is busy. Returns the session; the runner's next sequence number is 3.
 */
const startBusySession = async (arranged: Arranged): Promise<Session> => {
  const { conversation } = await readDefaultConversation(arranged);
  const session = await startConversationSession(arranged, conversation.id, "hi");
  reportEvent(arranged.wire, 2, {
    eventId: crypto.randomUUID(),
    sessionId: session.id,
    at,
    _tag: "turn.started",
    turnId: "t1",
  });
  return await waitForSession(arranged, session.id, (one) => one.status === "busy");
};

/** Queues a message for a busy conversation session through `conversation.send`, and returns its input's id. */
const queueMessage = async (
  arranged: Arranged,
  session: Session,
  text: string,
): Promise<string> => {
  await sendMessage(arranged, session.conversationId!, text);
  const row = (await listInputs(arranged, session.id)).find((one) => one.text === text);
  expect(row, text).toBeDefined();
  return row!.id;
};

describe("session.input and session.continue on a conversation's session", () => {
  it("refuses session.input with invalid_state, and stores no input", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversation } = await readDefaultConversation(arranged);
      const session = await startConversationSession(arranged, conversation.id, "hi");

      const response = await post(
        arranged.harness.base,
        `/api/v1/sessions/${session.id}/input`,
        { text: "around the conversation" },
        arranged.token,
      );

      expect(response.status).toBe(409);
      expect(await readErrorBody(response)).toMatchObject({
        code: "invalid_state",
        message: USE_CONVERSATION_SEND,
      });
      expect((await listInputs(arranged, session.id)).map((one) => one.text)).toEqual(["hi"]);
    });
  });

  it("refuses session.continue with invalid_state, and forks nothing", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversation } = await readDefaultConversation(arranged);
      const session = await startConversationSession(arranged, conversation.id, "hi");

      const response = await post(
        arranged.harness.base,
        `/api/v1/sessions/${session.id}/continue`,
        { mode: "fork", prompt: "branch off" },
        arranged.token,
      );

      expect(response.status).toBe(409);
      expect(await readErrorBody(response)).toMatchObject({
        code: "invalid_state",
        message: CONVERSATION_FORK_REFUSED,
      });
      expect(await listSessions(arranged)).toHaveLength(1);
    });
  });
});

describe("the operations a conversation's session allows, as for a Thread", () => {
  it("interrupts the running turn", async () => {
    await withAgentFleet(async (arranged) => {
      const session = await startBusySession(arranged);

      const response = await send(
        "POST",
        arranged.harness.base,
        `/api/v1/sessions/${session.id}/interrupt`,
        { token: arranged.token },
      );

      expect(response.status, await response.clone().text()).toBe(200);
      const [frame] = await waitForFrames<SessionInterrupt>(arranged.wire, "sessionInterrupt", 1);
      expect(frame!.sessionId).toBe(session.id);
    });
  });

  it("stops the session", async () => {
    await withAgentFleet(async (arranged) => {
      const session = await startBusySession(arranged);

      const response = await send(
        "POST",
        arranged.harness.base,
        `/api/v1/sessions/${session.id}/stop`,
        { token: arranged.token },
      );

      expect(response.status, await response.clone().text()).toBe(200);
      const [frame] = await waitForFrames<SessionStop>(arranged.wire, "sessionStop", 1);
      expect(frame!.sessionId).toBe(session.id);
    });
  });

  it("answers the request the session is parked on", async () => {
    await withAgentFleet(async (arranged) => {
      const session = await startBusySession(arranged);
      reportEvent(arranged.wire, 3, {
        eventId: crypto.randomUUID(),
        sessionId: session.id,
        at,
        _tag: "request.opened",
        request: {
          requestId: REQUEST_ID,
          itemId: "i1",
          kind: "command_approval",
          decisions: ["allow", "deny"],
          detail: { command: "ls -la" },
        },
      });
      await waitForSession(arranged, session.id, (one) => one.openRequest !== null);

      const response = await post(
        arranged.harness.base,
        `/api/v1/sessions/${session.id}/respond`,
        { requestId: REQUEST_ID, decision: "allow" },
        arranged.token,
      );

      expect(response.status, await response.clone().text()).toBe(200);
      const [frame] = await waitForFrames<SessionRespond>(arranged.wire, "sessionRespond", 1);
      expect(frame).toMatchObject({
        sessionId: session.id,
        requestId: REQUEST_ID,
        decision: "allow",
      });
    });
  });

  it("cancels a queued input", async () => {
    await withAgentFleet(async (arranged) => {
      const session = await startBusySession(arranged);
      const inputId = await queueMessage(arranged, session, "never mind");

      const response = await send(
        "DELETE",
        arranged.harness.base,
        `/api/v1/sessions/${session.id}/inputs/${inputId}`,
        { token: arranged.token },
      );

      expect(response.status, await response.clone().text()).toBe(200);
      expect(
        (await listInputs(arranged, session.id)).find((one) => one.id === inputId),
      ).toMatchObject({ status: "cancelled" });
    });
  });

  it("steers a queued input into the running turn", async () => {
    await withAgentFleet(async (arranged) => {
      const session = await startBusySession(arranged);
      const inputId = await queueMessage(arranged, session, "also this");
      arranged.wire.answering(() => "steered");

      const response = await send(
        "POST",
        arranged.harness.base,
        `/api/v1/sessions/${session.id}/inputs/${inputId}/steer`,
        { token: arranged.token },
      );

      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toMatchObject({ inputId, result: "steered" });
      const frame = await waitUntil("sent the steered input", () =>
        listFrames<SessionInput>(arranged.wire, "sessionInput").find(
          (one) => one.input.text === "also this",
        ),
      );
      expect(frame.sessionId).toBe(session.id);
    });
  });
});
