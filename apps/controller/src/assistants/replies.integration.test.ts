/**
 * Tests the replies an assistant's session writes into its conversation, from
 * what the fake runner reports on the runner socket, against a real
 * controller.
 *
 * In `turn-end` mode a turn's last assistant text becomes one message when
 * the turn ends; in `segments` mode each completed assistant message becomes
 * one. A text the turn already stored as a reply, before a change from
 * `segments` to `turn-end`, is not stored again. A reply is labelled with the assistant's name as it was when the reply
 * was written, and each one nudges the conversation's live topic once.
 */
import { describe, expect, it, vi } from "vitest";
import { Effect, Fiber } from "effect";
import type { Assistant } from "@hercule/contract";
import {
  collectPushes,
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
import { buildTurnStoppedText } from "./notices";

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
  it("stores the turn's last assistant text as one reply, with its item id, when the turn completes", async () => {
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
        itemId: "t1-item-2",
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
  it("stores each completed assistant message as its own reply, in order, with the turn's and the item's id", async () => {
    await withAgentFleet(async (arranged) => {
      const { assistant, conversation } = await readDefaultConversation(arranged);
      await updateAssistant(arranged, assistant.id, { reply: "segments" });
      const session = await startConversationSession(arranged, conversation.id, "hi");

      await runTurn(arranged, session.id, 2, "t1", ["a", "b"]);

      const replies = (await listMessages(arranged, conversation.id, "sort=position:asc")).items
        .filter((one) => one.senderRole === "assistant")
        .map((one) => [one.text, one.turnId, one.itemId, one.sessionId]);
      expect(replies).toEqual([
        ["a", "t1", "t1-item-1", session.id],
        ["b", "t1", "t1-item-2", session.id],
      ]);
    });
  });
});

/**
 * Reports one completed assistant text of turn `turnId`, from sequence number
 * `seq`, and returns the next sequence number. Its item id is
 * `<turnId>-item-<index>`, the id `runTurn` gives a turn's text at `index`.
 */
const reportAssistantText = (
  arranged: Arranged,
  sessionId: string,
  seq: number,
  turnId: string,
  index: number,
  text: string,
): number => {
  const base = () => ({ eventId: crypto.randomUUID(), sessionId, at });
  const itemId = `${turnId}-item-${String(index)}`;
  reportEvent(arranged.wire, seq, {
    ...base(),
    _tag: "item.started",
    turnId,
    itemId,
    kind: "assistant_message",
  });
  reportEvent(arranged.wire, seq + 1, {
    ...base(),
    _tag: "content.delta",
    turnId,
    itemId,
    streamKind: "assistant_text",
    delta: text,
  });
  reportEvent(arranged.wire, seq + 2, {
    ...base(),
    _tag: "item.completed",
    turnId,
    itemId,
    kind: "assistant_message",
    status: "completed",
  });
  return seq + 3;
};

/**
 * Starts turn "t1" of the default assistant's conversation in `segments` mode,
 * reports the text "a", waits until it is stored as a reply, and then changes
 * the reply mode to `turn-end` while the turn still runs. Returns the
 * assistant, the conversation, the session and the runner's next sequence
 * number.
 */
const switchToTurnEndAfterOneSegment = async (arranged: Arranged) => {
  const { assistant, conversation } = await readDefaultConversation(arranged);
  await updateAssistant(arranged, assistant.id, { reply: "segments" });
  const session = await startConversationSession(arranged, conversation.id, "hi");
  reportEvent(arranged.wire, 2, {
    eventId: crypto.randomUUID(),
    sessionId: session.id,
    at,
    _tag: "turn.started",
    turnId: "t1",
  });
  await waitForSession(arranged, session.id, (one) => one.status === "busy");
  const next = reportAssistantText(arranged, session.id, 3, "t1", 1, "a");
  await waitForMessages(arranged, conversation.id, 2);
  await updateAssistant(arranged, assistant.id, { reply: "turn-end" });
  return { assistant, conversation, session, next };
};

/** Reports the end of turn "t1" in `state` and waits until the session is no longer busy. */
const reportTurnEnd = async (
  arranged: Arranged,
  sessionId: string,
  seq: number,
  state: "completed" | "interrupted",
): Promise<void> => {
  reportEvent(arranged.wire, seq, {
    eventId: crypto.randomUUID(),
    sessionId,
    at,
    _tag: "turn.completed",
    turnId: "t1",
    state,
  });
  await waitForSession(arranged, sessionId, (one) => one.status !== "busy");
};

/** Lists the assistant replies and notices of a conversation, oldest first, as text and item id. */
const listAnswers = async (arranged: Arranged, conversationId: string) =>
  (await listMessages(arranged, conversationId, "sort=position:asc")).items
    .filter((one) => one.senderRole !== "owner")
    .map((one) => [one.senderRole, one.text, one.itemId]);

describe("a change from segments to turn-end while a turn runs", () => {
  it("stores nothing more when the turn completes with its last text already stored", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversation, session, next } = await switchToTurnEndAfterOneSegment(arranged);

      await reportTurnEnd(arranged, session.id, next, "completed");

      expect(await listAnswers(arranged, conversation.id)).toEqual([
        ["assistant", "a", "t1-item-1"],
      ]);
    });
  });

  it("stores the turn's last text when it was written after the change", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversation, session, next } = await switchToTurnEndAfterOneSegment(arranged);

      const end = reportAssistantText(arranged, session.id, next, "t1", 2, "b");
      await reportTurnEnd(arranged, session.id, end, "completed");

      expect(await listAnswers(arranged, conversation.id)).toEqual([
        ["assistant", "a", "t1-item-1"],
        ["assistant", "b", "t1-item-2"],
      ]);
    });
  });

  it("joins only the texts not yet stored when the turn is stopped, then writes the notice", async () => {
    await withAgentFleet(async (arranged) => {
      const { assistant, conversation, session, next } =
        await switchToTurnEndAfterOneSegment(arranged);

      const second = reportAssistantText(arranged, session.id, next, "t1", 2, "b");
      const end = reportAssistantText(arranged, session.id, second, "t1", 3, "c");
      await reportTurnEnd(arranged, session.id, end, "interrupted");

      expect(await listAnswers(arranged, conversation.id)).toEqual([
        ["assistant", "a", "t1-item-1"],
        ["assistant", "b\n\nc", null],
        ["notice", buildTurnStoppedText(assistant.name), null],
      ]);
    });
  });

  it("writes only the notice when the turn is stopped with every text already stored", async () => {
    await withAgentFleet(async (arranged) => {
      const { assistant, conversation, session, next } =
        await switchToTurnEndAfterOneSegment(arranged);

      await reportTurnEnd(arranged, session.id, next, "interrupted");

      expect(await listAnswers(arranged, conversation.id)).toEqual([
        ["assistant", "a", "t1-item-1"],
        ["notice", buildTurnStoppedText(assistant.name), null],
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
          const nudges = yield* collectPushes(client, "conversation");
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
