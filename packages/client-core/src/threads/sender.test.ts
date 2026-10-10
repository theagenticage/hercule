/**
 * Tests `describeSender`, which decides the name, face and link a message
 * shows for the agent of another session that sent it, and the functions
 * that find and read those senders.
 */
import { describe, expect, it } from "vitest";
import type { Assistant, Session, TranscriptRow } from "@hercule/contract";
import type { HerculeClient } from "../client";
import { ApiError, ConnectionError } from "../errors";
import {
  collectSenderSessionIds,
  describeSender,
  readInputSender,
  readSenderSession,
} from "./sender";
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
      label: "Ada",
      name: "Ada",
      face: { kind: "assistant", seed: ADA.id },
      link: { kind: "assistant", assistantId: ADA.id },
    });
  });

  it("shows any other session by its title, linking to its thread", () => {
    const session = buildSession({ id: SENDER_ID, title: "Fix EU checkout" });

    expect(describeSender(SENDER_ID, session, [ADA])).toEqual({
      label: "Fix EU checkout",
      name: "Fix EU checkout",
      face: { kind: "thread", seed: SENDER_ID },
      link: { kind: "session", sessionId: SENDER_ID },
    });
  });

  it("shows an assistant's session as a thread while its assistant is not in the list", () => {
    expect(describeSender(SENDER_ID, ADA_SESSION, [])).toEqual({
      label: "Check in.",
      name: "Check in.",
      face: { kind: "thread", seed: SENDER_ID },
      link: { kind: "session", sessionId: SENDER_ID },
    });
  });

  it("names a session with an empty title by its id, so the name is never blank", () => {
    const session = buildSession({ id: SENDER_ID, title: "" });

    const sender = describeSender(SENDER_ID, session, []);
    expect([sender.label, sender.name]).toEqual(["session 7c82ebeb", "session 7c82ebeb"]);
  });

  it("shows a session that could not be read as another agent, in lower case inside a sentence, with a face from its id and no link", () => {
    expect(describeSender(SENDER_ID, null, [ADA])).toEqual({
      label: "another agent",
      name: "Another agent",
      face: { kind: "thread", seed: SENDER_ID },
      link: { kind: "none" },
    });
  });
});

describe("readSenderSession", () => {
  /** Returns a client whose `session.read` settles as `read` does. */
  const buildClient = (read: () => Promise<Session>): HerculeClient =>
    ({ session: { read } }) as unknown as HerculeClient;

  it("returns the session the controller read", async () => {
    const session = buildSession({ id: SENDER_ID });

    await expect(
      readSenderSession(
        buildClient(() => Promise.resolve(session)),
        SENDER_ID,
      ),
    ).resolves.toBe(session);
  });

  it.each(["not_found", "forbidden"] as const)(
    "returns null when the controller answers %s, because the message still shows",
    async (code) => {
      const client = buildClient(() => Promise.reject(new ApiError(code, "no such session")));

      await expect(readSenderSession(client, SENDER_ID)).resolves.toBeNull();
    },
  );

  it("fails with any other error, such as a controller that did not answer", async () => {
    const failure = new ConnectionError("http://localhost:4100", new Error("refused"));
    const client = buildClient(() => Promise.reject(failure));

    await expect(readSenderSession(client, SENDER_ID)).rejects.toBe(failure);
  });
});

const RECEIVER_ID = "01a0ec64-6e80-7000-8000-0000000000b2";

describe("readInputSender", () => {
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

describe("collectSenderSessionIds", () => {
  const OTHER_SENDER_ID = "01a0ec64-6e80-7000-8000-0000000000d4";

  /** Returns the `item.started` row of a `user_message` whose detail is `detail`. */
  const buildMessageRow = (
    itemId: string,
    detail: { readonly text: string; readonly senderSessionId?: string },
  ): TranscriptRow => ({
    position: 0,
    at: AT,
    event: {
      _tag: "item.started",
      eventId: `e-${itemId}`,
      sessionId: RECEIVER_ID,
      at: AT,
      turnId: "t1",
      itemId,
      kind: "user_message",
      detail,
    },
  });

  it("returns each sender once: the transcript's first, then the queued inputs'", () => {
    const rows = [
      buildMessageRow("u1", { text: "Fix the login bug" }),
      buildMessageRow("u2", { text: "Rebase on main", senderSessionId: SENDER_ID }),
      buildMessageRow("u3", { text: "And run the tests", senderSessionId: SENDER_ID }),
    ];
    const inputs = [
      { sessionId: RECEIVER_ID, source: "user", actor: "user" },
      { sessionId: RECEIVER_ID, source: "user", actor: `session:${OTHER_SENDER_ID}` },
      { sessionId: RECEIVER_ID, source: "user", actor: `session:${SENDER_ID}` },
    ] as const;

    expect(collectSenderSessionIds(rows, inputs)).toEqual([SENDER_ID, OTHER_SENDER_ID]);
  });

  it("finds no sender in an item that is not a message", () => {
    const rows: TranscriptRow[] = [
      {
        position: 0,
        at: AT,
        event: {
          _tag: "item.started",
          eventId: "e-tool",
          sessionId: RECEIVER_ID,
          at: AT,
          turnId: "t1",
          itemId: "tool",
          kind: "command_execution",
          detail: { senderSessionId: SENDER_ID },
        },
      },
    ];

    expect(collectSenderSessionIds(rows, [])).toEqual([]);
  });
});
