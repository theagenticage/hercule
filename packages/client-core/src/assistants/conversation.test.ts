/**
 * Tests the functions the conversation screens read their data through:
 * - `findWebConversation(items)` picks the assistant's web conversation from
 *   the result of `conversation.query`.
 * - `flattenMessagePages(pages)` turns the pages of
 *   `conversation.queryMessages`, read newest first, into one list, oldest
 *   first.
 * - `findAnsweredAssistantId(session)` names the assistant a session answered.
 * - `canSteerOrCancelQueuedInputs(session)` tells whether the session view
 *   offers Steer and Cancel on queued inputs.
 */
import { describe, expect, it } from "vitest";
import type { Conversation, ConversationMessage } from "@hercule/contract";
import { buildSession } from "../threads/workspaces.testing";
import {
  canSteerOrCancelQueuedInputs,
  findAnsweredAssistantId,
  findWebConversation,
  flattenMessagePages,
} from "./conversation";

const WEB: Conversation = {
  id: "01a06d02-c000-7000-8000-000000000001",
  assistantId: "01a06d02-a000-7000-8000-000000000001",
  channel: "web",
  containerKey: null,
  createdAt: "2026-09-25T09:00:00.000Z",
};

/** Builds the owner's message at `position` in the web conversation. */
const buildMessage = (position: number): ConversationMessage => ({
  id: `01a06d02-d000-7000-8000-00000000000${String(position)}`,
  conversationId: WEB.id,
  containerKey: null,
  position,
  senderRole: "owner",
  senderLabel: "You",
  text: `message ${String(position)}`,
  sessionId: null,
  turnId: null,
  actor: "user",
  createdAt: `2026-09-25T09:0${String(position)}:00.000Z`,
});

describe("findWebConversation", () => {
  it("returns the conversation on the web channel", () => {
    expect(findWebConversation([WEB])).toEqual(WEB);
  });

  it("returns null when there is no conversation", () => {
    expect(findWebConversation([])).toBeNull();
  });
});

describe("flattenMessagePages", () => {
  it("returns the messages of every page, oldest first", () => {
    const pages = [
      { items: [buildMessage(5), buildMessage(4), buildMessage(3)], nextCursor: "after-3" },
      { items: [buildMessage(2), buildMessage(1)] },
    ];

    expect(flattenMessagePages(pages).map((message) => message.position)).toEqual([1, 2, 3, 4, 5]);
  });

  it("returns no messages for no pages", () => {
    expect(flattenMessagePages([])).toEqual([]);
  });
});

describe("findAnsweredAssistantId", () => {
  it("returns the agent of a session in a conversation", () => {
    const session = buildSession({ id: "s1", agentId: "ada", conversationId: "c1" });

    expect(findAnsweredAssistantId(session)).toBe("ada");
  });

  it("returns null for a session that runs an agent outside a conversation", () => {
    expect(findAnsweredAssistantId(buildSession({ id: "s1", agentId: "ada" }))).toBeNull();
  });

  it("returns null for a Thread", () => {
    expect(findAnsweredAssistantId(buildSession({ id: "t1" }))).toBeNull();
  });
});

describe("canSteerOrCancelQueuedInputs", () => {
  it("returns true for a Thread", () => {
    expect(canSteerOrCancelQueuedInputs(buildSession({ id: "t1" }))).toBe(true);
  });

  it("returns true for a session that runs an agent outside a conversation", () => {
    expect(canSteerOrCancelQueuedInputs(buildSession({ id: "s1", agentId: "ada" }))).toBe(true);
  });

  it("returns false for a session in a conversation", () => {
    const session = buildSession({ id: "s1", agentId: "ada", conversationId: "c1" });

    expect(canSteerOrCancelQueuedInputs(session)).toBe(false);
  });
});
