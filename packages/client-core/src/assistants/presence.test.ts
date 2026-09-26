/**
 * Tests `decideAssistantPresence(assistantId, sessions)`, the word the
 * sidebar row and the conversation header show for an assistant. It is read
 * from the newest session of the assistant's conversations.
 */
import { describe, expect, it } from "vitest";
import type { Session } from "@hercule/contract";
import { buildSession } from "../threads/workspaces.testing";
import { decideAssistantPresence } from "./presence";

const ADA = "assistant-ada";
const BOB = "assistant-bob";

/** Builds one of Ada's conversation sessions, created at `createdAt`. */
const buildAdaSession = (id: string, createdAt: string, over: Partial<Session> = {}): Session =>
  buildSession({ id, agentId: ADA, conversationId: "c1", createdAt, ...over });

const EARLIER = "2026-09-26T10:00:00.000Z";
const LATER = "2026-09-26T11:00:00.000Z";

describe("decideAssistantPresence", () => {
  it.each<Session["status"]>(["queued", "starting", "busy"])(
    "is working while the newest session is %s",
    (status) => {
      expect(decideAssistantPresence(ADA, [buildAdaSession("s1", LATER, { status })])).toBe(
        "working",
      );
    },
  );

  it("is idle while the newest session is idle", () => {
    expect(decideAssistantPresence(ADA, [buildAdaSession("s1", LATER)])).toBe("idle");
  });

  it("is asleep when the newest session has exited and can be resumed", () => {
    const sessions = [buildAdaSession("s1", LATER, { status: "exited", resumable: true })];

    expect(decideAssistantPresence(ADA, sessions)).toBe("asleep");
  });

  it("is asleep when the assistant has no session yet", () => {
    expect(decideAssistantPresence(ADA, [])).toBe("asleep");
  });

  it("is unavailable when the newest session has exited and cannot be resumed", () => {
    const sessions = [buildAdaSession("s1", LATER, { status: "exited", resumable: false })];

    expect(decideAssistantPresence(ADA, sessions)).toBe("unavailable");
  });

  it("is unavailable when the crash-loop guard holds the newest session", () => {
    const sessions = [
      buildAdaSession("s1", LATER, { status: "exited", resumable: true, resumeHeld: true }),
    ];

    expect(decideAssistantPresence(ADA, sessions)).toBe("unavailable");
  });

  it("reads only the newest session, whatever the order of the list", () => {
    const older = buildAdaSession("s1", EARLIER, { status: "busy" });
    const newer = buildAdaSession("s2", LATER, { status: "exited", resumable: true });

    expect(decideAssistantPresence(ADA, [newer, older])).toBe("asleep");
    expect(decideAssistantPresence(ADA, [older, newer])).toBe("asleep");
  });

  it("ignores the sessions of other assistants, of Threads, and the assistant's sessions outside a conversation", () => {
    const sessions = [
      buildSession({
        id: "b1",
        agentId: BOB,
        conversationId: "c2",
        status: "busy",
        createdAt: LATER,
      }),
      buildSession({ id: "t1", status: "busy", createdAt: LATER }),
      buildSession({ id: "w1", agentId: ADA, status: "busy", createdAt: LATER }),
      buildAdaSession("s1", EARLIER),
    ];

    expect(decideAssistantPresence(ADA, sessions)).toBe("idle");
  });
});
