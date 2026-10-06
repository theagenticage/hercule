/**
 * Tests the open Request a session record carries: the request as the harness
 * opened it, and the subagent that asked it, by id and by name.
 */
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { SessionRequest } from "./session";

const request = {
  requestId: "r-1",
  itemId: "item-1",
  kind: "command_approval",
  decisions: ["allow", "deny"],
  detail: { command: "git push" },
} as const;

const decode = Schema.decodeUnknownSync(SessionRequest);

describe("SessionRequest", () => {
  it("accepts a Request of the session's own agent, which names no subagent", () => {
    expect(decode(request)).toEqual(request);
  });

  it("carries the id and the name of the subagent that asked", () => {
    const asked = { ...request, subagentId: "agent-a1", subagentName: "Read the docs" };
    expect(decode(asked)).toEqual(asked);
  });

  it("accepts a subagent's Request whose subagent has no name yet", () => {
    const asked = { ...request, subagentId: "agent-a1" };
    expect(decode(asked)).toEqual(asked);
  });
});
