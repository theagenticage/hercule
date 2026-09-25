/**
 * Tests `decideConversationActivity(session)`, which picks the row the
 * conversation screen shows under its last message from the conversation's
 * current session. Its result is an object since review round 1 of slice 3
 * (D-75): the awaiting-approval row links to the session, so it carries the
 * session's id.
 */
import { describe, expect, it } from "vitest";
import type { Session } from "@hercule/contract";
import { buildSession } from "../threads/workspaces.testing";
import { decideConversationActivity } from "./activity";

const REQUEST: NonNullable<Session["openRequest"]> = {
  requestId: "req-1",
  itemId: "tool-1",
  kind: "command_approval",
  decisions: ["allow", "deny"],
  detail: { command: "ls -la" },
};

/** Builds a session of the conversation `c1`, answered by the assistant `ada`. */
const buildConversationSession = (overrides: Partial<Session>): Session =>
  buildSession({ id: "s1", agentId: "ada", conversationId: "c1", ...overrides });

describe("decideConversationActivity", () => {
  it("is quiet when the conversation has no session", () => {
    expect(decideConversationActivity(null)).toEqual({ kind: "quiet" });
  });

  it("is quiet for an exited session", () => {
    expect(decideConversationActivity(buildConversationSession({ status: "exited" }))).toEqual({
      kind: "quiet",
    });
  });

  it("is quiet for an exited session that still carries an open request", () => {
    const session = buildConversationSession({ status: "exited", openRequest: REQUEST });

    expect(decideConversationActivity(session)).toEqual({ kind: "quiet" });
  });

  it("awaits approval for a busy session with an open request", () => {
    const session = buildConversationSession({ status: "busy", openRequest: REQUEST });

    expect(decideConversationActivity(session)).toEqual({
      kind: "awaiting-approval",
      sessionId: "s1",
    });
  });

  it.each<Session["status"]>(["queued", "starting", "busy"])(
    "is working for a %s session with no open request",
    (status) => {
      expect(decideConversationActivity(buildConversationSession({ status }))).toEqual({
        kind: "working",
      });
    },
  );

  it("is quiet for an idle session", () => {
    expect(decideConversationActivity(buildConversationSession({ status: "idle" }))).toEqual({
      kind: "quiet",
    });
  });
});
