/**
 * Tests `decideAssistantPresence(assistantId, sessions)`, the word the
 * sidebar row and the conversation header show for an assistant: "live" while one of
 * its sessions is running or waiting for input, "idle" otherwise.
 */
import { describe, expect, it } from "vitest";
import type { Session } from "@hercule/contract";
import { buildSession } from "../threads/workspaces.testing";
import { decideAssistantPresence } from "./presence";

const ADA = "assistant-ada";
const BOB = "assistant-bob";

describe("decideAssistantPresence", () => {
  it.each<Session["status"]>(["queued", "starting", "idle", "busy"])(
    "is live while one of the assistant's sessions is %s",
    (status) => {
      const sessions = [buildSession({ id: "s1", agentId: ADA, conversationId: "c1", status })];

      expect(decideAssistantPresence(ADA, sessions)).toBe("live");
    },
  );

  it("is idle when the assistant has no session", () => {
    expect(decideAssistantPresence(ADA, [])).toBe("idle");
  });

  it("is idle when every one of the assistant's sessions has exited", () => {
    const sessions = [
      buildSession({ id: "s1", agentId: ADA, conversationId: "c1", status: "exited" }),
      buildSession({ id: "s2", agentId: ADA, conversationId: "c1", status: "exited" }),
    ];

    expect(decideAssistantPresence(ADA, sessions)).toBe("idle");
  });

  it("is live when one session has exited and a newer one is idle", () => {
    const sessions = [
      buildSession({ id: "s1", agentId: ADA, conversationId: "c1", status: "exited" }),
      buildSession({ id: "s2", agentId: ADA, conversationId: "c1", status: "idle" }),
    ];

    expect(decideAssistantPresence(ADA, sessions)).toBe("live");
  });

  it("ignores the running sessions of other assistants and of Threads", () => {
    const sessions = [
      buildSession({ id: "s1", agentId: BOB, conversationId: "c2", status: "busy" }),
      buildSession({ id: "t1", status: "busy" }),
    ];

    expect(decideAssistantPresence(ADA, sessions)).toBe("idle");
  });
});
