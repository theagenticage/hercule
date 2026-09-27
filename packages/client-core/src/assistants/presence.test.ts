/**
 * Tests the word the sidebar row and the conversation header show for an
 * assistant:
 *
 * - `findNewestConversationSession(assistantId, sessions)` finds the session
 *   it is read from;
 * - `decideAssistantPresence(session)` reads it.
 */
import { describe, expect, it } from "vitest";
import type { Session } from "@hercule/contract";
import { buildSession } from "../threads/workspaces.testing";
import { decideAssistantPresence, findNewestConversationSession } from "./presence";

const ADA = "assistant-ada";
const BOB = "assistant-bob";

/** Builds one of Ada's conversation sessions, created at `createdAt`. */
const buildAdaSession = (id: string, createdAt: string, over: Partial<Session> = {}): Session =>
  buildSession({ id, agentId: ADA, conversationId: "c1", createdAt, ...over });

const EARLIER = "2026-09-26T10:00:00.000Z";
const LATER = "2026-09-26T11:00:00.000Z";

describe("findNewestConversationSession", () => {
  it("finds the newest session, whatever the order of the list", () => {
    const older = buildAdaSession("s1", EARLIER);
    const newer = buildAdaSession("s2", LATER);

    expect(findNewestConversationSession(ADA, [newer, older])).toBe(newer);
    expect(findNewestConversationSession(ADA, [older, newer])).toBe(newer);
  });

  it("finds nothing when the assistant has no session yet", () => {
    expect(findNewestConversationSession(ADA, [])).toBeNull();
  });

  it("ignores the sessions of other assistants, of Threads, and the assistant's sessions outside a conversation", () => {
    const ada = buildAdaSession("s1", EARLIER);
    const sessions = [
      buildSession({ id: "b1", agentId: BOB, conversationId: "c2", createdAt: LATER }),
      buildSession({ id: "t1", createdAt: LATER }),
      buildSession({ id: "w1", agentId: ADA, createdAt: LATER }),
      ada,
    ];

    expect(findNewestConversationSession(ADA, sessions)).toBe(ada);
  });
});

describe("decideAssistantPresence", () => {
  it.each<Session["status"]>(["queued", "starting", "busy"])(
    "is working while the session is %s",
    (status) => {
      expect(decideAssistantPresence(buildAdaSession("s1", LATER, { status }))).toBe("working");
    },
  );

  it("is idle while the session is idle", () => {
    expect(decideAssistantPresence(buildAdaSession("s1", LATER))).toBe("idle");
  });

  it("is asleep when the session has exited and can be resumed", () => {
    const session = buildAdaSession("s1", LATER, { status: "exited", resumable: true });

    expect(decideAssistantPresence(session)).toBe("asleep");
  });

  it("has no presence when the assistant has no session yet", () => {
    expect(decideAssistantPresence(null)).toBeNull();
  });

  it("is unavailable when the session has exited and cannot be resumed", () => {
    const session = buildAdaSession("s1", LATER, { status: "exited", resumable: false });

    expect(decideAssistantPresence(session)).toBe("unavailable");
  });

  it("is unavailable when the crash-loop guard holds the session", () => {
    const session = buildAdaSession("s1", LATER, {
      status: "exited",
      resumable: true,
      resumeHeld: true,
    });

    expect(decideAssistantPresence(session)).toBe("unavailable");
  });
});
