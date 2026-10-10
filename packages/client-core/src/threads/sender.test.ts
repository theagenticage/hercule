/**
 * Tests `describeSender`, which decides the name, face and link a message
 * shows for the agent of another session that sent it.
 */
import { describe, expect, it } from "vitest";
import type { Assistant } from "@hercule/contract";
import { describeSender, readInputSender } from "./sender";
import { buildSession } from "./workspaces.testing";

const AT = "2026-10-05T09:00:00.000Z";
const SENDER_ID = "01a0ec64-6e80-7000-8000-00007c82ebeb";
const CONVERSATION_ID = "01a0ec64-6e80-7000-8000-c00000000010";

const ADA: Assistant = {
  id: "01a0ec64-6e80-7000-8000-a00000000010",
  name: "Ada",
  systemPrompt: "You are Ada.",
  instanceId: "i-claude",
  permissionProfileId: "p-unrestricted",
  accessMode: "auto-accept-edits",
  model: null,
  disallowedTools: [],
  unenforced: [],
  heartbeat: { enabled: false, schedule: "0 7-23 * * *", prompt: "Check in.", target: "web" },
  rotation: { contextFraction: 0.7, maxContextTokens: 200000, dailyAt: "04:00" },
  reply: "turn-end",
  mainConversationId: CONVERSATION_ID,
  createdAt: AT,
  updatedAt: AT,
};

/** A session of Ada's conversation: an assistant's session names the assistant as its Agent. */
const ADA_SESSION = buildSession({
  id: SENDER_ID,
  title: "Check in.",
  agentId: ADA.id,
  conversationId: CONVERSATION_ID,
});

describe("describeSender", () => {
  it("shows a session of an assistant's conversation as the assistant, linking to its page", () => {
    expect(describeSender(SENDER_ID, ADA_SESSION, [ADA])).toEqual({
      name: "Ada",
      faceKind: "assistant",
      faceSeed: ADA.id,
      link: { kind: "assistant", assistantId: ADA.id },
    });
  });

  it("shows any other session by its title, linking to its thread", () => {
    const session = buildSession({ id: SENDER_ID, title: "Fix EU checkout" });

    expect(describeSender(SENDER_ID, session, [ADA])).toEqual({
      name: "Fix EU checkout",
      faceKind: "thread",
      faceSeed: SENDER_ID,
      link: { kind: "thread", sessionId: SENDER_ID },
    });
  });

  it("shows an assistant's session as a thread while its assistant is not in the list", () => {
    expect(describeSender(SENDER_ID, ADA_SESSION, [])).toEqual({
      name: "Check in.",
      faceKind: "thread",
      faceSeed: SENDER_ID,
      link: { kind: "thread", sessionId: SENDER_ID },
    });
  });

  it("names a session with an empty title by its id, so the name is never blank", () => {
    const session = buildSession({ id: SENDER_ID, title: "" });

    expect(describeSender(SENDER_ID, session, []).name).toBe("session 7c82ebeb");
  });

  it("shows a session that could not be read as another agent, with a face from its id and no link", () => {
    expect(describeSender(SENDER_ID, undefined, [ADA])).toEqual({
      name: "Another agent",
      faceKind: "thread",
      faceSeed: SENDER_ID,
      link: { kind: "none" },
    });
  });
});

describe("readInputSender", () => {
  const RECEIVER_ID = "01a0ec64-6e80-7000-8000-0000000000b2";

  it("returns the session that queued a message to another session", () => {
    expect(
      readInputSender({ sessionId: RECEIVER_ID, source: "user", actor: `session:${SENDER_ID}` }),
    ).toBe(SENDER_ID);
  });

  it.each([
    { case: "the owner", source: "user", actor: "user" },
    { case: "a run", source: "user", actor: "run:01a0ec64-6e80-7000-8000-0000000000c3" },
    { case: "the session itself", source: "user", actor: `session:${RECEIVER_ID}` },
    { case: "a subscription delivery", source: "subscription", actor: `session:${SENDER_ID}` },
  ] as const)("returns undefined for an input queued by $case", ({ source, actor }) => {
    expect(readInputSender({ sessionId: RECEIVER_ID, source, actor })).toBeUndefined();
  });
});
