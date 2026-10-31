import { describe, expect, it } from "vitest";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderEvent, SubagentId } from "@hercule/protocol";
import { openPark, withdrawParksAskedBy, type Parks } from "./claude-code-parks";

const STAMPING = {
  sessionId: "session-1",
  mint: () => crypto.randomUUID(),
  now: () => "2026-10-06T10:00:00.000Z",
};

/**
 * Opens one approval park for `subagentId`, and returns the promise the
 * harness awaits. The park is marked reported, as if its `request.opened`
 * was published, unless `reported` is false.
 */
const openApprovalPark = (
  parks: Parks,
  emitted: Array<ProviderEvent>,
  requestId: string,
  subagentId: SubagentId | undefined,
  reported = true,
): Promise<PermissionResult> => {
  const { result } = openPark(parks, STAMPING, (event) => emitted.push(event), {
    request: {
      requestId,
      itemId: `item-${requestId}`,
      kind: "tool_approval",
      decisions: ["allow", "deny", "cancel"],
      detail: { toolName: "Write" },
    },
    subagentId,
    input: {},
    persists: [],
    signal: new AbortController().signal,
  });
  parks.get(requestId)!.reported = reported;
  return result;
};

describe("withdrawParksAskedBy", () => {
  it("cancels only the parks the given subagents asked, and keeps the session's own agent's", async () => {
    const parks: Parks = new Map();
    const emitted: Array<ProviderEvent> = [];
    void openApprovalPark(parks, emitted, "r-own", undefined);
    const asked = openApprovalPark(parks, emitted, "r-a", "agent-a");
    void openApprovalPark(parks, emitted, "r-b", "agent-b");

    withdrawParksAskedBy(parks, new Set(["agent-a"]));

    expect(await asked).toMatchObject({ behavior: "deny" });
    expect([...parks.keys()]).toEqual(["r-own", "r-b"]);
    expect(emitted).toMatchObject([
      { _tag: "request.resolved", requestId: "r-a", subagentId: "agent-a", decision: "cancel" },
    ]);
  });
});

describe("a park whose request was never reported", () => {
  it("denies the harness when withdrawn, and reports no end for a request nobody saw open", async () => {
    const parks: Parks = new Map();
    const emitted: Array<ProviderEvent> = [];
    const asked = openApprovalPark(parks, emitted, "r-a", "agent-a", false);

    parks.get("r-a")!.withdraw();

    expect(await asked).toMatchObject({ behavior: "deny" });
    expect(parks.size).toBe(0);
    expect(emitted).toEqual([]);
  });
});
