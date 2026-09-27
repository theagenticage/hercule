/**
 * Tests the replies an assistant's session writes into its conversation, from
 * what the fake runner reports on the runner socket, against a real
 * controller.
 *
 * In `turn-end` mode a turn's last assistant text becomes one message when
 * the turn ends; in `segments` mode each completed assistant message becomes
 * one. A reply is labelled with the assistant's name as it was when the reply
 * was written, and each one nudges the conversation's live topic once.
 */
import { describe, expect, it, vi } from "vitest";
import { Effect, Fiber } from "effect";
import type { Assistant } from "@hercule/contract";
import {
  collectMessages,
  expectHeld,
  fetchTicket,
  onSocket,
  send,
  waitForLiveToSettle,
  waitWithin,
} from "../http/testing";
import {
  WAIT_DEADLINE_MS,
  at,
  reportEvent,
  spawnSessionOrFail,
  waitForSession,
  waitForStartFrames,
  withAgentFleet,
  type Arranged,
} from "../sessions/testing";
import {
  listMessages,
  readDefaultConversation,
  runTurn,
  startConversationSession,
  waitForMessages,
} from "../conversations/testing";

vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 3 + 10_000 });

/** Changes the given fields of an assistant through `assistant.update`. */
const updateAssistant = async (
  arranged: Arranged,
  id: string,
  fields: Record<string, unknown>,
): Promise<Assistant> => {
  const response = await send("PATCH", arranged.harness.base, `/api/v1/assistants/${id}`, {
    body: fields,
    token: arranged.token,
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Assistant;
};

describe("the replies of an assistant in turn-end mode", () => {
  it("stores the turn's last assistant text as one reply when the turn completes", async () => {
    await withAgentFleet(async (arranged) => {
      const { assistant, conversation } = await readDefaultConversation(arranged);
      expect(assistant.reply).toBe("turn-end");
      const session = await startConversationSession(arranged, conversation.id, "hi");

      await runTurn(arranged, session.id, 2, "t1", ["a", "b"]);

      const messages = (await listMessages(arranged, conversation.id, "sort=position:asc")).items;
      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({ senderRole: "owner", actor: "user" });
      expect(messages[1]).toMatchObject({
        senderRole: "assistant",
        senderLabel: assistant.name,
        text: "b",
        sessionId: session.id,
        turnId: "t1",
        actor: `session:${session.id}`,
      });
    });
  });

  it("stores nothing for a completed turn with no assistant text", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversation } = await readDefaultConversation(arranged);
      const session = await startConversationSession(arranged, conversation.id, "hi");

      await runTurn(arranged, session.id, 2, "t1", []);

      const messages = (await listMessages(arranged, conversation.id)).items;
      expect(messages.map((one) => one.senderRole)).toEqual(["owner"]);
    });
  });

  it("keeps the name a reply was written under after the assistant is renamed", async () => {
    await withAgentFleet(async (arranged) => {
      const { assistant, conversation } = await readDefaultConversation(arranged);
      const session = await startConversationSession(arranged, conversation.id, "hi");
      const next = await runTurn(arranged, session.id, 2, "t1", ["before"]);

      await updateAssistant(arranged, assistant.id, { name: "Ada" });
      // The session is idle, so the message the next turn answers is
      // delivered at once.
      await runTurn(arranged, session.id, next, "t2", ["after"]);

      const replies = (await listMessages(arranged, conversation.id, "sort=position:asc")).items
        .filter((one) => one.senderRole === "assistant")
        .map((one) => [one.text, one.senderLabel]);
      expect(replies).toEqual([
        ["before", assistant.name],
        ["after", "Ada"],
      ]);
    });
  });
});

describe("the replies of an assistant in segments mode", () => {
  it("stores each completed assistant message as its own reply, in order, with the turn's id", async () => {
    await withAgentFleet(async (arranged) => {
      const { assistant, conversation } = await readDefaultConversation(arranged);
      await updateAssistant(arranged, assistant.id, { reply: "segments" });
      const session = await startConversationSession(arranged, conversation.id, "hi");

      await runTurn(arranged, session.id, 2, "t1", ["a", "b"]);

      const replies = (await listMessages(arranged, conversation.id, "sort=position:asc")).items
        .filter((one) => one.senderRole === "assistant")
        .map((one) => [one.text, one.turnId, one.sessionId]);
      expect(replies).toEqual([
        ["a", "t1", session.id],
        ["b", "t1", session.id],
      ]);
    });
  });
});

describe("the turns of a Thread", () => {
  it("store no conversation message", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversation } = await readDefaultConversation(arranged);
      const thread = await spawnSessionOrFail(arranged, { prompt: "hello" });
      await waitForStartFrames(arranged, thread.id, 1);
      reportEvent(arranged.wire, 1, {
        eventId: crypto.randomUUID(),
        sessionId: thread.id,
        at,
        _tag: "session.started",
        providerRefs: { nativeSessionId: "native-thread" },
      });
      await waitForSession(arranged, thread.id, (one) => one.status === "busy");

      await runTurn(arranged, thread.id, 2, "t1", ["a", "b"]);

      expect((await listMessages(arranged, conversation.id)).items).toEqual([]);
    });
  });
});

describe("the live nudge of a reply", () => {
  it("sends one conversation nudge naming the conversation for each stored reply", async () => {
    await withAgentFleet(async (arranged) => {
      const base = arranged.harness.base;
      const { assistant, conversation } = await readDefaultConversation(arranged);
      await updateAssistant(arranged, assistant.id, { reply: "segments" });
      const session = await startConversationSession(arranged, conversation.id, "hi");
      await waitForLiveToSettle();
      const ticket = await fetchTicket(base, arranged.token);

      await onSocket(base, (client) =>
        Effect.gen(function* () {
          yield* client.hello({ v: 1, ticket });
          const nudges = yield* collectMessages(client, { topic: "conversation" });
          yield* Effect.promise(() => expectHeld(arranged.harness.live, 1, "conversation"));

          // One reply per turn, with the live window between them, so each
          // reply's nudge is its own message.
          const next = yield* Effect.promise(() => runTurn(arranged, session.id, 2, "t1", ["a"]));
          yield* Effect.promise(() => waitForMessages(arranged, conversation.id, 2));
          yield* Effect.promise(() => waitForLiveToSettle());
          yield* Effect.promise(() => runTurn(arranged, session.id, next, "t2", ["b"]));
          yield* Effect.promise(() => waitForMessages(arranged, conversation.id, 3));

          expect(
            yield* Effect.promise(() => waitWithin(1000, () => nudges.received.length >= 2)),
          ).toBe(true);
          yield* Effect.promise(() => waitWithin(200, () => nudges.received.length >= 3));
          expect(nudges.received).toHaveLength(2);
          for (const nudge of nudges.received) {
            expect(nudge).toMatchObject({ _tag: "invalidate", ids: [conversation.id] });
          }

          yield* Fiber.interrupt(nudges.fiber);
        }),
      );
    });
  });
});
